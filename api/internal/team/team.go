// Package team implements workspace membership and invitations.
//
//   - Admin users can invite teammates by email, change roles, and remove
//     members. Every other role is read-only for team endpoints.
//   - Invites carry a tokenized URL; anyone with the token can accept and
//     join the org. Tokens are single-use (accepted_at flips).
//   - The first user in each org is automatically the admin (migrated +
//     enforced during /auth/register).
package team

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/events"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

type Handler struct {
	DB   *pgxpool.Pool
	Auth *auth.Handler
}

func New(db *pgxpool.Pool, a *auth.Handler) *Handler {
	return &Handler{DB: db, Auth: a}
}

// -- admin guard ----------------------------------------------------------

func adminOnly(r *http.Request) (*auth.Claims, error) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil || !c.IsAdmin() {
		return nil, errors.New("admin role required")
	}
	return c, nil
}

// -- members --------------------------------------------------------------

type memberDTO struct {
	ID        string `json:"id"`
	Email     string `json:"email"`
	Name      string `json:"name"`
	Role      string `json:"role"`
	CreatedAt string `json:"createdAt"`
	IsSelf    bool   `json:"isSelf"`
}

func (h *Handler) ListMembers(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, email, COALESCE(name,''), COALESCE(role,'editor'), created_at
		  FROM users WHERE org_id=$1
		 ORDER BY role='admin' DESC, created_at ASC`, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []memberDTO{}
	for rows.Next() {
		var id, email, name, role string
		var createdAt time.Time
		if err := rows.Scan(&id, &email, &name, &role, &createdAt); err != nil {
			continue
		}
		out = append(out, memberDTO{
			ID: id, Email: email, Name: name, Role: role,
			CreatedAt: createdAt.Format(time.RFC3339),
			IsSelf:    id == c.UserID,
		})
	}
	writeJSON(w, 200, map[string]any{"members": out})
}

type updateMemberReq struct {
	Role string `json:"role"`
}

func (h *Handler) UpdateMember(w http.ResponseWriter, r *http.Request) {
	c, err := adminOnly(r)
	if err != nil {
		writeErr(w, 403, "forbidden", err.Error())
		return
	}
	id := chi.URLParam(r, "id")
	if id == c.UserID {
		writeErr(w, 400, "cannot_self_modify", "you can't change your own role — ask another admin")
		return
	}
	var req updateMemberReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	role := normalizeRole(req.Role)
	tag, err := h.DB.Exec(r.Context(),
		`UPDATE users SET role=$1, updated_at=now() WHERE id=$2 AND org_id=$3`,
		role, id, c.OrgID,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "member not found")
		return
	}
	events.Publish(r.Context(), "team.role_changed", c.OrgID, map[string]interface{}{
		"userId": id, "role": role,
	})
	writeJSON(w, 200, map[string]any{"ok": true, "role": role})
}

func (h *Handler) RemoveMember(w http.ResponseWriter, r *http.Request) {
	c, err := adminOnly(r)
	if err != nil {
		writeErr(w, 403, "forbidden", err.Error())
		return
	}
	id := chi.URLParam(r, "id")
	if id == c.UserID {
		writeErr(w, 400, "cannot_self_remove", "transfer admin to another user before removing yourself")
		return
	}
	tag, err := h.DB.Exec(r.Context(),
		`DELETE FROM users WHERE id=$1 AND org_id=$2`, id, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "member not found")
		return
	}
	events.Publish(r.Context(), "team.member_removed", c.OrgID, map[string]interface{}{
		"userId": id,
	})
	writeJSON(w, 200, map[string]any{"ok": true})
}

// -- invites --------------------------------------------------------------

type inviteDTO struct {
	ID         string  `json:"id"`
	Email      string  `json:"email"`
	Role       string  `json:"role"`
	Token      string  `json:"token"`
	CreatedAt  string  `json:"createdAt"`
	ExpiresAt  *string `json:"expiresAt,omitempty"`
	AcceptedAt *string `json:"acceptedAt,omitempty"`
	RevokedAt  *string `json:"revokedAt,omitempty"`
	InvitedBy  string  `json:"invitedBy,omitempty"`
}

func (h *Handler) ListInvites(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	rows, err := h.DB.Query(r.Context(), `
		SELECT i.id, i.email, i.role, i.token, i.created_at, i.expires_at,
		       i.accepted_at, i.revoked_at, COALESCE(u.email,'')
		  FROM invitations i LEFT JOIN users u ON u.id=i.invited_by
		 WHERE i.org_id=$1
		 ORDER BY i.created_at DESC`, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []inviteDTO{}
	for rows.Next() {
		var (
			id, email, role, token, invitedBy string
			createdAt                         time.Time
			expiresAt, acceptedAt, revokedAt  *time.Time
		)
		if err := rows.Scan(&id, &email, &role, &token, &createdAt, &expiresAt, &acceptedAt, &revokedAt, &invitedBy); err != nil {
			continue
		}
		dto := inviteDTO{
			ID: id, Email: email, Role: role, Token: token,
			CreatedAt: createdAt.Format(time.RFC3339),
			InvitedBy: invitedBy,
		}
		if expiresAt != nil {
			s := expiresAt.Format(time.RFC3339)
			dto.ExpiresAt = &s
		}
		if acceptedAt != nil {
			s := acceptedAt.Format(time.RFC3339)
			dto.AcceptedAt = &s
		}
		if revokedAt != nil {
			s := revokedAt.Format(time.RFC3339)
			dto.RevokedAt = &s
		}
		out = append(out, dto)
	}
	writeJSON(w, 200, map[string]any{"invites": out})
}

type createInviteReq struct {
	Email    string `json:"email"`
	Role     string `json:"role"`
	ExpireIn int    `json:"expiresInDays,omitempty"`
}

func (h *Handler) CreateInvite(w http.ResponseWriter, r *http.Request) {
	c, err := adminOnly(r)
	if err != nil {
		writeErr(w, 403, "forbidden", err.Error())
		return
	}
	var req createInviteReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if email == "" || !strings.Contains(email, "@") {
		writeErr(w, 400, "bad_email", "a valid email is required")
		return
	}
	// Reject if this email is already a member.
	var exists bool
	_ = h.DB.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM users WHERE org_id=$1 AND email=$2)`,
		c.OrgID, email).Scan(&exists)
	if exists {
		writeErr(w, 409, "already_member", "this email is already a team member")
		return
	}
	role := normalizeRole(req.Role)
	token, err := randomToken()
	if err != nil {
		writeErr(w, 500, "rand", err.Error())
		return
	}
	var expiresAt *time.Time
	days := req.ExpireIn
	if days <= 0 {
		days = 14
	}
	t := time.Now().AddDate(0, 0, days)
	expiresAt = &t

	var id string
	var createdAt time.Time
	err = h.DB.QueryRow(r.Context(), `
		INSERT INTO invitations (org_id, email, role, token, invited_by, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6)
		RETURNING id, created_at
	`, c.OrgID, email, role, token, c.UserID, expiresAt).Scan(&id, &createdAt)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	events.Publish(r.Context(), "team.invited", c.OrgID, map[string]interface{}{
		"inviteId": id, "email": email, "role": role,
	})
	writeJSON(w, 200, map[string]any{
		"id":        id,
		"token":     token,
		"email":     email,
		"role":      role,
		"createdAt": createdAt.Format(time.RFC3339),
		"expiresAt": expiresAt.Format(time.RFC3339),
	})
}

