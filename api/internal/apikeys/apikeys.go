// Package apikeys implements per-organization API keys for programmatic
// access to the v1 REST API. A key's full value is shown to the user ONCE at
// creation; only a SHA-256 hash + short prefix is persisted.
package apikeys

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/billing"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	DB *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Handler {
	return &Handler{DB: db}
}

// KeyPrefix is the stable label used to detect API keys vs JWTs in the auth
// middleware. Everything after the prefix is random.
const KeyPrefix = "fk_"

// prefixLen is how many chars of the full key we store for indexed lookup.
// Must be long enough to be unique across the table — 16 chars (≈ 96 bits of
// base64 entropy) is comfortable.
const prefixLen = 16

// Generate returns a (fullKey, prefix, hash) triple. The caller shows the
// fullKey to the user once, stores the prefix + hash in the DB, and discards
// the fullKey from memory.
func Generate() (fullKey, prefix string, hash []byte, err error) {
	var b [24]byte
	if _, err = rand.Read(b[:]); err != nil {
		return
	}
	fullKey = KeyPrefix + base64.RawURLEncoding.EncodeToString(b[:])
	if len(fullKey) < prefixLen {
		prefix = fullKey
	} else {
		prefix = fullKey[:prefixLen]
	}
	h := sha256.Sum256([]byte(fullKey))
	hash = h[:]
	return
}

// -- HTTP handlers ---------------------------------------------------------

type keyDTO struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Prefix     string   `json:"prefix"`
	Scopes     []string `json:"scopes"`
	CreatedAt  string   `json:"createdAt"`
	LastUsedAt *string  `json:"lastUsedAt,omitempty"`
	ExpiresAt  *string  `json:"expiresAt,omitempty"`
	Revoked    bool     `json:"revoked"`
}

// AllScopes enumerates the canonical scope list the UI offers at create-time.
// The special scope "*" grants full access (equivalent to the legacy
// unrestricted key).
var AllScopes = []string{
	"*",
	"files:read", "files:write",
	"templates:read", "templates:write",
	"generate:write",
	"shares:read", "shares:write",
	"webhooks:read", "webhooks:write",
	"audit:read",
	"ops:read",
}

// normaliseScopes strips unknown scopes and collapses empty → "*" for
// backward compatibility with keys created before scopes existed.
func normaliseScopes(raw []string) []string {
	if len(raw) == 0 {
		return []string{"*"}
	}
	allowed := map[string]bool{}
	for _, s := range AllScopes {
		allowed[s] = true
	}
	out := []string{}
	seen := map[string]bool{}
	for _, s := range raw {
		s = strings.TrimSpace(s)
		if !allowed[s] || seen[s] {
			continue
		}
		out = append(out, s)
		seen[s] = true
	}
	if len(out) == 0 {
		return []string{"*"}
	}
	return out
}

