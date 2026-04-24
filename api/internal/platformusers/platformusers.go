// Package platformusers implements the super-admin user-management
// surface (Phase 1: list/search, detail, lock/unlock, MFA reset, kill
// sessions). Distinct from `internal/team` — that package is for org
// admins managing their own workspace; this one is for platform
// operators acting across every org.
//
// Authorization
// -------------
// All handlers expect the caller to have already passed through the
// SuperAdminOnly middleware in cmd/api/main.go. We don't re-check here
// because that would be a layered concern — but we DO write an audit
// row tagged "super_admin_action" for every state-changing request so
// the trail is unfalsifiable.
package platformusers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/audit"
	"github.com/docforge/api/internal/auth"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	DB *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Handler { return &Handler{DB: db} }

// -- list / search -------------------------------------------------------

type userRow struct {
	ID         string  `json:"id"`
	Email      string  `json:"email"`
	Name       string  `json:"name"`
	Role       string  `json:"role"`
	OrgID      string  `json:"orgId"`
	OrgName    string  `json:"orgName"`
	HasMFA     bool    `json:"hasMfa"`
	LockedAt   *string `json:"lockedAt,omitempty"`
	LockReason *string `json:"lockReason,omitempty"`
	CreatedAt  string  `json:"createdAt"`
	LastSeenAt *string `json:"lastSeenAt,omitempty"`
}

// List returns up to `limit` users matching the optional filters.
//
// Filters (all optional, AND-combined):
//   q       — case-insensitive substring of email or name
//   orgId   — restrict to one workspace
//   status  — "active" / "locked" / "no_mfa"
//   role    — admin / editor / viewer
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	orgID := strings.TrimSpace(r.URL.Query().Get("orgId"))
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	role := strings.TrimSpace(r.URL.Query().Get("role"))
	limit := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		var n int
		if _, err := atoi(v, &n); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}

	// Build WHERE dynamically. We assemble args first, then build the
	// SQL string with $1, $2, ... in the same order — keeps the wiring
	// obvious to anyone debugging a parameter mismatch.
	var (
		conds []string
		args  []any
	)
	if q != "" {
		args = append(args, "%"+q+"%")
		p := "$" + itoa(len(args))
		conds = append(conds, "(u.email ILIKE "+p+" OR u.name ILIKE "+p+")")
	}
	if orgID != "" {
		args = append(args, orgID)
		conds = append(conds, "u.org_id = $"+itoa(len(args))+"::uuid")
	}
	if role != "" {
		args = append(args, role)
		conds = append(conds, "u.role = $"+itoa(len(args)))
	}
	switch status {
	case "active":
		conds = append(conds, "u.locked_at IS NULL")
	case "locked":
		conds = append(conds, "u.locked_at IS NOT NULL")
	case "no_mfa":
		conds = append(conds, "NOT EXISTS (SELECT 1 FROM two_factor_secrets t WHERE t.user_id=u.id)")
	}
	if len(conds) == 0 {
		conds = []string{"true"}
	}
	args = append(args, limit)
	limitPlaceholder := "$" + itoa(len(args))

	sql := `
		SELECT u.id, u.email, COALESCE(u.name,''), COALESCE(u.role,'editor'),
		       u.org_id, COALESCE(o.name,''),
		       EXISTS (SELECT 1 FROM two_factor_secrets t WHERE t.user_id=u.id) AS has_mfa,
		       u.locked_at, u.locked_reason,
		       u.created_at,
		       (SELECT MAX(last_active_at) FROM user_sessions s
		         WHERE s.user_id=u.id AND s.revoked_at IS NULL) AS last_seen
		  FROM users u
		  LEFT JOIN organizations o ON o.id = u.org_id
		 WHERE ` + strings.Join(conds, " AND ") + `
		 ORDER BY u.created_at DESC
		 LIMIT ` + limitPlaceholder

	rows, err := h.DB.Query(r.Context(), sql, args...)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	out := []userRow{}
	for rows.Next() {
		var (
			u                  userRow
			lockedAt, lastSeen *time.Time
			createdAt          time.Time
		)
		if err := rows.Scan(
			&u.ID, &u.Email, &u.Name, &u.Role,
			&u.OrgID, &u.OrgName,
			&u.HasMFA,
			&lockedAt, &u.LockReason,
			&createdAt,
			&lastSeen,
		); err != nil {
			continue
		}
		u.CreatedAt = createdAt.Format(time.RFC3339)
		if lockedAt != nil {
			s := lockedAt.Format(time.RFC3339)
			u.LockedAt = &s
		}
		if lastSeen != nil {
			s := lastSeen.Format(time.RFC3339)
			u.LastSeenAt = &s
		}
		out = append(out, u)
	}
	writeJSON(w, 200, map[string]any{"users": out})
}

