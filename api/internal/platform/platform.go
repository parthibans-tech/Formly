// Package platform contains developer-experience primitives shared across
// the API: scope enforcement for API-key-authenticated traffic, a
// per-API-key request logger, rate-limit response headers, and a
// consistent error-envelope helper. Kept separate from `security` so
// security owns defensive hardening while platform owns the public API
// contract.
package platform

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/docforge/api/internal/apikeys"
	"github.com/docforge/api/internal/auth"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ---------------------------------------------------------------------
// Rate-limit headers
// ---------------------------------------------------------------------

// RateLimitHeaders is a tiny in-memory sliding counter that emits
// X-RateLimit-{Limit,Remaining,Reset} response headers. Separate from the
// DB-backed `security.RateLimit` middleware — this one is advisory-only
// (doesn't block; just tells clients what they have left) and cheap to run
// on every authenticated request.
type rateEntry struct {
	windowStart time.Time
	count       int
}

type rlStore struct {
	mu      sync.Mutex
	window  time.Duration
	limit   int
	buckets map[string]*rateEntry
}

// RateLimitHeaders returns a middleware that applies a token bucket per
// {API-key-or-user, path-prefix} and writes the standard `X-RateLimit-*`
// headers on the response. Non-blocking — the actual enforcement is still
// the DB-backed limiter on the auth endpoints.
func RateLimitHeaders(limit int, window time.Duration) func(http.Handler) http.Handler {
	s := &rlStore{
		window:  window,
		limit:   limit,
		buckets: map[string]*rateEntry{},
	}
	// Opportunistic pruning so the map doesn't grow forever. Runs every
	// window and drops buckets older than 2×window.
	go func() {
		t := time.NewTicker(window)
		defer t.Stop()
		for range t.C {
			cutoff := time.Now().Add(-2 * window)
			s.mu.Lock()
			for k, v := range s.buckets {
				if v.windowStart.Before(cutoff) {
					delete(s.buckets, k)
				}
			}
			s.mu.Unlock()
		}
	}()
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := s.bucketKey(r)
			remaining, resetSec := s.touch(key)
			w.Header().Set("X-RateLimit-Limit", strconv.Itoa(s.limit))
			w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
			w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(resetSec, 10))
			next.ServeHTTP(w, r)
		})
	}
}

func (s *rlStore) bucketKey(r *http.Request) string {
	if info := auth.APIKeyFrom(r.Context()); info != nil {
		return "k:" + info.ID
	}
	if c, ok := r.Context().Value(auth.UserCtxKey).(*auth.Claims); ok && c != nil {
		return "u:" + c.UserID
	}
	return "ip:" + r.RemoteAddr
}

func (s *rlStore) touch(key string) (remaining int, resetUnix int64) {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.buckets[key]
	if !ok || now.Sub(b.windowStart) >= s.window {
		b = &rateEntry{windowStart: now, count: 0}
		s.buckets[key] = b
	}
	b.count++
	remaining = s.limit - b.count
	if remaining < 0 {
		remaining = 0
	}
	resetUnix = b.windowStart.Add(s.window).Unix()
	return
}

// ---------------------------------------------------------------------
// Scope enforcement
// ---------------------------------------------------------------------

// scopeRequirement describes what a method+path prefix requires of an API
// key. Paths are matched by longest-prefix wins. JWT-authenticated requests
// (cookie / browser session / logged-in user) are always allowed — scopes
// only gate API-key callers.
type scopeRequirement struct {
	prefix string
	method string // "" = any
	scope  string
}

var scopeRules = []scopeRequirement{
	// Files
	{prefix: "/v1/files", method: "GET", scope: "files:read"},
	{prefix: "/v1/files", method: "POST", scope: "files:write"},
	{prefix: "/v1/files", method: "PATCH", scope: "files:write"},
	{prefix: "/v1/files", method: "DELETE", scope: "files:write"},
	// Folders piggy-back on files:*
	{prefix: "/v1/folders", method: "GET", scope: "files:read"},
	{prefix: "/v1/folders", method: "", scope: "files:write"},
	// Templates
	{prefix: "/v1/templates", method: "GET", scope: "templates:read"},
	{prefix: "/v1/templates", method: "", scope: "templates:write"},
	// Generation
	{prefix: "/v1/templates", method: "POST", scope: "generate:write"},
	// Shares
	{prefix: "/v1/shares", method: "", scope: "shares:write"},
	// Webhooks
	{prefix: "/v1/webhooks", method: "GET", scope: "webhooks:read"},
	{prefix: "/v1/webhooks", method: "", scope: "webhooks:write"},
	// Audit / Ops
	{prefix: "/v1/audit", method: "GET", scope: "audit:read"},
	{prefix: "/v1/ops", method: "GET", scope: "ops:read"},
}

