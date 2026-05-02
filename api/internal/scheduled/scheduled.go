// Package scheduled manages cron-driven generation jobs.
//
// Architecture:
//   - HTTP handlers do standard CRUD on `scheduled_jobs`.
//   - The worker process calls `Tick(ctx)` on a 60-second timer. Each tick
//     finds rows with `next_run_at <= now()`, enqueues a generate task per
//     row, and advances `next_run_at` to the next matching cron instant.
//   - No external scheduler service — one DB table is the source of truth
//     so restarts don't miss or double-fire schedules.
package scheduled

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/jobs"
	"github.com/docforge/api/internal/queue"
	"github.com/go-chi/chi/v5"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/robfig/cron/v3"
)

type Handler struct {
	DB    *pgxpool.Pool
	Queue *asynq.Client
}

func New(db *pgxpool.Pool, q *asynq.Client) *Handler {
	return &Handler{DB: db, Queue: q}
}

// -- cron helpers --------------------------------------------------------

// parser accepts both 5-field and 6-field (with seconds) expressions.
var parser = cron.NewParser(
	cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor,
)

func parseCron(expr, tz string) (*time.Time, error) {
	expr = strings.TrimSpace(expr)
	if expr == "" {
		return nil, fmt.Errorf("cron expression is required")
	}
	sched, err := parser.Parse(expr)
	if err != nil {
		return nil, err
	}
	loc := time.UTC
	if tz != "" {
		l, err := time.LoadLocation(tz)
		if err == nil {
			loc = l
		}
	}
	next := sched.Next(time.Now().In(loc))
	return &next, nil
}

// -- HTTP handlers -------------------------------------------------------

type scheduleDTO struct {
	ID         string `json:"id"`
	TemplateID string `json:"templateId"`
	Name       string `json:"name"`
	Cron       string `json:"cron"`
	Timezone   string `json:"timezone"`
	Active     bool   `json:"active"`
	Data       any    `json:"data"`
	NextRunAt  string `json:"nextRunAt,omitempty"`
	LastRunAt  string `json:"lastRunAt,omitempty"`
	CreatedAt  string `json:"createdAt"`
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	tplFilter := r.URL.Query().Get("template")
	var rows *pgxpoolRows
	if tplFilter != "" {
		rs, err := h.DB.Query(r.Context(), `
			SELECT id, template_id, name, cron_expr, timezone, active, data, next_run_at, last_run_at, created_at
			  FROM scheduled_jobs WHERE org_id=$1 AND template_id=$2
			 ORDER BY created_at DESC`, c.OrgID, tplFilter)
		if err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		rows = &pgxpoolRows{rs}
	} else {
		rs, err := h.DB.Query(r.Context(), `
			SELECT id, template_id, name, cron_expr, timezone, active, data, next_run_at, last_run_at, created_at
			  FROM scheduled_jobs WHERE org_id=$1
			 ORDER BY created_at DESC`, c.OrgID)
		if err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		rows = &pgxpoolRows{rs}
	}
	defer rows.Close()
	out := []scheduleDTO{}
	for rows.Next() {
		var (
			id, templateID, name, expr, tz string
			active                         bool
			dataRaw                        []byte
			nextAt, lastAt                 *time.Time
			createdAt                      time.Time
		)
		if err := rows.Scan(&id, &templateID, &name, &expr, &tz, &active, &dataRaw, &nextAt, &lastAt, &createdAt); err != nil {
			continue
		}
		var data any
		_ = json.Unmarshal(dataRaw, &data)
		dto := scheduleDTO{
			ID: id, TemplateID: templateID, Name: name, Cron: expr, Timezone: tz,
			Active: active, Data: data,
			CreatedAt: createdAt.Format(time.RFC3339),
		}
		if nextAt != nil {
			dto.NextRunAt = nextAt.Format(time.RFC3339)
		}
		if lastAt != nil {
			dto.LastRunAt = lastAt.Format(time.RFC3339)
		}
		out = append(out, dto)
	}
	writeJSON(w, 200, map[string]any{"schedules": out})
}

