// Package vault implements per-folder re-authentication ("locked folders").
//
// Folders flagged via /v1/folders/{id}/lock require the caller to confirm
// their password (and MFA, when enabled) within the last `TTL` minutes
// before the API will list, fetch, or download anything inside that
// folder or any of its descendants. ACL/sharing logic still applies on
// top — vault is a *second* gate, not a replacement.
//
// The unlock is *global per user*: once you re-auth, all folders that
// you would normally have access to AND that are currently locked become
// readable for the duration of the unlock window. This matches the
// macOS/Keychain and Bitwarden Vault model — one passphrase prompt,
// then everything is open for a few minutes.
//
// Locked-but-not-unlocked reads return HTTP 423 (Locked) with body
// `{"error":{"code":"vault_locked",...},"requiresVaultUnlock":true}` so
// the web client can pop the re-auth modal automatically.

package vault

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	"github.com/docforge/api/internal/auth"
)

// TTL is how long a vault unlock stays valid. Short on purpose — we want
// the user prompted again on the next sensitive folder visit, not a
// rolling all-day session.
const TTL = 5 * time.Minute

type Handler struct {
	DB *pgxpool.Pool

	// MFAVerify is auth's existing per-user MFA challenge verifier.
	// When non-nil and the user has MFA enabled, vault unlock requires
	// a fresh code in addition to the password.
	MFAVerify func(ctx context.Context, userID, code string) bool

	// MFARequired reports whether the user has MFA enrolled (if so, an
	// unlock without a code is rejected). Optional — when nil we treat
	// all users as MFA-disabled and only check the password.
	MFARequired func(ctx context.Context, userID string) (bool, error)

	// AuditFn mirrors the one on auth.Handler so vault operations show
	// up in the same audit_log stream as logins.
	AuditFn func(ctx context.Context, action, userID, orgID, email, ip, ua string, meta map[string]any)
}

func New(db *pgxpool.Pool) *Handler { return &Handler{DB: db} }

// ---------------------------------------------------------------------
// helpers — call from other packages (folders, files) before serving.
// ---------------------------------------------------------------------

// ErrLocked is returned by RequireUnlocked when the folder (or any of
// its ancestors) is locked and the user has no active vault session.
var ErrLocked = errors.New("vault: locked")

// IsFolderLocked walks up the parent chain. A folder is "locked" if it
// has locked_at set OR any ancestor does. Returns (locked, ownerID,
// error). ownerID is the user_id who set the lock on the deepest locked
// folder — useful for messaging ("locked by alice@…").
func IsFolderLocked(ctx context.Context, db *pgxpool.Pool, folderID string) (bool, string, error) {
	if folderID == "" {
		return false, "", nil
	}
	const q = `
		WITH RECURSIVE chain AS (
		  SELECT id, parent_id, locked_at, locked_by FROM folders WHERE id=$1
		  UNION ALL
		  SELECT f.id, f.parent_id, f.locked_at, f.locked_by
		    FROM folders f JOIN chain c ON f.id=c.parent_id
		)
		SELECT locked_by FROM chain
		 WHERE locked_at IS NOT NULL
		 ORDER BY id LIMIT 1`
	var lockedBy *string
	err := db.QueryRow(ctx, q, folderID).Scan(&lockedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, "", nil
	}
	if err != nil {
		return false, "", err
	}
	owner := ""
	if lockedBy != nil {
		owner = *lockedBy
	}
	return true, owner, nil
}

