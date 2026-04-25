// Package me serves per-user profile endpoints used by /settings/account.
// The legacy GET /v1/me returns just the JWT claims; this package adds
// the enriched profile (org name, MFA state, sessions, recent activity)
// and a PATCH for editable fields like display name.
package me

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	DB *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Handler { return &Handler{DB: db} }

type profile struct {
	ID                 string    `json:"id"`
	Email              string    `json:"email"`
	Name               string    `json:"name"`
	Role               string    `json:"role"`
	IsSuperAdmin       bool      `json:"isSuperAdmin"`
	OrgID              string    `json:"orgId"`
	OrgName            string    `json:"orgName"`
	CreatedAt          time.Time `json:"createdAt"`
	LockedAt           *string   `json:"lockedAt,omitempty"`
	ForcePasswordReset bool      `json:"forcePasswordReset"`
	MfaEnabled         bool      `json:"mfaEnabled"`
	MfaEnrolledAt      *string   `json:"mfaEnrolledAt,omitempty"`
	RecoveryCodesLeft  int       `json:"recoveryCodesLeft"`
	ActiveSessions     int       `json:"activeSessions"`
	CurrentSession     *session  `json:"currentSession,omitempty"`
	MembershipCount    int       `json:"membershipCount"`
	RecentActivity     []event   `json:"recentActivity"`
}

type session struct {
	IPAddr       *string   `json:"ipAddr,omitempty"`
	UserAgent    *string   `json:"userAgent,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
	LastActiveAt time.Time `json:"lastActiveAt"`
}

type event struct {
	Action    string    `json:"action"`
	IPAddr    *string   `json:"ipAddr,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

// Get answers GET /v1/me/profile. Several small queries are issued
// because the data straddles users / two_factor_secrets / user_sessions /
// audit_log / org_memberships — keeping them focused is cheaper than a
// giant LEFT JOIN that would scan all of audit_log.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	ctx := r.Context()

	p := profile{
		ID:           c.UserID,
		Email:        c.Email,
		Role:         c.Role,
		IsSuperAdmin: c.IsSuperAdmin(),
		OrgID:        c.OrgID,
	}

	// Core user row + org name.
	var lockedAt *time.Time
	err := h.DB.QueryRow(ctx, `
		SELECT u.name, u.created_at, u.locked_at,
		       COALESCE(u.force_pw_reset, false),
		       COALESCE(o.name, '')
		  FROM users u
		  LEFT JOIN organizations o ON o.id = u.org_id
		 WHERE u.id = $1`, c.UserID,
	).Scan(&p.Name, &p.CreatedAt, &lockedAt, &p.ForcePasswordReset, &p.OrgName)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, 404, "not_found", "user not found")
		return
	}
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if lockedAt != nil {
		s := lockedAt.Format(time.RFC3339)
		p.LockedAt = &s
	}

	// MFA: presence of two_factor_secrets row + verified_at + recovery codes.
	var mfaVerified *time.Time
	var codes []string
	_ = h.DB.QueryRow(ctx, `
		SELECT verified_at, COALESCE(recovery_codes, '{}')
		  FROM two_factor_secrets
		 WHERE user_id = $1`, c.UserID,
	).Scan(&mfaVerified, &codes)
	if mfaVerified != nil {
		p.MfaEnabled = true
		s := mfaVerified.Format(time.RFC3339)
		p.MfaEnrolledAt = &s
	}
	p.RecoveryCodesLeft = len(codes)

	// Active sessions: row count where revoked_at is null.
	_ = h.DB.QueryRow(ctx, `
		SELECT COUNT(*) FROM user_sessions
		 WHERE user_id = $1 AND revoked_at IS NULL`, c.UserID,
	).Scan(&p.ActiveSessions)

	// Best-effort lookup of the current request's session row, matched
	// by sha256(token). When the request is API-key authed there is no
	// session row — that's fine, the field stays nil.
	if hash := tokenHashFromRequest(r); hash != "" {
		var s session
		var ip, ua *string
		err := h.DB.QueryRow(ctx, `
			SELECT host(ip_addr), user_agent, created_at, last_active_at
			  FROM user_sessions
			 WHERE token_hash = $1 AND revoked_at IS NULL
			 LIMIT 1`, hash,
		).Scan(&ip, &ua, &s.CreatedAt, &s.LastActiveAt)
		if err == nil {
			s.IPAddr = ip
			s.UserAgent = ua
			p.CurrentSession = &s
		}
	}

	// Membership count (multi-org users).
	_ = h.DB.QueryRow(ctx, `
		SELECT COUNT(*) FROM org_memberships WHERE user_id = $1`, c.UserID,
	).Scan(&p.MembershipCount)
	if p.MembershipCount == 0 {
		// Older accounts may pre-date org_memberships; the user is still
		// a member of their primary org via users.org_id.
		p.MembershipCount = 1
	}

	// Recent activity by this user (last 10).
	p.RecentActivity = []event{}
	if rows, err := h.DB.Query(ctx, `
		SELECT action, host(ip_addr), created_at
		  FROM audit_log
		 WHERE actor_id = $1
		 ORDER BY created_at DESC
		 LIMIT 10`, c.UserID); err == nil {
		defer rows.Close()
		for rows.Next() {
			var ev event
			var ip *string
			if err := rows.Scan(&ev.Action, &ip, &ev.CreatedAt); err == nil {
				ev.IPAddr = ip
				p.RecentActivity = append(p.RecentActivity, ev)
			}
		}
	}

	writeJSON(w, 200, p)
}

type updateReq struct {
	Name *string `json:"name,omitempty"`
}

// Patch answers PATCH /v1/me/profile. Currently only the display name is
// editable; email and role changes go through admin / billing flows.
func (h *Handler) Patch(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	var req updateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if req.Name == nil {
		writeErr(w, 400, "no_fields", "no editable fields supplied")
		return
	}
	name := strings.TrimSpace(*req.Name)
	if name == "" {
		writeErr(w, 400, "name_required", "name cannot be blank")
		return
	}
	if len(name) > 200 {
		writeErr(w, 400, "name_too_long", "name must be 200 characters or fewer")
		return
	}
	if _, err := h.DB.Exec(r.Context(),
		`UPDATE users SET name = $1 WHERE id = $2`, name, c.UserID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "name": name})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{
		"error": map[string]any{"code": slug, "message": msg},
	})
}

// tokenHashFromRequest sha256s the bearer token so we can find the
// matching user_sessions row. Returns "" when no usable bearer is
// present (e.g. an API-key authed request, which has no session row).
func tokenHashFromRequest(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(strings.ToLower(h), "bearer ") {
		return ""
	}
	tok := strings.TrimSpace(h[len("Bearer "):])
	if tok == "" || strings.HasPrefix(tok, "fk_") {
		return ""
	}
	sum := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(sum[:])
}

