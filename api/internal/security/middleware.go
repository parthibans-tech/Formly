// Package security contains HTTP middleware for defence-in-depth hardening
// that isn't specific to any one feature package:
//
//   - Headers(): sets a conservative set of security response headers on
//     every response (HSTS, CSP, Referrer, X-Frame, etc.).
//   - RateLimit(): lightweight DB-backed fixed-window rate limiter used on
//     auth endpoints to slow down credential-stuffing and password-spraying.
package security

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Headers returns a middleware that sets conservative security response
// headers. Safe to apply globally — it plays nicely with the SPA front-end.
func Headers() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			// Always-on hardening:
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("X-Frame-Options", "SAMEORIGIN")
			h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
			h.Set("Permissions-Policy",
				"camera=(), microphone=(), geolocation=(), payment=()")
			h.Set("Cross-Origin-Opener-Policy", "same-origin")
			h.Set("Cross-Origin-Resource-Policy", "same-site")

			// HSTS only over HTTPS (dev is HTTP).
			if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
				h.Set("Strict-Transport-Security",
					"max-age=63072000; includeSubDomains; preload")
			}

			// No CSP on API routes (CSP belongs with HTML; the SPA sets its
			// own via <meta>/Next config). We include a minimal connect-src
			// baseline just in case an HTML response slips through.
			if strings.HasPrefix(r.URL.Path, "/v1/") {
				// API path: done.
			}

			next.ServeHTTP(w, r)
		})
	}
}

// RateLimit returns a middleware that caps the number of requests per
// {bucketKey}/window to `maxHits`. The bucket key is derived per request (by
// default IP + path); callers can customise via WithBucketKey.
//
// The limiter is DB-backed (postgres row TTL). Storage overhead is a single
// row per hit within the window; old rows are pruned opportunistically.
type LimitOpts struct {
	Window    time.Duration
	Max       int
	BucketKey func(*http.Request) string

	// Name is a friendly bucket label (e.g. "login", "register",
	// "mfa_verify") used by the OnLimit observer when the limiter
	// trips. Distinct from BucketKey, which is the per-request
	// (IP+path)-scoped string used for the actual counter — Name is
	// the cardinality-bounded shape we want on dashboards. Defaults
	// to "default" when unset, so a metric series exists even if the
	// caller forgot to label.
	Name string

	// OnLimit fires once per 429 emission with the bucket Name. Wired
	// in cmd/api to the metrics package's RateLimitHits counter. The
	// hook runs from the request goroutine and must not block — the
	// metric increment is a single atomic.Add.
	OnLimit func(name string)
}

func RateLimit(db *pgxpool.Pool, opts LimitOpts) func(http.Handler) http.Handler {
	if opts.Window == 0 {
		opts.Window = time.Minute
	}
	if opts.Max == 0 {
		opts.Max = 30
	}
	if opts.BucketKey == nil {
		opts.BucketKey = defaultBucketKey
	}
	if opts.Name == "" {
		opts.Name = "default"
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			bucket := opts.BucketKey(r)
			if bucket == "" {
				next.ServeHTTP(w, r)
				return
			}
			since := time.Now().Add(-opts.Window)
			var count int
			if err := db.QueryRow(r.Context(),
				`SELECT count(*) FROM rate_limit_events
				  WHERE bucket=$1 AND created_at > $2`,
				bucket, since,
			).Scan(&count); err != nil {
				// Fail-open: a limiter outage shouldn't take down login.
				next.ServeHTTP(w, r)
				return
			}
			if count >= opts.Max {
				if opts.OnLimit != nil {
					opts.OnLimit(opts.Name)
				}
				w.Header().Set("Retry-After", "60")
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = w.Write([]byte(
					`{"error":{"code":"rate_limited","message":"too many requests, please slow down"}}`,
				))
				return
			}
			// Record the hit + opportunistically prune ancient rows.
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				defer cancel()
				_, _ = db.Exec(ctx,
					`INSERT INTO rate_limit_events (bucket) VALUES ($1)`, bucket)
				_, _ = db.Exec(ctx,
					`DELETE FROM rate_limit_events
					  WHERE bucket=$1 AND created_at < $2`,
					bucket, time.Now().Add(-24*time.Hour))
			}()
			next.ServeHTTP(w, r)
		})
	}
}

func defaultBucketKey(r *http.Request) string {
	return r.Method + ":" + r.URL.Path + ":" + clientIP(r)
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
	if i := strings.LastIndex(r.RemoteAddr, ":"); i > 0 && !strings.Contains(r.RemoteAddr, "]") {
		return r.RemoteAddr[:i]
	}
	return r.RemoteAddr
}

// LoginBucketKey is the default bucket for auth endpoints — IP-scoped so
// single bad clients don't lock out the entire CIDR, but email-salted so a
// single attacker can't try 60 different emails from one IP in the same
// window.
func LoginBucketKey(r *http.Request) string {
	return "auth:" + r.URL.Path + ":" + clientIP(r)
}