// HasScope reports whether the given scope list grants the requested
// "resource:action". Wildcards: "*" is full access; "resource:*" grants any
// action on that resource.
func HasScope(scopes []string, need string) bool {
	if len(scopes) == 0 {
		// Unscoped legacy key → treat as full access.
		return true
	}
	parts := strings.SplitN(need, ":", 2)
	resource := parts[0]
	for _, s := range scopes {
		if s == "*" {
			return true
		}
		if s == need {
			return true
		}
		if s == resource+":*" {
			return true
		}
	}
	return false
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, name, prefix, scopes, created_at, last_used_at, expires_at, revoked_at
		  FROM api_keys
		 WHERE org_id=$1
		 ORDER BY created_at DESC`, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []keyDTO{}
	for rows.Next() {
		var (
			id, name, prefix string
			scopes           []string
			createdAt        time.Time
			lastUsed         *time.Time
			expiresAt        *time.Time
			revokedAt        *time.Time
		)
		if err := rows.Scan(&id, &name, &prefix, &scopes, &createdAt, &lastUsed, &expiresAt, &revokedAt); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		dto := keyDTO{
			ID:        id,
			Name:      name,
			Prefix:    prefix,
			Scopes:    scopes,
			CreatedAt: createdAt.Format(time.RFC3339),
			Revoked:   revokedAt != nil,
		}
		if lastUsed != nil {
			s := lastUsed.Format(time.RFC3339)
			dto.LastUsedAt = &s
		}
		if expiresAt != nil {
			s := expiresAt.Format(time.RFC3339)
			dto.ExpiresAt = &s
		}
		out = append(out, dto)
	}
	writeJSON(w, 200, map[string]any{"keys": out})
}

type createReq struct {
	Name      string   `json:"name"`
	ExpiresIn int      `json:"expiresInDays,omitempty"` // 0 = never
	Scopes    []string `json:"scopes,omitempty"`
}

type createResp struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Prefix    string   `json:"prefix"`
	Scopes    []string `json:"scopes"`
	Key       string   `json:"key"` // full key — shown exactly once
	CreatedAt string   `json:"createdAt"`
	ExpiresAt string   `json:"expiresAt,omitempty"`
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if err := billing.RequireFeature(r.Context(), h.DB, c.OrgID, "api_keys"); err != nil {
		if le, ok := billing.IsLimitError(err); ok {
			writeErr(w, le.Status, le.Code, le.Message)
			return
		}
	}
	var req createReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "Untitled key"
	}
	fullKey, prefix, hash, err := Generate()
	if err != nil {
		writeErr(w, 500, "rand", err.Error())
		return
	}
	var expiresAt *time.Time
	if req.ExpiresIn > 0 {
		t := time.Now().AddDate(0, 0, req.ExpiresIn)
		expiresAt = &t
	}

	scopes := normaliseScopes(req.Scopes)

	var id string
	var createdAt time.Time
	err = h.DB.QueryRow(r.Context(), `
		INSERT INTO api_keys (org_id, user_id, name, prefix, hash, scopes, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		RETURNING id, created_at
	`, c.OrgID, c.UserID, name, prefix, hash, scopes, expiresAt).Scan(&id, &createdAt)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	resp := createResp{
		ID:        id,
		Name:      name,
		Prefix:    prefix,
		Scopes:    scopes,
		Key:       fullKey,
		CreatedAt: createdAt.Format(time.RFC3339),
	}
	if expiresAt != nil {
		resp.ExpiresAt = expiresAt.Format(time.RFC3339)
	}
	writeJSON(w, 200, resp)
}

func (h *Handler) Revoke(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	tag, err := h.DB.Exec(r.Context(), `
		UPDATE api_keys SET revoked_at=now()
		 WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL`, id, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "key not found or already revoked")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// -- shared helpers --------------------------------------------------------

func prefixOf(k string) string {
	if len(k) < prefixLen {
		return k
	}
	return k[:prefixLen]
}

// VerifyAndLoad is the legacy v1 verifier — kept for backward compatibility.
// New code should use VerifyAndLoadV2 so the caller can enforce scopes and
// attach the key ID to the request context.
func VerifyAndLoad(db *pgxpool.Pool, r *http.Request, raw string) (userID, orgID, email, role string, err error) {
	uid, oid, e, rle, _, _, err := VerifyAndLoadV2(db, r, raw)
	return uid, oid, e, rle, err
}

// VerifyAndLoadV2 returns the full context of an API-key-authenticated
// request: identity, the key's stable ID (for per-key activity logging),
// and its scope list (for scope enforcement).
func VerifyAndLoadV2(db *pgxpool.Pool, r *http.Request, raw string) (userID, orgID, email, role, keyID string, scopes []string, err error) {
	pfx := prefixOf(raw)
	var (
		storedHash               []byte
		uid, oid, userEmail, rle string
		revokedAt, expiresAt     *time.Time
	)
	err = db.QueryRow(r.Context(), `
		SELECT k.id, k.hash, k.user_id, k.org_id, u.email, COALESCE(u.role,'editor'),
		       k.scopes, k.revoked_at, k.expires_at
		  FROM api_keys k JOIN users u ON u.id = k.user_id
		 WHERE k.prefix=$1`, pfx,
	).Scan(&keyID, &storedHash, &uid, &oid, &userEmail, &rle, &scopes, &revokedAt, &expiresAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return "", "", "", "", "", nil, ErrInvalidKey
		}
		return "", "", "", "", "", nil, err
	}
	if revokedAt != nil {
		return "", "", "", "", "", nil, ErrRevokedKey
	}
	if expiresAt != nil && expiresAt.Before(time.Now()) {
		return "", "", "", "", "", nil, ErrExpiredKey
	}
	h := sha256.Sum256([]byte(raw))
	if subtle.ConstantTimeCompare(h[:], storedHash) != 1 {
		return "", "", "", "", "", nil, ErrInvalidKey
	}
	// Best-effort "last used" update. Fire-and-forget so we don't block requests.
	go func() {
		_, _ = db.Exec(r.Context(), `UPDATE api_keys SET last_used_at=now() WHERE id=$1`, keyID)
	}()
	return uid, oid, userEmail, rle, keyID, scopes, nil
}

// -- Activity -------------------------------------------------------------

// Activity lists recent API request log entries for a single key. Scoped to
// the caller's org so a stolen JWT in another workspace can't enumerate.
func (h *Handler) Activity(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")

	// Ownership check.
	var owner string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT org_id FROM api_keys WHERE id=$1`, id).Scan(&owner); err != nil {
		writeErr(w, 404, "not_found", "api key not found")
		return
	}
	if owner != c.OrgID {
		writeErr(w, 404, "not_found", "api key not found")
		return
	}

	rows, err := h.DB.Query(r.Context(), `
		SELECT method, path, status, duration_ms,
		       COALESCE(host(ip_addr),''), COALESCE(user_agent,''),
		       COALESCE(request_id,''), created_at
		  FROM api_request_log
		 WHERE api_key_id=$1
		 ORDER BY created_at DESC
		 LIMIT 200`, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	type row struct {
		Method     string `json:"method"`
		Path       string `json:"path"`
		Status     int    `json:"status"`
		DurationMs int    `json:"durationMs"`
		IP         string `json:"ip,omitempty"`
		UserAgent  string `json:"userAgent,omitempty"`
		RequestID  string `json:"requestId,omitempty"`
		CreatedAt  string `json:"createdAt"`
	}
	out := []row{}
	for rows.Next() {
		var it row
		var created time.Time
		if err := rows.Scan(&it.Method, &it.Path, &it.Status, &it.DurationMs,
			&it.IP, &it.UserAgent, &it.RequestID, &created); err == nil {
			it.CreatedAt = created.Format(time.RFC3339)
			out = append(out, it)
		}
	}

	// Per-status counts for the last 24 h, so the UI can show a small
	// summary strip at the top.
	counts := map[string]int{}
	crows, _ := h.DB.Query(r.Context(), `
		SELECT CASE WHEN status >= 500 THEN '5xx'
		            WHEN status >= 400 THEN '4xx'
		            WHEN status >= 300 THEN '3xx'
		            ELSE '2xx' END AS bucket,
		       COUNT(*)
		  FROM api_request_log
		 WHERE api_key_id=$1 AND created_at > now() - interval '24 hours'
		 GROUP BY bucket`, id)
	if crows != nil {
		for crows.Next() {
			var b string
			var n int
			if crows.Scan(&b, &n) == nil {
				counts[b] = n
			}
		}
		crows.Close()
	}

	writeJSON(w, 200, map[string]any{
		"requests": out,
		"counts":   counts,
	})
}

// LogRequest inserts a single api_request_log row. Called by the
// observability middleware when a request was API-key-authenticated.
func LogRequest(ctx context.Context, db *pgxpool.Pool, keyID, orgID, method, path string,
	status, durMs int, ip, ua, requestID string) {
	if keyID == "" {
		return
	}
	if i := strings.LastIndex(ip, ":"); i > 0 && !strings.Contains(ip, "]") {
		ip = ip[:i]
	}
	_, _ = db.Exec(ctx, `
		INSERT INTO api_request_log
		  (api_key_id, org_id, method, path, status, duration_ms,
		   ip_addr, user_agent, request_id)
		VALUES ($1,$2,$3,$4,$5,$6, NULLIF($7,'')::inet, NULLIF($8,''), NULLIF($9,''))
	`, keyID, orgID, method, path, status, durMs, ip, ua, requestID)
}

// Debug helper used by tests.
func HashHex(b []byte) string { return hex.EncodeToString(b) }

// -- errors ---------------------------------------------------------------

type apikeyError string

func (e apikeyError) Error() string { return string(e) }

const (
	ErrInvalidKey apikeyError = "invalid api key"
	ErrRevokedKey apikeyError = "api key revoked"
	ErrExpiredKey apikeyError = "api key expired"
)

// -- tiny helpers ---------------------------------------------------------

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