// -- detail --------------------------------------------------------------

type userDetail struct {
	userRow
	Memberships []membership `json:"memberships"`
	Sessions    []sessionDTO `json:"sessions"`
	RecentAudit []auditEntry `json:"recentAudit"`
}

type membership struct {
	OrgID   string `json:"orgId"`
	OrgName string `json:"orgName"`
	Role    string `json:"role"`
	Source  string `json:"source"` // "primary" — extension hook for future multi-org support
}

type sessionDTO struct {
	ID           string `json:"id"`
	IP           string `json:"ip"`
	UserAgent    string `json:"userAgent"`
	CreatedAt    string `json:"createdAt"`
	LastActiveAt string `json:"lastActiveAt"`
}

type auditEntry struct {
	At     string         `json:"at"`
	Action string         `json:"action"`
	IP     string         `json:"ip"`
	Meta   map[string]any `json:"meta,omitempty"`
}

func (h *Handler) Detail(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var (
		u         userRow
		lockedAt  *time.Time
		createdAt time.Time
	)
	err := h.DB.QueryRow(r.Context(), `
		SELECT u.id, u.email, COALESCE(u.name,''), COALESCE(u.role,'editor'),
		       u.org_id, COALESCE(o.name,''),
		       EXISTS (SELECT 1 FROM two_factor_secrets t WHERE t.user_id=u.id),
		       u.locked_at, u.locked_reason, u.created_at
		  FROM users u
		  LEFT JOIN organizations o ON o.id = u.org_id
		 WHERE u.id=$1`, id,
	).Scan(&u.ID, &u.Email, &u.Name, &u.Role, &u.OrgID, &u.OrgName,
		&u.HasMFA, &lockedAt, &u.LockReason, &createdAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, 404, "not_found", "user not found")
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	u.CreatedAt = createdAt.Format(time.RFC3339)
	if lockedAt != nil {
		s := lockedAt.Format(time.RFC3339)
		u.LockedAt = &s
	}

	// Sessions — only currently-active ones (revoked_at IS NULL).
	sessions := []sessionDTO{}
	srows, err := h.DB.Query(r.Context(), `
		SELECT id, COALESCE(ip::text,''), COALESCE(user_agent,''),
		       created_at, COALESCE(last_active_at, created_at)
		  FROM user_sessions
		 WHERE user_id=$1 AND revoked_at IS NULL
		 ORDER BY last_active_at DESC NULLS LAST
		 LIMIT 25`, id)
	if err == nil {
		defer srows.Close()
		for srows.Next() {
			var s sessionDTO
			var created, last time.Time
			if err := srows.Scan(&s.ID, &s.IP, &s.UserAgent, &created, &last); err == nil {
				s.CreatedAt = created.Format(time.RFC3339)
				s.LastActiveAt = last.Format(time.RFC3339)
				sessions = append(sessions, s)
			}
		}
	}

	// Last 50 audit rows where this user was either actor or subject.
	// Optional ?auditAction= narrows by action prefix — e.g.
	// "auth.login" picks up successful, failed, and locked-login
	// events together; "super_admin." surfaces operator actions
	// taken on this account.
	recent := []auditEntry{}
	auditFilter := strings.TrimSpace(r.URL.Query().Get("auditAction"))
	auditSQL := `
		SELECT created_at, action, COALESCE(ip_addr::text,''), meta
		  FROM audit_log
		 WHERE (actor_id=$1 OR (meta->>'targetUserId')=$1::text)`
	auditArgs := []any{id}
	if auditFilter != "" {
		auditArgs = append(auditArgs, auditFilter+"%")
		auditSQL += ` AND action ILIKE $` + itoa(len(auditArgs))
	}
	auditSQL += ` ORDER BY created_at DESC LIMIT 50`
	arows, err := h.DB.Query(r.Context(), auditSQL, auditArgs...)
	if err == nil {
		defer arows.Close()
		for arows.Next() {
			var e auditEntry
			var at time.Time
			var metaJSON []byte
			if err := arows.Scan(&at, &e.Action, &e.IP, &metaJSON); err == nil {
				e.At = at.Format(time.RFC3339)
				if len(metaJSON) > 0 {
					_ = json.Unmarshal(metaJSON, &e.Meta)
				}
				recent = append(recent, e)
			}
		}
	}

	memberships := []membership{
		{OrgID: u.OrgID, OrgName: u.OrgName, Role: u.Role, Source: "primary"},
	}

	writeJSON(w, 200, userDetail{
		userRow:     u,
		Memberships: memberships,
		Sessions:    sessions,
		RecentAudit: recent,
	})
}

