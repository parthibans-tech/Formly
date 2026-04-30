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
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	htmlpkg "html"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/billing"
	"github.com/docforge/api/internal/events"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

type Handler struct {
	DB   *pgxpool.Pool
	Auth *auth.Handler

	// Mailer is optional — when wired, CreateInvite emails the
	// recipient with an accept link. Nil keeps tests / CLI that build
	// a Handler directly working without an SMTP/SES dependency.
	Mailer Notifier
}

// Notifier is the slim shape team needs from mail.Mailer. Declared
// locally so this package never imports `internal/mail` (and thus
// never picks up the email + generate transitive deps).
type Notifier interface {
	Send(ctx context.Context, opts NotifyOptions) (string, error)
}

type NotifyOptions struct {
	OrgID    string
	UserID   string
	Kind     string
	Source   string
	To       []string
	Subject  string
	HTMLBody string
	TextBody string
	Metadata map[string]any
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
	// Members come from org_memberships (Phase 4 source of truth) so
	// cross-org members — users whose `users` row points at a different
	// home org but who joined this one via invite — show up alongside
	// the org's own users. Role is taken from the membership row, not
	// users.role, because a user's role can differ between orgs (admin
	// at home, editor here, etc.). created_at is the membership creation
	// time so the ordering reflects "joined this org" rather than
	// "signed up to the platform".
	rows, err := h.DB.Query(r.Context(), `
		SELECT u.id, u.email, COALESCE(u.name,''),
		       COALESCE(m.role,'editor'), m.created_at
		  FROM org_memberships m
		  JOIN users u ON u.id = m.user_id
		 WHERE m.org_id = $1
		 ORDER BY m.role='admin' DESC, m.created_at ASC`, c.OrgID)
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
	// Phase 4: role lives on the membership row, not users.role —
	// users.role is "the role at my primary org" and updating it from
	// a non-primary org would corrupt the user's home permissions.
	// We update the (user, this-org) membership unconditionally, then
	// mirror to users.role only if this org IS the user's primary so
	// the login JWT picks up the change for them on next sign-in.
	ctx := r.Context()
	tx, err := h.DB.Begin(ctx)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(ctx,
		`UPDATE org_memberships SET role=$1 WHERE user_id=$2 AND org_id=$3`,
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
	// Mirror to users.role ONLY when this org is the user's primary
	// (users.org_id == c.OrgID). Otherwise we'd be silently flipping
	// the role they have at their home org, which the admin of *this*
	// org has no business doing.
	if _, err := tx.Exec(ctx,
		`UPDATE users SET role=$1, updated_at=now()
		   WHERE id=$2 AND org_id=$3`,
		role, id, c.OrgID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	events.Publish(ctx, "team.role_changed", c.OrgID, map[string]interface{}{
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
	// Phase 4: removing a member drops the (user, this-org) membership.
	// The user row only goes away if this was the user's ONLY remaining
	// membership AND this org was their primary. Without that guard a
	// cross-org member who joined org B from primary org A would
	// vanish entirely from org A the moment org B's admin removed
	// them — that's data loss.
	//
	// Three cases to handle:
	//   1. Cross-org member (users.org_id != c.OrgID):
	//        DELETE membership only. Their primary org keeps them.
	//   2. Native member with other memberships:
	//        DELETE membership, repoint users.org_id to one of their
	//        remaining orgs (oldest membership) so login still works.
	//        users.role gets the role from that membership.
	//   3. Native member, no other memberships:
	//        DELETE the user row outright (legacy single-org behavior).
	//        ON DELETE CASCADE on org_memberships cleans the membership.
	ctx := r.Context()
	tx, err := h.DB.Begin(ctx)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(ctx)

	// Lookup the target's primary org first — we need it to branch.
	var primaryOrgID string
	if err := tx.QueryRow(ctx,
		`SELECT org_id FROM users WHERE id=$1 FOR UPDATE`, id,
	).Scan(&primaryOrgID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, 404, "not_found", "member not found")
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	// Drop the membership row first. If the row didn't exist the
	// target wasn't actually a member of this org (stale UI state),
	// which is a 404 not a 500.
	tag, err := tx.Exec(ctx,
		`DELETE FROM org_memberships WHERE user_id=$1 AND org_id=$2`,
		id, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "member not found")
		return
	}

	if primaryOrgID == c.OrgID {
		// The target's primary IS this org. Find a fallback membership
		// to repoint at — oldest remaining wins so behavior is stable.
		var (
			fallbackOrgID string
			fallbackRole  string
		)
		err := tx.QueryRow(ctx, `
			SELECT org_id, role FROM org_memberships
			 WHERE user_id=$1
			 ORDER BY created_at ASC
			 LIMIT 1`, id,
		).Scan(&fallbackOrgID, &fallbackRole)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			// No memberships left — this was their last org. Delete
			// the user row to keep the legacy single-org cleanup
			// behavior (and avoid orphaned users with NULL org_id).
			if _, err := tx.Exec(ctx,
				`DELETE FROM users WHERE id=$1`, id,
			); err != nil {
				writeErr(w, 500, "db_error", err.Error())
				return
			}
		case err != nil:
			writeErr(w, 500, "db_error", err.Error())
			return
		default:
			// Repoint to the fallback org. users.role is the role at
			// primary, so it follows the new primary's membership row.
			if _, err := tx.Exec(ctx,
				`UPDATE users SET org_id=$1, role=$2, updated_at=now()
				   WHERE id=$3`,
				fallbackOrgID, fallbackRole, id,
			); err != nil {
				writeErr(w, 500, "db_error", err.Error())
				return
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	events.Publish(ctx, "team.member_removed", c.OrgID, map[string]interface{}{
		"userId": id,
	})
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ResetMFA clears a teammate's enrolled TOTP secret so they can sign in with
// just their password and re-enroll. Admin-only and org-scoped — refuses if
// the target user belongs to a different workspace. Audited.
func (h *Handler) ResetMFA(w http.ResponseWriter, r *http.Request) {
	c, err := adminOnly(r)
	if err != nil {
		writeErr(w, 403, "forbidden", err.Error())
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeErr(w, 400, "missing_id", "user id required")
		return
	}

	// Verify the target is a member of this org before touching their
	// MFA row. Phase 4: scope check via org_memberships so cross-org
	// members are reachable by their host org's admin (they wouldn't
	// be by a `users.org_id=$2` check, since their primary points
	// elsewhere).
	var targetEmail string
	err = h.DB.QueryRow(r.Context(), `
		SELECT u.email
		  FROM users u
		  JOIN org_memberships m ON m.user_id = u.id
		 WHERE u.id = $1 AND m.org_id = $2`,
		id, c.OrgID,
	).Scan(&targetEmail)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, 404, "not_found", "member not found")
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	// Delete the TOTP secret + recovery codes. No-op if the user didn't have
	// MFA enabled — still return ok so the UI can show a clean confirmation.
	tag, err := h.DB.Exec(r.Context(),
		`DELETE FROM two_factor_secrets WHERE user_id=$1`, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	// Audit: record who reset MFA for whom. Critical for security forensics —
	// an admin resetting another admin's 2FA should be scrutinisable later.
	if h.Auth != nil && h.Auth.AuditFn != nil {
		h.Auth.AuditFn(r.Context(), "mfa.admin_reset",
			c.UserID, c.OrgID, c.Email,
			clientIP(r), r.UserAgent(),
			map[string]any{
				"targetUserId": id,
				"targetEmail":  targetEmail,
				"hadMFA":       tag.RowsAffected() > 0,
			})
	}

	writeJSON(w, 200, map[string]any{
		"ok":     true,
		"hadMFA": tag.RowsAffected() > 0,
	})
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
	// Personal workspaces are sealed against invites by design — the
	// "Just me" signup path lands you here and we refuse the moment you
	// try to grow the org. Admins who want to collaborate need to spin up
	// a team org (or convert this one, which is a deliberate, separate
	// admin action — not something we'll do as a side effect of an
	// invite). 409 because the request is well-formed but the org's
	// type forbids the operation.
	var orgKind string
	_ = h.DB.QueryRow(r.Context(),
		`SELECT COALESCE(kind,'team') FROM organizations WHERE id=$1`, c.OrgID,
	).Scan(&orgKind)
	if orgKind == "personal" {
		writeErr(w, 409, "personal_org_no_invites",
			"personal workspaces can't invite teammates — convert to a team workspace first")
		return
	}
	// Reject if this email is already a member of THIS org. Sourced
	// from org_memberships so we catch cross-org members too (a user
	// whose home org is elsewhere but who already joined this one via
	// a previous invite). Email match is case-insensitive because the
	// invite is normalized to lowercase but historical users.email
	// rows preserve whatever casing the user originally typed.
	var exists bool
	_ = h.DB.QueryRow(r.Context(), `
		SELECT EXISTS (
			SELECT 1
			  FROM org_memberships m
			  JOIN users u ON u.id = m.user_id
			 WHERE m.org_id = $1 AND LOWER(u.email) = LOWER($2)
		)`, c.OrgID, email).Scan(&exists)
	if exists {
		writeErr(w, 409, "already_member", "this email is already a team member")
		return
	}
	// Plan seat enforcement. We count active members + pending invites
	// against MaxUsers; the 402 response carries a hint the UI surfaces
	// in the toast so the admin knows to upgrade.
	if err := billing.EnsureSeatAvailable(r.Context(), h.DB, c.OrgID, 1); err != nil {
		if le, ok := billing.IsLimitError(err); ok {
			writeErr(w, le.Status, le.Code, le.Message)
			return
		}
		writeErr(w, 500, "limit_check", err.Error())
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

	// Best-effort send the invite email. The token is single-use and
	// already sitting in the DB, so a delivery failure is recoverable —
	// the admin can re-share the link from /settings/team. We surface
	// an `emailStatus` field in the response so the UI can hint that
	// no mail went out (e.g. when SES isn't configured).
	emailStatus := h.sendInviteEmail(r.Context(), c, email, role, token, *expiresAt, id)

	writeJSON(w, 200, map[string]any{
		"id":          id,
		"token":       token,
		"email":       email,
		"role":        role,
		"createdAt":   createdAt.Format(time.RFC3339),
		"expiresAt":   expiresAt.Format(time.RFC3339),
		"emailStatus": emailStatus,
	})
}

// sendInviteEmail dispatches the invitation email via the central
// Mailer. Returns "sent" / "skipped" / "failed:<reason>" so the
// settings/team page can show the admin what happened without making
// them poke through the audit log.
//
// Copy branches on whether the recipient already has an account:
//   - new user → "set up your account"  (CTA: Accept invitation)
//   - existing user → "sign in to join" (CTA: Sign in to accept)
//
// Both flavors point at /accept/{token} — the page itself decides which
// UI to render based on the same lookup re-run server-side. We compute
// the flag here so the email body matches what the page will show; if
// the user signs up between send-time and click-time, the page silently
// upgrades to the "existing user" CTA and everything still works.
func (h *Handler) sendInviteEmail(
	ctx context.Context,
	c *auth.Claims,
	to, role, token string,
	expiresAt time.Time,
	inviteID string,
) string {
	if h.Mailer == nil {
		return "skipped"
	}
	acceptURL := appURL("/accept/" + token)

	// Best-effort lookup — DB error treats the recipient as new, which
	// is the safer default (the email still says "Accept invitation"
	// and the accept page handles the existing-user 409 path on POST).
	var existing bool
	_ = h.DB.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM users WHERE LOWER(email)=LOWER($1))`,
		to,
	).Scan(&existing)

	subject := c.Email + " invited you to Drive360"
	headline := "You're invited to Drive360"
	intro := `<strong>` + escapeHTML(c.Email) + `</strong> added you as a
		<strong>` + escapeHTML(role) + `</strong> on their workspace.`
	cta := "Accept invitation"
	textIntro := c.Email + " invited you to Drive360 as " + role + "."
	if existing {
		headline = "You've been invited to a new workspace"
		intro = `<strong>` + escapeHTML(c.Email) + `</strong> invited you to
			join their workspace as a <strong>` + escapeHTML(role) + `</strong>.
			Sign in with your existing Drive360 account to accept.`
		cta = "Sign in to accept"
		textIntro = c.Email + " invited you to a new Drive360 workspace as " +
			role + ". Sign in with your existing account to accept."
	}

	html := `<div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px">
  <h2 style="margin:0 0 12px">` + escapeHTML(headline) + `</h2>
  <p>` + intro + `</p>
  <p style="margin:20px 0">
    <a href="` + acceptURL + `"
       style="display:inline-block;background:#0f172a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600">
      ` + escapeHTML(cta) + `
    </a>
  </p>
  <p style="color:#6b7280;font-size:12px">
    This link expires on ` + expiresAt.Format("Jan 2, 2006") + `. If the button
    doesn't work, copy and paste this URL: <br/>
    <code style="font-family:monospace">` + acceptURL + `</code>
  </p>
</div>`
	text := textIntro + "\n" +
		"Accept here: " + acceptURL + "\n" +
		"This link expires on " + expiresAt.Format("Jan 2, 2006") + "."

	_, err := h.Mailer.Send(ctx, NotifyOptions{
		OrgID:    c.OrgID,
		UserID:   c.UserID,
		Kind:     "invitation",
		Source:   "team.create_invite",
		To:       []string{to},
		Subject:  subject,
		HTMLBody: html,
		TextBody: text,
		Metadata: map[string]any{
			"inviteId":     inviteID,
			"role":         role,
			"expiresAt":    expiresAt.Format(time.RFC3339),
			"existingUser": existing,
		},
	})
	if err != nil {
		return "failed:" + err.Error()
	}
	return "sent"
}

func appURL(path string) string {
	base := os.Getenv("APP_URL")
	if base == "" {
		base = "http://localhost:3000"
	}
	return base + path
}

func escapeHTML(s string) string { return htmlpkg.EscapeString(s) }

// ResendInvite rotates the token + extends the expiry on a pending
// invite, then re-mails it. Rotating (vs. just re-mailing the existing
// token) is important: an admin only resends when the original mail
// might be lost or stale, and any old copies of the URL — say, in a
// quoted-back email someone forwarded — should stop working. The new
// expiry is computed the same way as a fresh invite (?expiresInDays
// or 14 day default).
//
// Only acts on truly pending invites: not accepted, not revoked, not
// expired. Already-resolved rows return 410 so the UI can show the
// admin why nothing happened.
func (h *Handler) ResendInvite(w http.ResponseWriter, r *http.Request) {
	c, err := adminOnly(r)
	if err != nil {
		writeErr(w, 403, "forbidden", err.Error())
		return
	}
	id := chi.URLParam(r, "id")

	// Pull the row so we know the email/role to re-send and can detect
	// already-resolved invites with a friendly status code.
	var (
		email, role             string
		acceptedAt, revokedAt   *time.Time
		expiresAt               *time.Time
	)
	err = h.DB.QueryRow(r.Context(), `
		SELECT email, role, accepted_at, revoked_at, expires_at
		  FROM invitations
		 WHERE id=$1 AND org_id=$2`, id, c.OrgID,
	).Scan(&email, &role, &acceptedAt, &revokedAt, &expiresAt)
	if err == pgx.ErrNoRows {
		writeErr(w, 404, "not_found", "invite not found")
		return
	}
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if acceptedAt != nil {
		writeErr(w, 410, "already_accepted", "invite already accepted; nothing to resend")
		return
	}
	if revokedAt != nil {
		writeErr(w, 410, "revoked", "invite was revoked; create a new one instead")
		return
	}

	// Optional ?expiresInDays= override mirrors CreateInvite. Default 14.
	days := 14
	if v := strings.TrimSpace(r.URL.Query().Get("expiresInDays")); v != "" {
		if n, perr := strconv.Atoi(v); perr == nil && n > 0 && n <= 90 {
			days = n
		}
	}
	newExp := time.Now().AddDate(0, 0, days)

	// Mint a fresh token so the previous URL (which may have been
	// forwarded around) stops working as soon as the new mail goes out.
	newToken, err := randomToken()
	if err != nil {
		writeErr(w, 500, "rand", err.Error())
		return
	}

	if _, err := h.DB.Exec(r.Context(), `
		UPDATE invitations
		   SET token = $1, expires_at = $2
		 WHERE id = $3 AND org_id = $4`,
		newToken, newExp, id, c.OrgID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	events.Publish(r.Context(), "team.invite_resent", c.OrgID, map[string]interface{}{
		"inviteId": id, "email": email, "role": role,
	})

	emailStatus := h.sendInviteEmail(r.Context(), c, email, role, newToken, newExp, id)

	writeJSON(w, 200, map[string]any{
		"id":          id,
		"email":       email,
		"role":        role,
		"token":       newToken,
		"expiresAt":   newExp.Format(time.RFC3339),
		"emailStatus": emailStatus,
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
	// ExistingUser tells the accept page which UX to render before the
	// user does anything. true → "Sign in to accept" / "Accept as
	// {email}" depending on the current session; false → the classic
	// "set name + password" registration form. The Accept handler does
	// the same lookup again for security — this field is purely a UX
	// hint that lets us avoid a wasted POST round trip.
	ExistingUser bool `json:"existingUser"`
}

func (h *Handler) ResolvePublic(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	var (
		email, role, orgName             string
		expiresAt, acceptedAt, revokedAt *time.Time
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
	// Best-effort lookup — a DB hiccup here just falls back to the
	// new-user UX, which still works (the Accept handler's 409 will
	// kick in if the user actually exists). Case-insensitive match
	// for the same reason as the Accept handler.
	var existingUser bool
	_ = h.DB.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM users WHERE LOWER(email)=LOWER($1))`,
		email,
	).Scan(&existingUser)

	writeJSON(w, 200, publicInviteResp{
		Email:        email,
		Role:         role,
		OrgName:      orgName,
		Expired:      expiresAt != nil && expiresAt.Before(time.Now()),
		Accepted:     acceptedAt != nil,
		Revoked:      revokedAt != nil,
		ExistingUser: existingUser,
	})
}

// acceptReq carries the fields the accept-invite page submits. Both are
// optional at the protocol level — the handler validates per branch:
//
//   - new user (email has no users row): both Name and Password (>=8) are
//     required; this is effectively a registration.
//   - existing user signed in via Bearer (Authorization header): neither
//     field is needed; the JWT proves identity and we just attach a
//     membership.
//   - existing user not signed in (or wrong account): Password must match
//     the existing user's hash; Name is ignored. This is the "sign in to
//     accept" path served when the JWT route 409s.
type acceptReq struct {
	Name     string `json:"name"`
	Password string `json:"password"`
}

// Accept turns an invite token into either a new user + membership (the
// classic flow) or an additional membership row attached to an already-
// existing user (the multi-org flow). The endpoint is on the public
// router — no Middleware — so we manually opportunistically parse a
// Bearer token if one is present.
//
// Token-issuance policy:
//   - New user → mint a session token landing on the inviting org
//     (their primary). Same as before.
//   - Existing user authenticated via Bearer → DO NOT re-issue a token;
//     the caller's existing session continues. The response carries
//     {joinedOrgId, joinedOrgName} so the UI can offer a "Switch to X"
//     CTA. Avoids yanking a signed-in user out of work in progress.
//   - Existing user authenticated via password → mint a token landing on
//     their *current* primary org (users.org_id), not the joined one.
//     Same "offer to switch" UX as the Bearer path.
func (h *Handler) Accept(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	var req acceptReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
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
		invID, orgID, email, role        string
		expiresAt, acceptedAt, revokedAt *time.Time
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
	// Re-check the seat limit at acceptance time. The org may have
	// downgraded between sending and accepting the invite, in which
	// case we let the admin (not the new joiner) upgrade.
	if err := billing.EnsureSeatAvailable(ctx, h.DB, orgID, 1); err != nil {
		if le, ok := billing.IsLimitError(err); ok {
			writeErr(w, le.Status, le.Code, le.Message)
			return
		}
	}
	if expiresAt != nil && expiresAt.Before(time.Now()) {
		writeErr(w, 410, "expired", "this invitation has expired")
		return
	}

	// Look the email up in users — if found, this is the multi-org branch
	// and we attach a membership instead of creating a new user. We use a
	// case-insensitive match because invites are stored lowercased
	// (CreateInvite normalizes), but historical user rows from auth.Register
	// were saved with whatever casing the user typed.
	var (
		existingUserID  string
		existingHash    string
		existingName    string
		existingOrgID   string
		existingRole    string
	)
	err = tx.QueryRow(ctx, `
		SELECT id, password_hash, COALESCE(name,''),
		       org_id, COALESCE(role,'editor')
		  FROM users WHERE LOWER(email)=LOWER($1) FOR UPDATE`,
		email,
	).Scan(&existingUserID, &existingHash, &existingName, &existingOrgID, &existingRole)
	if err != nil && err != pgx.ErrNoRows {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	var (
		userID         string
		userName       string
		landingOrgID   string // org_id encoded into the issued JWT
		landingRole    string // role for that org
		isExisting     bool
		usedBearerAuth bool
	)

	if existingUserID != "" {
		// --- existing-user branch ---------------------------------------
		isExisting = true
		userID = existingUserID
		userName = existingName
		landingOrgID = existingOrgID
		landingRole = existingRole

		// Try the Bearer JWT first. If the caller is already signed in as
		// the invitee, we don't need to re-prompt for a password. The
		// claims must match the user we just looked up — a token issued
		// for someone else can't be used to claim this invite.
		if authz := r.Header.Get("Authorization"); strings.HasPrefix(authz, "Bearer ") {
			raw := strings.TrimPrefix(authz, "Bearer ")
			if claims, perr := h.Auth.ParseToken(raw); perr == nil && claims.UserID == existingUserID {
				usedBearerAuth = true
				landingOrgID = claims.OrgID
				landingRole = claims.Role
			}
		}

		if !usedBearerAuth {
			// No valid Bearer — fall back to password verification. If
			// the client didn't send one, return 409 so the UI can swap
			// to a "Sign in to accept" view rather than treating this as
			// a generic credentials error.
			if req.Password == "" {
				writeJSON(w, 409, map[string]any{
					"error": map[string]string{
						"code":    "existing_user_auth_required",
						"message": "an account already exists for this email; sign in to accept the invite",
					},
					"existingUser": true,
					"email":        email,
				})
				return
			}
			if bcrypt.CompareHashAndPassword([]byte(existingHash), []byte(req.Password)) != nil {
				writeErr(w, 401, "invalid_credentials", "wrong password for this email")
				return
			}
		}
	} else {
		// --- new-user branch (classic flow) -----------------------------
		if len(req.Password) < 8 {
			writeErr(w, 400, "short_password", "password must be at least 8 characters")
			return
		}
		if strings.TrimSpace(req.Name) == "" {
			writeErr(w, 400, "missing_name", "name is required")
			return
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
		if err != nil {
			writeErr(w, 500, "hash", err.Error())
			return
		}
		userName = strings.TrimSpace(req.Name)
		err = tx.QueryRow(ctx, `
			INSERT INTO users (org_id, email, password_hash, name, role)
			VALUES ($1,$2,$3,$4,$5)
			RETURNING id
		`, orgID, email, string(hash), userName, role).Scan(&userID)
		if err != nil {
			writeErr(w, 400, "create_failed", err.Error())
			return
		}
		// New user lands directly in the inviting org — that org IS their
		// primary, so the membership row mirrors users.org_id.
		landingOrgID = orgID
		landingRole = role
	}

	// Membership row: idempotent so a second click on a stale link can't
	// 500 on a duplicate-key. Source distinguishes "this user's home org"
	// from "an additional org they joined later" — useful when an admin
	// later wants to reason about who-is-natively-where.
	membershipSource := "invite"
	if !isExisting {
		membershipSource = "primary"
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO org_memberships (user_id, org_id, role, source)
		VALUES ($1,$2,$3,$4)
		ON CONFLICT (user_id, org_id) DO NOTHING`,
		userID, orgID, role, membershipSource,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
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

	// Read the joined org's name so the UI can render "Joined Acme" copy
	// without a follow-up call. Best-effort — empty string is fine.
	var joinedOrgName string
	_ = h.DB.QueryRow(ctx, `SELECT name FROM organizations WHERE id=$1`, orgID).Scan(&joinedOrgName)

	events.Publish(ctx, "team.joined", orgID, map[string]interface{}{
		"userId":       userID,
		"email":        email,
		"role":         role,
		"existingUser": isExisting,
	})

	resp := map[string]any{
		"user": map[string]any{
			"id":    userID,
			"email": email,
			"name":  userName,
			"orgId": landingOrgID,
			"role":  landingRole,
		},
		"joinedOrgId":   orgID,
		"joinedOrgName": joinedOrgName,
		"existingUser":  isExisting,
	}
	// Re-issue a token unless the existing user authenticated via Bearer —
	// in that case their session is already valid and we don't want to
	// silently rotate it. The web client treats a missing `token` field
	// as "keep using the one you've got."
	if !usedBearerAuth {
		tok, _ := h.Auth.IssueTokenForUser(userID, landingOrgID, email, landingRole)
		resp["token"] = tok
	}
	writeJSON(w, 200, resp)
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

// Silence unused-import warning on rare paths.
var _ = fmt.Sprintf
