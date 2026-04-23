// Package reviews implements the template review & approval workflow.
//
// Lifecycle:
//
//	draft → (request review)        → in_review
//	in_review → (reviewer approves) → approved
//	in_review → (changes requested) → draft   (with a pending review log)
//	approved → (subsequent edit)    → draft   (auto-reset on save, optional)
package reviews

import (
	"context"
	"encoding/json"
	"net/http"
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

type reviewDTO struct {
	ID          string  `json:"id"`
	TemplateID  string  `json:"templateId"`
	Version     int     `json:"version"`
	Status      string  `json:"status"`
	Comment     *string `json:"comment,omitempty"`
	RequestedBy string  `json:"requestedBy"`
	Reviewer    string  `json:"reviewer"`
	ReviewerID  string  `json:"reviewerId"`
	CreatedAt   string  `json:"createdAt"`
	DecidedAt   *string `json:"decidedAt,omitempty"`
}

// -- list / my inbox ------------------------------------------------------

func (h *Handler) ListForTemplate(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	tplID := chi.URLParam(r, "id")
	if !h.ownsTemplate(r.Context(), tplID, c.OrgID) {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	rows, err := h.DB.Query(r.Context(), `
		SELECT r.id, r.template_id, r.version, r.status, r.comment,
		       COALESCE(rb.name, rb.email), COALESCE(rv.name, rv.email), r.reviewer_id,
		       r.created_at, r.decided_at
		  FROM reviews r
		  LEFT JOIN users rb ON rb.id = r.requested_by
		  LEFT JOIN users rv ON rv.id = r.reviewer_id
		 WHERE r.template_id = $1
		 ORDER BY r.created_at DESC`, tplID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	writeJSON(w, 200, map[string]any{"reviews": scanReviews(rows)})
}

// Inbox returns reviews assigned to the caller that are still pending.
func (h *Handler) Inbox(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	rows, err := h.DB.Query(r.Context(), `
		SELECT r.id, r.template_id, r.version, r.status, r.comment,
		       COALESCE(rb.name, rb.email), COALESCE(rv.name, rv.email), r.reviewer_id,
		       r.created_at, r.decided_at
		  FROM reviews r
		  LEFT JOIN users rb ON rb.id = r.requested_by
		  LEFT JOIN users rv ON rv.id = r.reviewer_id
		 WHERE r.reviewer_id = $1 AND r.org_id = $2 AND r.status = 'pending'
		 ORDER BY r.created_at DESC`, c.UserID, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	writeJSON(w, 200, map[string]any{"reviews": scanReviews(rows)})
}

// -- request / decide ----------------------------------------------------

type requestReq struct {
	ReviewerID string `json:"reviewerId"`
	Comment    string `json:"comment,omitempty"`
}

func (h *Handler) Request(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	tplID := chi.URLParam(r, "id")
	if !h.ownsTemplate(r.Context(), tplID, c.OrgID) {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	var req requestReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if req.ReviewerID == "" {
		writeErr(w, 400, "missing_reviewer", "reviewerId is required")
		return
	}
	// Validate reviewer is in the same org.
	var reviewerOrg string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT org_id FROM users WHERE id=$1`, req.ReviewerID).Scan(&reviewerOrg); err != nil {
		writeErr(w, 400, "bad_reviewer", "reviewer not found")
		return
	}
	if reviewerOrg != c.OrgID {
		writeErr(w, 400, "bad_reviewer", "reviewer must be a teammate")
		return
	}

	// Snapshot the template's current version.
	var version int
	if err := h.DB.QueryRow(r.Context(),
		`SELECT version FROM templates WHERE id=$1`, tplID).Scan(&version); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	var id string
	err := h.DB.QueryRow(r.Context(), `
		INSERT INTO reviews (org_id, template_id, version, requested_by, reviewer_id, comment, status)
		VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),'pending')
		RETURNING id`,
		c.OrgID, tplID, version, c.UserID, req.ReviewerID, req.Comment,
	).Scan(&id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	_, _ = h.DB.Exec(r.Context(),
		`UPDATE templates SET status='in_review' WHERE id=$1 AND org_id=$2`,
		tplID, c.OrgID)

	events.Publish(r.Context(), "review.requested", c.OrgID, map[string]interface{}{
		"reviewId":   id,
		"templateId": tplID,
		"version":    version,
		"reviewerId": req.ReviewerID,
	})
	writeJSON(w, 200, map[string]any{"id": id, "version": version})
}

type decideReq struct {
	Decision string `json:"decision"` // approved | changes_requested
	Comment  string `json:"comment,omitempty"`
}

func (h *Handler) Decide(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	var req decideReq
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

	var tplID, reviewerID, status string
	err = tx.QueryRow(ctx, `
		SELECT template_id, reviewer_id, status
		  FROM reviews WHERE id=$1 AND org_id=$2 FOR UPDATE`,
		id, c.OrgID,
	).Scan(&tplID, &reviewerID, &status)
	if err != nil {
		writeErr(w, 404, "not_found", "review not found")
		return
	}
	if reviewerID != c.UserID {
		writeErr(w, 403, "forbidden", "only the assigned reviewer can decide")
		return
	}
	if status != "pending" {
		writeErr(w, 409, "already_decided", "this review has already been decided")
		return
	}

	if _, err := tx.Exec(ctx, `
		UPDATE reviews SET status=$1, comment=NULLIF($2,''), decided_at=now()
		 WHERE id=$3`, req.Decision, req.Comment, id); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	newTplStatus := "draft"
	if req.Decision == "approved" {
		newTplStatus = "approved"
	}
	if _, err := tx.Exec(ctx,
		`UPDATE templates SET status=$1 WHERE id=$2`, newTplStatus, tplID); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeErr(w, 500, "commit", err.Error())
		return
	}

	events.Publish(ctx, "review.decided", c.OrgID, map[string]interface{}{
		"reviewId":       id,
		"templateId":     tplID,
		"decision":       req.Decision,
		"templateStatus": newTplStatus,
	})
	writeJSON(w, 200, map[string]any{"ok": true, "templateStatus": newTplStatus})
}

// Cancel lets the requester pull back a still-pending review.
func (h *Handler) Cancel(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	var tplID string
	tag, err := h.DB.Exec(r.Context(), `
		UPDATE reviews SET status='cancelled', decided_at=now()
		 WHERE id=$1 AND org_id=$2 AND requested_by=$3 AND status='pending'
		 RETURNING template_id`, id, c.OrgID, c.UserID)
	_ = tplID
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "review not found or not cancelable")
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

type rowsLike interface {
	Next() bool
	Scan(...any) error
	Close()
}

func scanReviews(rows rowsLike) []reviewDTO {
	defer rows.Close()
	out := []reviewDTO{}
	for rows.Next() {
		var (
			id, tid, status, reqBy, reviewer, reviewerID string
			comment                                      *string
			version                                      int
			createdAt                                    time.Time
			decidedAt                                    *time.Time
		)
		if err := rows.Scan(&id, &tid, &version, &status, &comment,
			&reqBy, &reviewer, &reviewerID, &createdAt, &decidedAt); err != nil {
			continue
		}
		dto := reviewDTO{
			ID: id, TemplateID: tid, Version: version,
			Status:      status,
			Comment:     comment,
			RequestedBy: reqBy,
			Reviewer:    reviewer,
			ReviewerID:  reviewerID,
			CreatedAt:   createdAt.Format(time.RFC3339),
		}
		if decidedAt != nil {
			s := decidedAt.Format(time.RFC3339)
			dto.DecidedAt = &s
		}
		out = append(out, dto)
	}
	return out
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