// IsUserUnlocked reports whether the caller has an active vault session.
// Cheap single-row lookup; safe to call on every gated request.
func IsUserUnlocked(ctx context.Context, db *pgxpool.Pool, userID string) (bool, error) {
	if userID == "" {
		return false, nil
	}
	var ok bool
	err := db.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM vault_sessions WHERE user_id=$1 AND expires_at>now())`,
		userID).Scan(&ok)
	return ok, err
}

// RequireUnlocked is the one-call gate for handlers. It returns nil if
// the folder is not locked OR the user has unlocked the vault, and
// ErrLocked otherwise. Pass folderID="" to skip the lock check (e.g.
// root-level reads).
func RequireUnlocked(ctx context.Context, db *pgxpool.Pool, userID, folderID string) error {
	if folderID == "" {
		return nil
	}
	locked, _, err := IsFolderLocked(ctx, db, folderID)
	if err != nil {
		return err
	}
	if !locked {
		return nil
	}
	unlocked, err := IsUserUnlocked(ctx, db, userID)
	if err != nil {
		return err
	}
	if !unlocked {
		return ErrLocked
	}
	return nil
}

// WriteLockedError emits the canonical 423 response body that the web
// client looks for to trigger its re-auth modal. Use this in handlers
// after RequireUnlocked returns ErrLocked.
func WriteLockedError(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusLocked)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{
			"code":    "vault_locked",
			"message": "Folder is locked. Re-authenticate to continue.",
		},
		"requiresVaultUnlock": true,
	})
}

// ---------------------------------------------------------------------
// HTTP: vault session lifecycle (re-auth + status + clear)
// ---------------------------------------------------------------------

type unlockReq struct {
	Password string `json:"password"`
	MFACode  string `json:"mfaCode,omitempty"`
}

type statusResp struct {
	Unlocked       bool   `json:"unlocked"`
	ExpiresAt      string `json:"expiresAt,omitempty"`
	MFARequired    bool   `json:"mfaRequired"`
	TTLSeconds     int    `json:"ttlSeconds"`
}

// Status returns the caller's current vault state. Web client polls /
// reads this on mount to render the lock chip and decide whether to
// prompt. Cheap; no DB writes.
func (h *Handler) Status(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	resp := statusResp{TTLSeconds: int(TTL / time.Second)}
	if h.MFARequired != nil {
		req, _ := h.MFARequired(r.Context(), c.UserID)
		resp.MFARequired = req
	}
	var exp time.Time
	err := h.DB.QueryRow(r.Context(),
		`SELECT expires_at FROM vault_sessions WHERE user_id=$1 AND expires_at>now()`, c.UserID,
	).Scan(&exp)
	if err == nil {
		resp.Unlocked = true
		resp.ExpiresAt = exp.UTC().Format(time.RFC3339)
	}
	writeJSON(w, 200, resp)
}

// Unlock verifies password (+ MFA if enabled) and grants the caller a
// fresh TTL-long vault session. Always audited — both successes and
// failures land in audit_log under `vault.unlock` / `vault.unlock.failed`.
func (h *Handler) Unlock(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	var req unlockReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if strings.TrimSpace(req.Password) == "" {
		writeErr(w, 400, "missing_password", "password required")
		return
	}

	// Verify the password against users.password_hash. We deliberately
	// re-fetch by id (not email) so a stale-token replay still has to
	// match the user the JWT was issued for.
	var hash string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT password_hash FROM users WHERE id=$1`, c.UserID,
	).Scan(&hash); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		h.audit(r, c, "vault.unlock.failed", map[string]any{"reason": "bad_password"})
		writeErr(w, 401, "bad_credentials", "invalid password")
		return
	}

	// MFA when enrolled — refuse silent unlocks for users who have
	// chosen 2FA on their account. The same handler that protects
	// login uses these hooks, so behaviour is consistent.
	if h.MFARequired != nil {
		needs, _ := h.MFARequired(r.Context(), c.UserID)
		if needs {
			if req.MFACode == "" {
				writeErr(w, 401, "mfa_required", "mfa code required")
				return
			}
			if h.MFAVerify == nil || !h.MFAVerify(r.Context(), c.UserID, req.MFACode) {
				h.audit(r, c, "vault.unlock.failed", map[string]any{"reason": "bad_mfa"})
				writeErr(w, 401, "bad_mfa", "invalid mfa code")
				return
			}
		}
	}

	exp := time.Now().Add(TTL)
	if _, err := h.DB.Exec(r.Context(), `
		INSERT INTO vault_sessions (user_id, expires_at)
		VALUES ($1, $2)
		ON CONFLICT (user_id)
		DO UPDATE SET expires_at = EXCLUDED.expires_at`,
		c.UserID, exp,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	h.audit(r, c, "vault.unlock", nil)
	writeJSON(w, 200, map[string]any{
		"unlocked":   true,
		"expiresAt":  exp.UTC().Format(time.RFC3339),
		"ttlSeconds": int(TTL / time.Second),
	})
}

// Lock immediately revokes the caller's vault session. Doesn't error
// when no session exists — idempotent.
func (h *Handler) Lock(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	_, _ = h.DB.Exec(r.Context(), `DELETE FROM vault_sessions WHERE user_id=$1`, c.UserID)
	h.audit(r, c, "vault.lock", nil)
	writeJSON(w, 200, map[string]any{"unlocked": false})
}

// ---------------------------------------------------------------------
// HTTP: per-folder lock / unlock toggle (admin or owner only)
// ---------------------------------------------------------------------

func (h *Handler) LockFolder(w http.ResponseWriter, r *http.Request) {
	h.toggleLock(w, r, true)
}

func (h *Handler) UnlockFolder(w http.ResponseWriter, r *http.Request) {
	h.toggleLock(w, r, false)
}

func (h *Handler) toggleLock(w http.ResponseWriter, r *http.Request, lock bool) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeErr(w, 400, "missing_id", "folder id required")
		return
	}

	// Only the owner or an admin can toggle the lock.
	var ownerID string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT owner_id::text FROM folders WHERE id=$1 AND org_id=$2`, id, c.OrgID,
	).Scan(&ownerID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, 404, "not_found", "folder not found")
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if !c.IsAdmin() && ownerID != c.UserID {
		writeErr(w, 403, "forbidden", "only the owner or an admin can lock this folder")
		return
	}

	var sql string
	args := []any{id, c.OrgID}
	if lock {
		sql = `UPDATE folders SET locked_at=now(), locked_by=$3, updated_at=now()
		        WHERE id=$1 AND org_id=$2`
		args = append(args, c.UserID)
	} else {
		sql = `UPDATE folders SET locked_at=NULL, locked_by=NULL, updated_at=now()
		        WHERE id=$1 AND org_id=$2`
	}
	if _, err := h.DB.Exec(r.Context(), sql, args...); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	action := "vault.folder.locked"
	if !lock {
		action = "vault.folder.unlocked"
	}
	h.audit(r, c, action, map[string]any{"folderId": id})
	writeJSON(w, 200, map[string]any{"ok": true, "locked": lock})
}

// ---------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------

func (h *Handler) audit(r *http.Request, c *auth.Claims, action string, meta map[string]any) {
	if h.AuditFn == nil {
		return
	}
	h.AuditFn(r.Context(), action, c.UserID, c.OrgID, c.Email, clientIP(r), r.UserAgent(), meta)
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

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{
		"error": map[string]string{"code": slug, "message": msg},
	})
}