// -- lock / unlock -------------------------------------------------------

type lockReq struct {
	Reason string `json:"reason"`
}

func (h *Handler) Lock(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	if c != nil && c.UserID == id {
		writeErr(w, 400, "cannot_self_lock",
			"you can't lock yourself out — ask another super-admin")
		return
	}
	var req lockReq
	_ = json.NewDecoder(r.Body).Decode(&req)
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		writeErr(w, 400, "missing_reason",
			"a reason is required so the audit trail explains the lock")
		return
	}
	tag, err := h.DB.Exec(r.Context(), `
		UPDATE users
		   SET locked_at=now(), locked_by=$2::uuid, locked_reason=$3,
		       updated_at=now()
		 WHERE id=$1 AND locked_at IS NULL`,
		id, c.UserID, reason)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 409, "already_locked",
			"this user is already locked — unlock first if you want to re-lock with a new reason")
		return
	}
	// Locking should also kill every live session — otherwise a logged-in
	// user keeps working until their JWT expires (up to 24h). Belt-and-braces.
	_, _ = h.DB.Exec(r.Context(),
		`UPDATE user_sessions SET revoked_at=now()
		  WHERE user_id=$1 AND revoked_at IS NULL`, id)

	audit.LogHTTP(r, h.DB, "super_admin.user_locked", "user", id,
		map[string]any{"reason": reason, "targetUserId": id})
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (h *Handler) Unlock(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	tag, err := h.DB.Exec(r.Context(), `
		UPDATE users
		   SET locked_at=NULL, locked_by=NULL, locked_reason=NULL,
		       updated_at=now()
		 WHERE id=$1 AND locked_at IS NOT NULL`, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_locked", "user is not currently locked")
		return
	}
	audit.LogHTTP(r, h.DB, "super_admin.user_unlocked", "user", id,
		map[string]any{"targetUserId": id})
	writeJSON(w, 200, map[string]any{"ok": true})
}

// -- reset MFA (cross-org variant of team.ResetMFA) ----------------------

func (h *Handler) ResetMFA(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	tag, err := h.DB.Exec(r.Context(),
		`DELETE FROM two_factor_secrets WHERE user_id=$1`, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	audit.LogHTTP(r, h.DB, "super_admin.user_mfa_reset", "user", id,
		map[string]any{"targetUserId": id, "hadMFA": tag.RowsAffected() > 0})
	writeJSON(w, 200, map[string]any{"ok": true, "hadMFA": tag.RowsAffected() > 0})
}

// -- force password reset ------------------------------------------------

// ForcePasswordReset flips the user's force_pw_reset flag and revokes
// every active session. Next sign-in succeeds password-wise but the
// web app gates all subsequent navigation on /set-password until the
// user picks a new one. The flag is idempotent — flipping it on a
// user who already needs to reset is a no-op.
func (h *Handler) ForcePasswordReset(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	tag, err := h.DB.Exec(r.Context(),
		`UPDATE users SET force_pw_reset=true, updated_at=now() WHERE id=$1`,
		id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "user not found")
		return
	}
	// Killing sessions ensures the next request from any device hits
	// the login flow — otherwise an existing JWT would let them keep
	// browsing until expiry.
	_, _ = h.DB.Exec(r.Context(),
		`UPDATE user_sessions SET revoked_at=now()
		  WHERE user_id=$1 AND revoked_at IS NULL`, id)

	audit.LogHTTP(r, h.DB, "super_admin.user_force_pw_reset", "user", id,
		map[string]any{"targetUserId": id})
	writeJSON(w, 200, map[string]any{"ok": true})
}

// -- revoke all sessions -------------------------------------------------

func (h *Handler) RevokeSessions(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	tag, err := h.DB.Exec(r.Context(), `
		UPDATE user_sessions SET revoked_at=now()
		 WHERE user_id=$1 AND revoked_at IS NULL`, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	audit.LogHTTP(r, h.DB, "super_admin.user_sessions_revoked", "user", id,
		map[string]any{"targetUserId": id, "count": tag.RowsAffected()})
	writeJSON(w, 200, map[string]any{"ok": true, "revoked": tag.RowsAffected()})
}

// -- helpers -------------------------------------------------------------

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

// itoa avoids strconv import for the only place we need integer→string
// conversion (positional argument numbering).
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

// atoi is a tiny stand-in for strconv.Atoi — only used by the limit
// guard, so pulling in strconv just for one call is overkill.
func atoi(s string, out *int) (int, error) {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, errors.New("not a number")
		}
		n = n*10 + int(c-'0')
	}
	*out = n
	return n, nil
}

// silence-only retention so future handlers that take a context arg
// don't need to re-add the import.
var _ = context.Background
