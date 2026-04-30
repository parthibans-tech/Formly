// Package memberships exposes a user's set of org memberships and the
// switch-org flow.
//
// The active org continues to live on the JWT (claim "oid"). Switching
// orgs means: verify the user is a member of the target, mint a fresh
// JWT with that orgId + the role from the membership row, return it.
// The web app stashes the new token and reloads.
//
// Super-admin endpoints to add/remove memberships live in
// internal/platformusers (kept colocated with the rest of the
// per-user admin surface).
package memberships

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/docforge/api/internal/audit"
	"github.com/docforge/api/internal/auth"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	DB     *pgxpool.Pool
	Auth   *auth.Handler
}

func New(db *pgxpool.Pool, a *auth.Handler) *Handler {
	return &Handler{DB: db, Auth: a}
}

type membershipRow struct {
	OrgID     string `json:"orgId"`
	OrgName   string `json:"orgName"`
	Role      string `json:"role"`
	Source    string `json:"source"`
	IsCurrent bool   `json:"isCurrent"`
	IsPrimary bool   `json:"isPrimary"`
	Frozen    bool   `json:"frozen"`
	Deleted   bool   `json:"deleted"`
}

// List returns every org the caller belongs to. The current org (per
// the JWT claim) is flagged so the UI can highlight it; primary is the
// user's default landing org.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	rows, err := h.DB.Query(r.Context(), `
		SELECT m.org_id, COALESCE(o.name,''), m.role, m.source,
		       (u.org_id = m.org_id) AS is_primary,
		       (o.frozen_at IS NOT NULL) AS frozen,
		       (o.deleted_at IS NOT NULL) AS deleted
		  FROM org_memberships m
		  JOIN users u ON u.id = m.user_id
		  LEFT JOIN organizations o ON o.id = m.org_id
		 WHERE m.user_id = $1
		 ORDER BY is_primary DESC, o.name ASC`, c.UserID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	out := []membershipRow{}
	for rows.Next() {
		var m membershipRow
		if err := rows.Scan(&m.OrgID, &m.OrgName, &m.Role, &m.Source,
			&m.IsPrimary, &m.Frozen, &m.Deleted); err != nil {
			continue
		}
		m.IsCurrent = m.OrgID == c.OrgID
		out = append(out, m)
	}
	writeJSON(w, 200, map[string]any{"memberships": out})
}

type switchReq struct {
	OrgID string `json:"orgId"`
}

// Switch mints a fresh JWT for the requested org. We refuse if:
//   - the user isn't a member of that org
//   - the org is soft-deleted (no future for the session)
//
// Frozen orgs are allowed because read-only access is still useful and
// the auth middleware will reject any write attempt.
func (h *Handler) Switch(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	var req switchReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if req.OrgID == "" {
		writeErr(w, 400, "missing_org", "orgId is required")
		return
	}

	var (
		role      string
		orgKind   string
		deletedAt *time.Time
	)
	err := h.DB.QueryRow(r.Context(), `
		SELECT m.role, COALESCE(o.kind,'team'), o.deleted_at
		  FROM org_memberships m
		  JOIN organizations o ON o.id = m.org_id
		 WHERE m.user_id = $1 AND m.org_id = $2`, c.UserID, req.OrgID,
	).Scan(&role, &orgKind, &deletedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, 403, "not_a_member", "you don't belong to that org")
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if deletedAt != nil {
		writeErr(w, 410, "org_deleted", "that org has been deleted")
		return
	}

	token, err := h.Auth.IssueTokenForUser(c.UserID, req.OrgID, c.Email, role)
	if err != nil {
		writeErr(w, 500, "token_error", err.Error())
		return
	}
	audit.LogHTTP(r, h.Auth.DB, "auth.switch_org", "org", req.OrgID,
		map[string]any{"from": c.OrgID, "to": req.OrgID})
	writeJSON(w, 200, map[string]any{
		"token": token,
		"orgId": req.OrgID,
		"role":  role,
		// Surface the new org's kind so the web client can update its
		// cached user blob in the same beat — keeps the sidebar's
		// first paint after switch correct without an extra round trip.
		"orgKind": orgKind,
	})
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