type createReq struct {
	TemplateID string                 `json:"templateId"`
	Name       string                 `json:"name"`
	Cron       string                 `json:"cron"`
	Timezone   string                 `json:"timezone"`
	Data       map[string]interface{} `json:"data"`
	Active     *bool                  `json:"active"`
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	var req createReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	req.TemplateID = strings.TrimSpace(req.TemplateID)
	req.Name = strings.TrimSpace(req.Name)
	if req.TemplateID == "" || req.Cron == "" {
		writeErr(w, 400, "missing", "templateId and cron are required")
		return
	}
	if req.Name == "" {
		req.Name = "Scheduled run"
	}
	tz := req.Timezone
	if tz == "" {
		tz = "UTC"
	}
	// Ownership check.
	var orgOwner string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT org_id FROM templates WHERE id=$1`, req.TemplateID).Scan(&orgOwner); err != nil {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	if orgOwner != c.OrgID {
		writeErr(w, 404, "not_found", "template not found")
		return
	}

	nextAt, err := parseCron(req.Cron, tz)
	if err != nil {
		writeErr(w, 400, "bad_cron", err.Error())
		return
	}
	active := true
	if req.Active != nil {
		active = *req.Active
	}
	dataRaw, _ := json.Marshal(req.Data)

	var id string
	err = h.DB.QueryRow(r.Context(), `
		INSERT INTO scheduled_jobs
		  (org_id, user_id, template_id, name, cron_expr, timezone, data, active, next_run_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		RETURNING id
	`, c.OrgID, c.UserID, req.TemplateID, req.Name, req.Cron, tz, dataRaw, active, nextAt).Scan(&id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{
		"id":        id,
		"nextRunAt": nextAt.Format(time.RFC3339),
	})
}

type updateReq struct {
	Name     *string                 `json:"name,omitempty"`
	Cron     *string                 `json:"cron,omitempty"`
	Timezone *string                 `json:"timezone,omitempty"`
	Data     *map[string]interface{} `json:"data,omitempty"`
	Active   *bool                   `json:"active,omitempty"`
}

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	var req updateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	// Re-parse cron if it's changing, to refresh next_run_at.
	var nextAt *time.Time
	if req.Cron != nil || req.Timezone != nil {
		var (
			curCron, curTZ string
		)
		if err := h.DB.QueryRow(r.Context(),
			`SELECT cron_expr, timezone FROM scheduled_jobs WHERE id=$1 AND org_id=$2`, id, c.OrgID,
		).Scan(&curCron, &curTZ); err != nil {
			writeErr(w, 404, "not_found", "schedule not found")
			return
		}
		expr := curCron
		if req.Cron != nil {
			expr = *req.Cron
		}
		tz := curTZ
		if req.Timezone != nil {
			tz = *req.Timezone
		}
		parsed, err := parseCron(expr, tz)
		if err != nil {
			writeErr(w, 400, "bad_cron", err.Error())
			return
		}
		nextAt = parsed
	}

	var dataRaw []byte
	if req.Data != nil {
		dataRaw, _ = json.Marshal(*req.Data)
	}
	_, err := h.DB.Exec(r.Context(), `
		UPDATE scheduled_jobs SET
		  name         = COALESCE($3, name),
		  cron_expr    = COALESCE($4, cron_expr),
		  timezone     = COALESCE($5, timezone),
		  active       = COALESCE($6, active),
		  data         = COALESCE($7::jsonb, data),
		  next_run_at  = COALESCE($8, next_run_at),
		  updated_at   = now()
		 WHERE id=$1 AND org_id=$2`,
		id, c.OrgID, req.Name, req.Cron, req.Timezone, req.Active, dataRaw, nextAt,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	tag, err := h.DB.Exec(r.Context(),
		`DELETE FROM scheduled_jobs WHERE id=$1 AND org_id=$2`, id, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "schedule not found")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (h *Handler) Runs(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	// ownership
	var owner string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT org_id FROM scheduled_jobs WHERE id=$1`, id).Scan(&owner); err != nil || owner != c.OrgID {
		writeErr(w, 404, "not_found", "schedule not found")
		return
	}
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, status, output_file_id, error, fired_at, finished_at
		  FROM scheduled_runs WHERE schedule_id=$1
		 ORDER BY fired_at DESC LIMIT 50`, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			rid, status       string
			outputFileID      *string
			errStr            *string
			firedAt           time.Time
			finishedAt        *time.Time
		)
		if err := rows.Scan(&rid, &status, &outputFileID, &errStr, &firedAt, &finishedAt); err != nil {
			continue
		}
		entry := map[string]any{
			"id":           rid,
			"status":       status,
			"outputFileId": outputFileID,
			"error":        errStr,
			"firedAt":      firedAt.Format(time.RFC3339),
		}
		if finishedAt != nil {
			entry["finishedAt"] = finishedAt.Format(time.RFC3339)
		}
		out = append(out, entry)
	}
	writeJSON(w, 200, map[string]any{"runs": out})
}

// -- worker tick ---------------------------------------------------------

// Tick advances due schedules: for each active row with next_run_at <= now(),
// atomically mark it "claimed" (bump next_run_at to the next cron instant so
// concurrent ticks can't double-fire), enqueue a generate task, and record a
// scheduled_runs row. Returns the number of schedules fired.
func (h *Handler) Tick(ctx context.Context) (int, error) {
	if h.Queue == nil {
		return 0, nil
	}
	// Pull due rows. We advance next_run_at within the transaction for each row
	// to prevent double-firing if ticks overlap.
	rows, err := h.DB.Query(ctx, `
		SELECT id, org_id, user_id, template_id, cron_expr, timezone, data
		  FROM scheduled_jobs
		 WHERE active=true AND next_run_at IS NOT NULL AND next_run_at <= now()
		 FOR UPDATE SKIP LOCKED
		 LIMIT 50`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	fired := 0
	for rows.Next() {
		var (
			id, orgID, userID, templateID, expr, tz string
			dataRaw                                 []byte
		)
		if err := rows.Scan(&id, &orgID, &userID, &templateID, &expr, &tz, &dataRaw); err != nil {
			continue
		}
		var data map[string]interface{}
		_ = json.Unmarshal(dataRaw, &data)

		next, err := parseCron(expr, tz)
		if err != nil {
			// malformed; mark inactive so we don't spin.
			_, _ = h.DB.Exec(ctx, `UPDATE scheduled_jobs SET active=false WHERE id=$1`, id)
			continue
		}

		// Create a job row so /v1/jobs/{id} works for UI progress.
		jobID, err := jobs.Create(ctx, h.DB, orgID, userID, templateID, "one", 0)
		if err != nil {
			continue
		}

		// Record the run (optimistically as "running"; the async task updates
		// jobs.status, which the UI polls — we keep this row as an audit
		// shortcut for the schedules UI).
		_, _ = h.DB.Exec(ctx, `
			INSERT INTO scheduled_runs (schedule_id, template_id, status)
			VALUES ($1,$2,'running')
		`, id, templateID)

		// Enqueue the generate task.
		task, err := queue.NewGenerateOne(queue.GenerateOnePayload{
			JobID:      jobID,
			OrgID:      orgID,
			UserID:     userID,
			TemplateID: templateID,
			Data:       data,
			// Flatten left nil so the runner honours the template's
			// output.flattenDefault — scheduled runs are unattended,
			// so per-template policy is the right place to decide.
		})
		if err == nil {
			_, _ = h.Queue.EnqueueContext(ctx, task)
		}

		// Advance the row so we don't re-fire on the next tick.
		_, _ = h.DB.Exec(ctx, `
			UPDATE scheduled_jobs
			   SET last_run_at=now(), next_run_at=$2, updated_at=now()
			 WHERE id=$1`, id, next)

		fired++
	}
	return fired, nil
}

// -- helpers -------------------------------------------------------------

// pgxpoolRows is a tiny alias so the code reads uniformly regardless of
// which concrete type we got back from Query.
type pgxpoolRows struct {
	r interface {
		Next() bool
		Scan(dst ...any) error
		Close()
	}
}

func (p *pgxpoolRows) Next() bool                  { return p.r.Next() }
func (p *pgxpoolRows) Scan(dst ...any) error       { return p.r.Scan(dst...) }
func (p *pgxpoolRows) Close()                      { p.r.Close() }

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
