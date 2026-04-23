// Package sessions tracks live JWT sessions so users can list their active
// devices and revoke any session early (before the JWT expires).
//
// How it works:
//  1. On successful login the auth handler calls Record() with the issued JWT.
//     We store SHA-256(token) in user_sessions along with IP + UA.
//  2. The auth middleware calls IsRevoked() on every request — if the hash
//     is in `user_sessions` with `revoked_at IS NOT NULL`, we reject.
//  3. Users can list their sessions and revoke any single one (or all but
//     current) from /settings/security.
package sessions

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/docforge/api/internal/audit"
	"github.com/docforge/api/internal/auth"
)

type Handler struct {
	DB *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Handler { return &Handler{DB: db} }

// HashToken returns the stable sha256 hex digest used as the lookup key.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// Record inserts a new session row. Called by the auth handler on login.
// Failures are swallowed — session tracking is best-effort and shouldn't
// block login.
func Record(ctx context.Context, db *pgxpool.Pool, userID, orgID, token, ip, ua string) {
	if db == nil || userID == "" || orgID == "" || token == "" {
		return
	}
	ip = cleanIP(ip)
	_, _ = db.Exec(ctx, `
		INSERT INTO user_sessions (user_id, org_id, token_hash, ip_addr, user_agent)
		VALUES ($1, $2, $3, $4::inet, NULLIF($5,''))
		ON CONFLICT (token_hash) DO NOTHING
	`, userID, orgID, HashToken(token), ip, ua)
}

// Touch bumps last_active_at. Safe to call on every authenticated request
// (cheap update, no fanout).
func Touch(ctx context.Context, db *pgxpool.Pool, token string) {
	if db == nil || token == "" {
		return
	}
	_, _ = db.Exec(ctx,
		`UPDATE user_sessions SET last_active_at=now()
		  WHERE token_hash=$1 AND revoked_at IS NULL`,
		HashToken(token))
}

// IsRevoked returns true when the token has been explicitly revoked. A token
// not present in the table counts as NOT revoked (avoids rejecting older
// tokens issued before sessions tracking went live).
func IsRevoked(ctx context.Context, db *pgxpool.Pool, token string) bool {
	if db == nil || token == "" {
		return false
	}
	var revoked *time.Time
	err := db.QueryRow(ctx,
		`SELECT revoked_at FROM user_sessions WHERE token_hash=$1`,
		HashToken(token),
	).Scan(&revoked)
	if err != nil {
		return false
	}
	return revoked != nil
}

/* ------------------------- HTTP ------------------------- */

type sessionItem struct {
	ID           string `json:"id"`
	IP           string `json:"ip,omitempty"`
	UserAgent    string `json:"userAgent,omitempty"`
	CreatedAt    string `json:"createdAt"`
	LastActiveAt string `json:"lastActiveAt"`
	Current      bool   `json:"current"`
}

// List returns the caller's active sessions. Revoked sessions are excluded.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	currentHash := HashToken(extractBearer(r))

	rows, err := h.DB.Query(r.Context(),
		`SELECT id, COALESCE(host(ip_addr),''), COALESCE(user_agent,''),
		        created_at, last_active_at, token_hash
		   FROM user_sessions
		  WHERE user_id=$1 AND revoked_at IS NULL
		  ORDER BY last_active_at DESC`,
		c.UserID,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	out := []sessionItem{}
	for rows.Next() {
		var it sessionItem
		var created, active time.Time
		var hash string
		if err := rows.Scan(&it.ID, &it.IP, &it.UserAgent, &created, &active, &hash); err != nil {
			writeErr(w, 500, "scan", err.Error())
			return
		}
		it.CreatedAt = created.Format(time.RFC3339)
		it.LastActiveAt = active.Format(time.RFC3339)
		it.Current = hash == currentHash
		out = append(out, it)
	}
	writeJSON(w, 200, map[string]any{"sessions": out})
}

// Revoke marks a single session as revoked (other sessions only — revoking
// the current session would immediately log the user out of the page making
// the request).
func (h *Handler) Revoke(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeErr(w, 400, "missing_id", "session id is required")
		return
	}
	ct, err := h.DB.Exec(r.Context(),
		`UPDATE user_sessions
		    SET revoked_at=now()
		  WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`,
		id, c.UserID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if ct.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "session not found")
		return
	}
	audit.LogHTTP(r, h.DB, "session.revoke", "session", id, nil)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// RevokeOthers revokes every session for the caller except the one making
// this request. Useful for "sign out of all other devices".
func (h *Handler) RevokeOthers(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	currentHash := HashToken(extractBearer(r))
	ct, err := h.DB.Exec(r.Context(),
		`UPDATE user_sessions
		    SET revoked_at=now()
		  WHERE user_id=$1 AND token_hash<>$2 AND revoked_at IS NULL`,
		c.UserID, currentHash)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	audit.LogHTTP(r, h.DB, "session.revoke_all_others", "user", c.UserID,
		map[string]any{"count": ct.RowsAffected()})
	writeJSON(w, 200, map[string]any{"revoked": ct.RowsAffected()})
}

func (h *Handler) Mount(r chi.Router) {
	r.Get("/v1/sessions", h.List)
	r.Delete("/v1/sessions/{id}", h.Revoke)
	r.Post("/v1/sessions/revoke-others", h.RevokeOthers)
}

/* ------------------------- helpers ------------------------- */

func extractBearer(r *http.Request) string {
	v := r.Header.Get("Authorization")
	if !strings.HasPrefix(v, "Bearer ") {
		return ""
	}
	return strings.TrimPrefix(v, "Bearer ")
}

func cleanIP(ip string) string {
	if ip == "" {
		return "0.0.0.0"
	}
	if i := strings.LastIndex(ip, ":"); i > 0 && !strings.Contains(ip, "]") {
		return ip[:i]
	}
	return ip
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