// ScopeGuard is the middleware that rejects API-key requests whose key
// doesn't carry the scope the route requires. JWT-authenticated requests
// (the first-party web app) are passed through unchanged.
func ScopeGuard() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			info := auth.APIKeyFrom(r.Context())
			if info == nil {
				// Not an API-key request → skip.
				next.ServeHTTP(w, r)
				return
			}
			need := scopeFor(r.Method, r.URL.Path)
			if need == "" {
				// No explicit rule → default to wildcard (any key works).
				next.ServeHTTP(w, r)
				return
			}
			if !apikeys.HasScope(info.Scopes, need) {
				WriteError(w, http.StatusForbidden, "insufficient_scope",
					"this API key is missing the required scope: "+need)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func scopeFor(method, path string) string {
	best := ""
	bestLen := -1
	for _, rule := range scopeRules {
		if rule.method != "" && rule.method != method {
			continue
		}
		if !strings.HasPrefix(path, rule.prefix) {
			continue
		}
		if len(rule.prefix) > bestLen {
			bestLen = len(rule.prefix)
			best = rule.scope
		}
	}
	return best
}

// ---------------------------------------------------------------------
// Per-API-key request log
// ---------------------------------------------------------------------

// RequestLogger records one api_request_log row per API-key-authenticated
// request. Fires asynchronously so the hot path stays fast.
func RequestLogger(db *pgxpool.Pool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			info := auth.APIKeyFrom(r.Context())
			if info == nil {
				next.ServeHTTP(w, r)
				return
			}
			start := time.Now()
			sr := &statusRecorder{ResponseWriter: w, status: 200}
			next.ServeHTTP(sr, r)

			p := routePattern(r)
			if p == "" {
				p = r.URL.Path
			}
			c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
			orgID := ""
			if c != nil {
				orgID = c.OrgID
			}
			ip := clientIP(r)
			ua := r.UserAgent()
			reqID := r.Header.Get("X-Request-Id")
			dur := int(time.Since(start).Milliseconds())
			// Fire-and-forget; never block the response.
			go apikeys.LogRequest(context.Background(), db,
				info.ID, orgID, r.Method, p, sr.status, dur, ip, ua, reqID)
		})
	}
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func routePattern(r *http.Request) string {
	if ctx := chi.RouteContext(r.Context()); ctx != nil {
		if p := ctx.RoutePattern(); p != "" {
			p = strings.TrimSuffix(p, "/*")
			if len(p) > 1 {
				p = strings.TrimSuffix(p, "/")
			}
			return path.Clean(p)
		}
	}
	return ""
}

func clientIP(r *http.Request) string {
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		if i := strings.IndexByte(v, ','); i > 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	if v := r.Header.Get("X-Real-IP"); v != "" {
		return v
	}
	return r.RemoteAddr
}

// ---------------------------------------------------------------------
// Consistent error envelope
// ---------------------------------------------------------------------

// WriteError is the canonical error-response helper for the public API. It
// emits the same envelope every handler already uses locally, plus a
// request-id hint when one is set on the response writer's upstream header
// or via chi's RequestID middleware.
func WriteError(w http.ResponseWriter, code int, slug, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"code":    slug,
			"message": msg,
			"docsUrl": "https://formly.dev/docs/errors#" + slug,
		},
	})
}

// BufferBody is a small helper for endpoints that want to echo the request
// body in their error response (useful for /openapi.json / try-it-out).
// Limits the buffered size to keep memory bounded.
func BufferBody(r *http.Request, max int64) ([]byte, error) {
	if r.Body == nil {
		return nil, nil
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, max))
	if err != nil {
		return nil, err
	}
	// Replace the body so downstream handlers can still read it.
	r.Body = io.NopCloser(bytes.NewReader(b))
	return b, nil
}
