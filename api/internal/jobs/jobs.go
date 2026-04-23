package jobs

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct{ DB *pgxpool.Pool }

func New(db *pgxpool.Pool) *Handler { return &Handler{DB: db} }

type jobDTO struct {
	ID           string     `json:"id"`
	Kind         string     `json:"kind"`
	Status       string     `json:"status"`
	TemplateID   string     `json:"templateId"`
	Total        int        `json:"total"`
	Done         int        `json:"done"`
	OutputFileID *string    `json:"outputFileId,omitempty"`
	Error        *string    `json:"error,omitempty"`
	CreatedAt    time.Time  `json:"createdAt"`
	StartedAt    *time.Time `json:"startedAt,omitempty"`
	FinishedAt   *time.Time `json:"finishedAt,omitempty"`
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")

	var j jobDTO
	err := h.DB.QueryRow(r.Context(),
		`SELECT id, kind, status, template_id, total, done, output_file_id, error, created_at, started_at, finished_at
		 FROM generation_jobs WHERE id=$1 AND org_id=$2`, id, c.OrgID,
	).Scan(&j.ID, &j.Kind, &j.Status, &j.TemplateID, &j.Total, &j.Done, &j.OutputFileID, &j.Error, &j.CreatedAt, &j.StartedAt, &j.FinishedAt)
	if err != nil {
		writeErr(w, 404, "not_found", "job not found")
		return
	}
	writeJSON(w, 200, j)
}

// Create inserts a queued job row and returns its ID. Used by enqueue helpers.
func Create(ctx context.Context, db *pgxpool.Pool, orgID, userID, templateID, kind string, total int) (string, error) {
	var id string
	err := db.QueryRow(ctx,
		`INSERT INTO generation_jobs (org_id, actor_id, template_id, kind, total) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		orgID, userID, templateID, kind, total,
	).Scan(&id)
	return id, err
}

func MarkRunning(ctx context.Context, db *pgxpool.Pool, jobID string) error {
	_, err := db.Exec(ctx,
		`UPDATE generation_jobs SET status='running', started_at=now() WHERE id=$1`, jobID,
	)
	return err
}

func MarkDone(ctx context.Context, db *pgxpool.Pool, jobID, outputFileID string, done int) error {
	_, err := db.Exec(ctx,
		`UPDATE generation_jobs SET status='completed', output_file_id=$1, done=$2, finished_at=now() WHERE id=$3`,
		outputFileID, done, jobID,
	)
	return err
}

func MarkFailed(ctx context.Context, db *pgxpool.Pool, jobID, errStr string) error {
	_, err := db.Exec(ctx,
		`UPDATE generation_jobs SET status='failed', error=$1, finished_at=now() WHERE id=$2`,
		errStr, jobID,
	)
	return err
}

func UpdateProgress(ctx context.Context, db *pgxpool.Pool, jobID string, done int) error {
	_, err := db.Exec(ctx,
		`UPDATE generation_jobs SET done=$1 WHERE id=$2`, done, jobID,
	)
	return err
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
