// Package comments implements threaded template comments + @mentions.
// External guest authors (C6 external reviewers) share this table via the
// author_email / author_name columns when author_id is NULL.
package comments

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/events"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	DB *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Handler { return &Handler{DB: db} }

// -- DTOs -----------------------------------------------------------------

type commentDTO struct {
	ID          string    `json:"id"`
	ParentID    *string   `json:"parentId,omitempty"`
	AuthorID    *string   `json:"authorId,omitempty"`
	AuthorName  string    `json:"authorName"`
	AuthorEmail string    `json:"authorEmail,omitempty"`
	Anchor      *string   `json:"anchor,omitempty"`
	Body        string    `json:"body"`
	Mentions    []string  `json:"mentions,omitempty"`
	ResolvedAt  *string   `json:"resolvedAt,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// -- list / create --------------------------------------------------------

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	tplID := chi.URLParam(r, "id")
	if !h.ownsTemplate(r.Context(), tplID, c.OrgID) {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	rows, err := h.DB.Query(r.Context(), `
		SELECT c.id, c.parent_id, c.author_id, COALESCE(u.name, c.author_name, ''),
		       COALESCE(u.email, c.author_email, ''), c.anchor, c.body,
		       c.resolved_at, c.created_at, c.updated_at,
		       COALESCE(ARRAY_AGG(cm.user_id) FILTER (WHERE cm.user_id IS NOT NULL), '{}')
		  FROM comments c
		  LEFT JOIN users u ON u.id = c.author_id
		  LEFT JOIN comment_mentions cm ON cm.comment_id = c.id
		 WHERE c.template_id = $1
		 GROUP BY c.id, u.name, u.email
		 ORDER BY c.created_at ASC`, tplID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []commentDTO{}
	for rows.Next() {
		var (
			id                              string
			parentID, authorID, anchor      *string
			name, email                     string
			body                            string
			resolvedAt                      *time.Time
			createdAt, updatedAt            time.Time
			mentions                        []string
		)
		if err := rows.Scan(&id, &parentID, &authorID, &name, &email,
			&anchor, &body, &resolvedAt, &createdAt, &updatedAt, &mentions); err != nil {
			continue
		}
		dto := commentDTO{
			ID: id, ParentID: parentID, AuthorID: authorID,
			AuthorName: name, AuthorEmail: email,
			Anchor: anchor, Body: body,
			Mentions: mentions,
			CreatedAt: createdAt, UpdatedAt: updatedAt,
		}
		if resolvedAt != nil {
			s := resolvedAt.Format(time.RFC3339)
			dto.ResolvedAt = &s
		}
		out = append(out, dto)
	}
	writeJSON(w, 200, map[string]any{"comments": out})
}

type createReq struct {
	ParentID *string `json:"parentId,omitempty"`
	Anchor   *string `json:"anchor,omitempty"`
	Body     string  `json:"body"`
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	tplID := chi.URLParam(r, "id")
	if !h.ownsTemplate(r.Context(), tplID, c.OrgID) {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	var req createReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	body := strings.TrimSpace(req.Body)
	if body == "" {
		writeErr(w, 400, "empty", "comment body is required")
		return
	}
	if len(body) > 10000 {
		writeErr(w, 400, "too_long", "comment body is too long")
		return
	}

	ctx := r.Context()
	tx, err := h.DB.Begin(ctx)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(ctx)

	var id string
	var createdAt, updatedAt time.Time
	err = tx.QueryRow(ctx, `
		INSERT INTO comments (org_id, template_id, parent_id, author_id, anchor, body)
		VALUES ($1,$2,$3,$4,$5,$6)
		RETURNING id, created_at, updated_at
	`, c.OrgID, tplID, req.ParentID, c.UserID, req.Anchor, body).
		Scan(&id, &createdAt, &updatedAt)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	// Resolve @mentions against org members.
	mentions, mentionIDs := h.resolveMentions(ctx, tx, c.OrgID, body)
	for _, uid := range mentionIDs {
		_, _ = tx.Exec(ctx,
			`INSERT INTO comment_mentions (comment_id, user_id) VALUES ($1,$2)
			 ON CONFLICT DO NOTHING`, id, uid)
	}
	if err := tx.Commit(ctx); err != nil {
		writeErr(w, 500, "commit", err.Error())
		return
	}

	events.Publish(ctx, "comment.created", c.OrgID, map[string]interface{}{
		"commentId":  id,
		"templateId": tplID,
		"anchor":     req.Anchor,
		"mentions":   mentions,
	})
	for _, uid := range mentionIDs {
		events.Publish(ctx, "comment.mentioned", c.OrgID, map[string]interface{}{
			"commentId":  id,
			"templateId": tplID,
			"userId":     uid,
		})
	}

	writeJSON(w, 200, map[string]any{
		"id":        id,
		"createdAt": createdAt,
		"updatedAt": updatedAt,
		"mentions":  mentionIDs,
	})
}

// -- resolve / delete -----------------------------------------------------

func (h *Handler) Resolve(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	var resolved bool
	if err := json.NewDecoder(r.Body).Decode(&struct {
		Resolved *bool `json:"resolved"`
	}{&resolved}); err != nil {
		// default to toggling on
		resolved = true
	}

	sql := `UPDATE comments SET resolved_at=now()
	         WHERE id=$1 AND org_id=$2`
	if !resolved {
		sql = `UPDATE comments SET resolved_at=NULL
		        WHERE id=$1 AND org_id=$2`
	}
	if _, err := h.DB.Exec(r.Context(), sql, id, c.OrgID); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "resolved": resolved})
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	tag, err := h.DB.Exec(r.Context(),
		`DELETE FROM comments
		  WHERE id=$1 AND org_id=$2
		    AND (author_id=$3 OR EXISTS(
		         SELECT 1 FROM users WHERE id=$3 AND role='admin'))`,
		id, c.OrgID, c.UserID,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 403, "forbidden", "only the author or an admin can delete this comment")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// -- mentions inbox -------------------------------------------------------

func (h *Handler) Mentions(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	rows, err := h.DB.Query(r.Context(), `
		SELECT c.id, c.template_id, t.name, c.body, COALESCE(au.name, c.author_name, ''),
		       c.created_at, cm.read_at
		  FROM comment_mentions cm
		  JOIN comments c ON c.id = cm.comment_id
		  JOIN templates t ON t.id = c.template_id
		  LEFT JOIN users au ON au.id = c.author_id
		 WHERE cm.user_id = $1 AND c.org_id = $2
		 ORDER BY c.created_at DESC
		 LIMIT 100`, c.UserID, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			cid, tid, tname, body, author string
			createdAt                     time.Time
			readAt                        *time.Time
		)
		if err := rows.Scan(&cid, &tid, &tname, &body, &author, &createdAt, &readAt); err != nil {
			continue
		}
		row := map[string]any{
			"commentId":    cid,
			"templateId":   tid,
			"templateName": tname,
			"body":         body,
			"author":       author,
			"createdAt":    createdAt.Format(time.RFC3339),
			"read":         readAt != nil,
		}
		out = append(out, row)
	}
	writeJSON(w, 200, map[string]any{"mentions": out})
}

func (h *Handler) MarkAllRead(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	_, err := h.DB.Exec(r.Context(),
		`UPDATE comment_mentions SET read_at=now()
		  WHERE user_id=$1 AND read_at IS NULL`, c.UserID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// -- internals ------------------------------------------------------------

func (h *Handler) ownsTemplate(ctx context.Context, tplID, orgID string) bool {
	var owner string
	err := h.DB.QueryRow(ctx, `SELECT org_id FROM templates WHERE id=$1`, tplID).Scan(&owner)
	return err == nil && owner == orgID
}

// mentionRE matches @handles — the local part of an email ("alice" in alice@acme.com)
// or an @"first last" bracketed form.
var mentionRE = regexp.MustCompile(`@([A-Za-z0-9._-]+)`)

// resolveMentions finds @names in the body and matches them to org members
// by email local part, then by exact name. Returns display names + user IDs.
func (h *Handler) resolveMentions(ctx context.Context, tx pgx.Tx, orgID, body string) ([]string, []string) {
	hits := mentionRE.FindAllStringSubmatch(body, -1)
	if len(hits) == 0 {
		return nil, nil
	}
	seen := map[string]bool{}
	names := []string{}
	ids := []string{}
	for _, m := range hits {
		tok := strings.ToLower(m[1])
		if seen[tok] {
			continue
		}
		seen[tok] = true
		var uid, name string
		err := tx.QueryRow(ctx, `
			SELECT id, COALESCE(name, email)
			  FROM users
			 WHERE org_id=$1
			   AND (lower(split_part(email, '@', 1)) = $2
			        OR lower(name) = $2)
			 LIMIT 1`, orgID, tok,
		).Scan(&uid, &name)
		if err == nil {
			ids = append(ids, uid)
			names = append(names, name)
		}
	}
	return names, ids
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