func (h *Handler) RevokeInvite(w http.ResponseWriter, r *http.Request) {
	c, err := adminOnly(r)
	if err != nil {
		writeErr(w, 403, "forbidden", err.Error())
		return
	}
	id := chi.URLParam(r, "id")
	tag, err := h.DB.Exec(r.Context(), `
		UPDATE invitations SET revoked_at=now()
		 WHERE id=$1 AND org_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL`,
		id, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "invite not found or already handled")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// -- public accept --------------------------------------------------------

type publicInviteResp struct {
	Email    string `json:"email"`
	Role     string `json:"role"`
	OrgName  string `json:"orgName"`
	Expired  bool   `json:"expired"`
	Accepted bool   `json:"accepted"`
	Revoked  bool   `json:"revoked"`
}

func (h *Handler) ResolvePublic(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	var (
		email, role, orgName                string
		expiresAt, acceptedAt, revokedAt    *time.Time
	)
	err := h.DB.QueryRow(r.Context(), `
		SELECT i.email, i.role, o.name, i.expires_at, i.accepted_at, i.revoked_at
		  FROM invitations i JOIN organizations o ON o.id=i.org_id
		 WHERE i.token=$1`, token,
	).Scan(&email, &role, &orgName, &expiresAt, &acceptedAt, &revokedAt)
	if err != nil {
		writeErr(w, 404, "not_found", "invitation not found")
		return
	}
	writeJSON(w, 200, publicInviteResp{
		Email: email, Role: role, OrgName: orgName,
		Expired:  expiresAt != nil && expiresAt.Before(time.Now()),
		Accepted: acceptedAt != nil,
		Revoked:  revokedAt != nil,
	})
}

type acceptReq struct {
	Name     string `json:"name"`
	Password string `json:"password"`
}

func (h *Handler) Accept(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	var req acceptReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if len(req.Password) < 8 {
		writeErr(w, 400, "short_password", "password must be at least 8 characters")
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		writeErr(w, 400, "missing_name", "name is required")
		return
	}

	ctx := r.Context()
	tx, err := h.DB.Begin(ctx)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(ctx)

	var (
		invID, orgID, email, role            string
		expiresAt, acceptedAt, revokedAt     *time.Time
	)
	err = tx.QueryRow(ctx, `
		SELECT id, org_id, email, role, expires_at, accepted_at, revoked_at
		  FROM invitations WHERE token=$1 FOR UPDATE`, token,
	).Scan(&invID, &orgID, &email, &role, &expiresAt, &acceptedAt, &revokedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, 404, "not_found", "invitation not found")
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if acceptedAt != nil {
		writeErr(w, 410, "already_accepted", "this invitation was already accepted")
		return
	}
	if revokedAt != nil {
		writeErr(w, 410, "revoked", "this invitation was revoked")
		return
	}
	if expiresAt != nil && expiresAt.Before(time.Now()) {
		writeErr(w, 410, "expired", "this invitation has expired")
		return
	}

	// Create the user. If the email already exists somewhere (shouldn't because
	// we prevented that at create time, but double-check), fail clearly.
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
	if err != nil {
		writeErr(w, 500, "hash", err.Error())
		return
	}
	var userID string
	err = tx.QueryRow(ctx, `
		INSERT INTO users (org_id, email, password_hash, name, role)
		VALUES ($1,$2,$3,$4,$5)
		RETURNING id
	`, orgID, email, string(hash), strings.TrimSpace(req.Name), role).Scan(&userID)
	if err != nil {
		writeErr(w, 400, "create_failed", err.Error())
		return
	}
	if _, err := tx.Exec(ctx,
		`UPDATE invitations SET accepted_at=now() WHERE id=$1`, invID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeErr(w, 500, "commit", err.Error())
		return
	}

	events.Publish(ctx, "team.joined", orgID, map[string]interface{}{
		"userId": userID, "email": email, "role": role,
	})

	tok, _ := h.Auth.IssueTokenForUser(userID, orgID, email, role)
	writeJSON(w, 200, map[string]any{
		"token": tok,
		"user": map[string]any{
			"id":    userID,
			"email": email,
			"name":  strings.TrimSpace(req.Name),
			"orgId": orgID,
			"role":  role,
		},
	})
}

// -- helpers --------------------------------------------------------------

func normalizeRole(role string) string {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "admin":
		return auth.RoleAdmin
	case "viewer":
		return auth.RoleViewer
	default:
		return auth.RoleEditor
	}
}

func randomToken() (string, error) {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}

// Silence unused-import warning on rare paths.
var _ = fmt.Sprintf
