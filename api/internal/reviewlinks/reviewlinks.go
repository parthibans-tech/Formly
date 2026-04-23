// Package reviewlinks lets users invite an external reviewer (no Formly
// account) to preview a template, leave comments, and approve / request
// changes. Reuses the comments + reviews tables for storage; decisions flow
// into the same lifecycle the internal review workflow uses.
package reviewlinks

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/events"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	DB *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Handler { return &Handler{DB: db} }

// -- authenticated admin endpoints ---------------------------------------

type linkDTO struct {
	ID           string  `json:"id"`
	Token        string  `json:"token"`
	TemplateID   string  `json:"templateId"`
	GuestName    string  `json:"guestName,omitempty"`
	GuestEmail   string  `json:"guestEmail,omitempty"`
	Status       string  `json:"status"`
	Active       bool    `json:"active"`
	CreatedAt    string  `json:"createdAt"`
	ExpiresAt    *string `json:"expiresAt,omitempty"`
	DecidedAt    *string `json:"decidedAt,omitempty"`
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	tplID := chi.URLParam(r, "id")
	if !h.ownsTemplate(r.Context(), tplID, c.OrgID) {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, token, template_id, COALESCE(guest_name,''), COALESCE(guest_email,''),
		       status, active, created_at, expires_at, decided_at
		  FROM review_links
		 WHERE template_id=$1 AND org_id=$2
		 ORDER BY created_at DESC`, tplID, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []linkDTO{}
	for rows.Next() {
		var (
			id, token, templateID, name, email, status string
			active                                     bool
			createdAt                                  time.Time
			expiresAt, decidedAt                       *time.Time
		)
		if err := rows.Scan(&id, &token, &templateID, &name, &email, &status,
			&active, &createdAt, &expiresAt, &decidedAt); err != nil {
			continue
		}
		dto := linkDTO{
			ID: id, Token: token, TemplateID: templateID,
			GuestName: name, GuestEmail: email,
			Status: status, Active: active,
			CreatedAt: createdAt.Format(time.RFC3339),
		}
		if expiresAt != nil {
			s := expiresAt.Format(time.RFC3339)
			dto.ExpiresAt = &s
		}
		if decidedAt != nil {
			s := decidedAt.Format(time.RFC3339)
			dto.DecidedAt = &s
		}
		out = append(out, dto)
	}
	writeJSON(w, 200, map[string]any{"links": out})
}

type createReq struct {
	GuestEmail string `json:"guestEmail"`
	GuestName  string `json:"guestName"`
	ExpireIn   int    `json:"expiresInDays,omitempty"`
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	tplID := chi.URLParam(r, "id")
	if !h.ownsTemplate(r.Context(), tplID, c.OrgID) {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	var req createReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err.Error() != "EOF" {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	token, err := randomToken()
	if err != nil {
		writeErr(w, 500, "rand", err.Error())
		return
	}
	days := req.ExpireIn
	if days <= 0 {
		days = 14
	}
	expires := time.Now().AddDate(0, 0, days)

	var id string
	var createdAt time.Time
	err = h.DB.QueryRow(r.Context(), `
		INSERT INTO review_links
		  (org_id, template_id, token, guest_email, guest_name, requested_by, expires_at)
		VALUES ($1,$2,$3, NULLIF($4,''), NULLIF($5,''), $6, $7)
		RETURNING id, created_at`,
		c.OrgID, tplID, token,
		strings.TrimSpace(req.GuestEmail),
		strings.TrimSpace(req.GuestName),
		c.UserID, expires,
	).Scan(&id, &createdAt)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	events.Publish(r.Context(), "review.link_created", c.OrgID, map[string]interface{}{
		"linkId":     id,
		"templateId": tplID,
		"guestEmail": req.GuestEmail,
	})
	writeJSON(w, 200, map[string]any{
		"id": id, "token": token,
		"createdAt": createdAt.Format(time.RFC3339),
		"expiresAt": expires.Format(time.RFC3339),
	})
}

func (h *Handler) Revoke(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	tag, err := h.DB.Exec(r.Context(), `
		UPDATE review_links SET active=false, status='revoked'
		 WHERE id=$1 AND org_id=$2 AND active=true`, id, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "link not found")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// -- public (unauthenticated) guest endpoints ----------------------------

type publicResolveResp struct {
	TemplateID   string `json:"templateId"`
	TemplateName string `json:"templateName"`
	Mode         string `json:"mode"`
	Status       string `json:"status"`
	GuestEmail   string `json:"guestEmail,omitempty"`
	GuestName    string `json:"guestName,omitempty"`
	Decided      bool   `json:"decided"`
}

// Resolve returns the template + link metadata without auth. Guests call this
// to render the review page. The page itself fetches the rendered preview
// via the existing `/v1/templates/{id}/preview` with a short-lived signed URL
// (future work — for now the page renders the comments UI and a link to
// download the last-generated PDF via the template's preview-url).
func (h *Handler) Resolve(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	var (
		linkID, orgID, templateID, templateName, mode, status, guestEmail, guestName string
		active                                                                       bool
		decidedAt, expiresAt                                                         *time.Time
	)
	err := h.DB.QueryRow(r.Context(), `
		SELECT rl.id, rl.org_id, rl.template_id, t.name, t.mode, rl.status,
		       COALESCE(rl.guest_email,''), COALESCE(rl.guest_name,''),
		       rl.active, rl.expires_at, rl.decided_at
		  FROM review_links rl JOIN templates t ON t.id = rl.template_id
		 WHERE rl.token = $1`, token,
	).Scan(&linkID, &orgID, &templateID, &templateName, &mode, &status,
		&guestEmail, &guestName, &active, &expiresAt, &decidedAt)
	if err != nil {
		writeErr(w, 404, "not_found", "review link not found")
		return
	}
	if !active {
		writeErr(w, 410, "revoked", "this review link has been revoked")
		return
	}
	if expiresAt != nil && expiresAt.Before(time.Now()) {
		writeErr(w, 410, "expired", "this review link has expired")
		return
	}
	writeJSON(w, 200, publicResolveResp{
		TemplateID: templateID, TemplateName: templateName, Mode: mode,
		Status: status, GuestEmail: guestEmail, GuestName: guestName,
		Decided: decidedAt != nil,
	})
}

// Comments (public) — list + create comments using guest identity.
func (h *Handler) PublicListComments(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	_, tplID, _, err := h.lookupLink(r.Context(), token)
	if err != nil {
		writeErr(w, 404, "not_found", "review link not found")
		return
	}
	rows, err := h.DB.Query(r.Context(), `
		SELECT c.id, c.parent_id, COALESCE(u.name, c.author_name, 'Guest'),
		       c.anchor, c.body, c.created_at
		  FROM comments c LEFT JOIN users u ON u.id = c.author_id
		 WHERE c.template_id = $1
		 ORDER BY c.created_at ASC`, tplID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			id                       string
			parentID, anchor         *string
			author, body             string
			createdAt                time.Time
		)
		if err := rows.Scan(&id, &parentID, &author, &anchor, &body, &createdAt); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "parentId": parentID, "anchor": anchor,
			"author": author, "body": body,
			"createdAt": createdAt.Format(time.RFC3339),
		})
	}
	writeJSON(w, 200, map[string]any{"comments": out})
}

type publicCommentReq struct {
	Body     string  `json:"body"`
	Anchor   *string `json:"anchor,omitempty"`
	ParentID *string `json:"parentId,omitempty"`
}

func (h *Handler) PublicCreateComment(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	orgID, tplID, link, err := h.lookupLink(r.Context(), token)
	if err != nil {
		writeErr(w, 404, "not_found", "review link not found")
		return
	}
	var req publicCommentReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	body := strings.TrimSpace(req.Body)
	if body == "" {
		writeErr(w, 400, "empty", "comment body is required")
		return
	}
	var id string
	err = h.DB.QueryRow(r.Context(), `
		INSERT INTO comments (org_id, template_id, parent_id, author_email, author_name, anchor, body)
		VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),$6,$7)
		RETURNING id`,
		orgID, tplID, req.ParentID, link.email, link.name, req.Anchor, body,
	).Scan(&id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	events.Publish(r.Context(), "comment.created", orgID, map[string]interface{}{
		"commentId":  id,
		"templateId": tplID,
		"external":   true,
		"guestEmail": link.email,
	})
	writeJSON(w, 200, map[string]any{"id": id})
}

type publicDecideReq struct {
	Decision string `json:"decision"` // approved | changes_requested
	Comment  string `json:"comment,omitempty"`
}

func (h *Handler) PublicDecide(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	orgID, tplID, link, err := h.lookupLink(r.Context(), token)
	if err != nil {
		writeErr(w, 404, "not_found", "review link not found")
		return
	}
	var req publicDecideReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if req.Decision != "approved" && req.Decision != "changes_requested" {
		writeErr(w, 400, "bad_decision", "decision must be 'approved' or 'changes_requested'")
		return
	}

	ctx := r.Context()
	tx, err := h.DB.Begin(ctx)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `
		UPDATE review_links SET status=$1, decision_comment=NULLIF($2,''), decided_at=now(), active=false
		 WHERE id=$3 AND active=true`, req.Decision, req.Comment, link.id); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	// Reflect lifecycle on the template: approved promotes, changes_requested
	// knocks back to draft.
	newStatus := "draft"
	if req.Decision == "approved" {
		newStatus = "approved"
	}
	if _, err := tx.Exec(ctx,
		`UPDATE templates SET status=$1 WHERE id=$2`, newStatus, tplID); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeErr(w, 500, "commit", err.Error())
		return
	}

	events.Publish(ctx, "review.guest_decided", orgID, map[string]interface{}{
		"linkId":         link.id,
		"templateId":     tplID,
		"decision":       req.Decision,
		"guestEmail":     link.email,
		"templateStatus": newStatus,
	})
	writeJSON(w, 200, map[string]any{"ok": true, "templateStatus": newStatus})
}

// -- internals -----------------------------------------------------------

type cachedLink struct {
	id, email, name string
}

func (h *Handler) lookupLink(ctx context.Context, token string) (orgID, tplID string, link cachedLink, err error) {
	var active bool
	var expiresAt *time.Time
	err = h.DB.QueryRow(ctx, `
		SELECT id, org_id, template_id, COALESCE(guest_email,''), COALESCE(guest_name,''),
		       active, expires_at
		  FROM review_links WHERE token=$1`, token,
	).Scan(&link.id, &orgID, &tplID, &link.email, &link.name, &active, &expiresAt)
	if err != nil {
		return
	}
	if !active {
		err = errHidden("revoked")
		return
	}
	if expiresAt != nil && expiresAt.Before(time.Now()) {
		err = errHidden("expired")
		return
	}
	return
}

type errHidden string

func (e errHidden) Error() string { return string(e) }

func (h *Handler) ownsTemplate(ctx context.Context, tplID, orgID string) bool {
	var owner string
	err := h.DB.QueryRow(ctx, `SELECT org_id FROM templates WHERE id=$1`, tplID).Scan(&owner)
	return err == nil && owner == orgID
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
