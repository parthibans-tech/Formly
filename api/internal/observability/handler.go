package observability

import (
	"encoding/json"
	"net/http"
	"runtime"
	"sort"
	"strconv"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/go-chi/chi/v5"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Handler serves /healthz, /metrics (lightweight), and /v1/ops/*.
type Handler struct {
	DB       *pgxpool.Pool
	Agg      *Aggregator
	Checker  *Checker
	Redis    asynq.RedisConnOpt
	Started  time.Time
	Version  string
}

// New wires the handler. started should be the process start timestamp so
// /v1/ops/summary can report uptime.
func New(db *pgxpool.Pool, agg *Aggregator, ck *Checker, redis asynq.RedisConnOpt) *Handler {
	return &Handler{
		DB:      db,
		Agg:     agg,
		Checker: ck,
		Redis:   redis,
		Started: time.Now(),
		Version: "1.0.0",
	}
}

// Mount attaches the admin-protected ops routes.
func (h *Handler) Mount(r chi.Router) {
	r.Get("/v1/ops/summary", h.Summary)
	r.Get("/v1/ops/health", h.Health)
	r.Get("/v1/ops/queue", h.Queue)
	r.Get("/v1/ops/jobs", h.Jobs)
	r.Get("/v1/ops/metrics", h.MetricsJSON)
	r.Get("/v1/ops/errors", h.Errors)
	r.Get("/v1/ops/health-history", h.HealthHistory)
}

/* ------------------------------------------------------------------ */
/*  /healthz and /metrics — public (unauthenticated) so probes can hit */
/*  them without a token. Kept separate from the admin ops routes.    */
/* ------------------------------------------------------------------ */

// DeepHealth is a public endpoint safe for load-balancer probes; it returns
// 200 when every component is ok/degraded and 503 on any down result.
func (h *Handler) DeepHealth(w http.ResponseWriter, r *http.Request) {
	results := h.Checker.Check(r.Context())
	status := "ok"
	code := 200
	for _, c := range results {
		if c.Status == "down" {
			status = "down"
			code = 503
			break
		}
		if c.Status == "degraded" && status == "ok" {
			status = "degraded"
		}
	}
	writeJSON(w, code, map[string]any{
		"status":     status,
		"components": results,
		"uptimeSec":  int(time.Since(h.Started).Seconds()),
	})
}

// Metrics emits a tiny Prometheus-style text exposition. Intentionally not a
// full exporter — just enough for a scrape to ingest request counts and
// latency rollups. Publicly reachable (like /healthz); scrapers often don't
// auth.
func (h *Handler) Metrics(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")

	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)

	_, _ = w.Write([]byte("# HELP formly_process_uptime_seconds Seconds since process start\n"))
	_, _ = w.Write([]byte("# TYPE formly_process_uptime_seconds counter\n"))
	_, _ = w.Write([]byte("formly_process_uptime_seconds " +
		strconv.FormatInt(int64(time.Since(h.Started).Seconds()), 10) + "\n"))

	_, _ = w.Write([]byte("# HELP formly_goroutines Number of goroutines\n"))
	_, _ = w.Write([]byte("# TYPE formly_goroutines gauge\n"))
	_, _ = w.Write([]byte("formly_goroutines " + strconv.Itoa(runtime.NumGoroutine()) + "\n"))

	_, _ = w.Write([]byte("# HELP formly_memory_alloc_bytes Resident heap bytes\n"))
	_, _ = w.Write([]byte("# TYPE formly_memory_alloc_bytes gauge\n"))
	_, _ = w.Write([]byte("formly_memory_alloc_bytes " +
		strconv.FormatUint(ms.Alloc, 10) + "\n"))

	// Last-hour request counts from the rollup table.
	rows, err := h.DB.Query(r.Context(), `
		SELECT status, SUM(count)
		  FROM request_metrics
		 WHERE bucket_ts > now() - interval '1 hour'
		 GROUP BY status`)
	if err == nil {
		defer rows.Close()
		_, _ = w.Write([]byte("# HELP formly_http_requests_1h_total Requests in the last hour by status bucket\n"))
		_, _ = w.Write([]byte("# TYPE formly_http_requests_1h_total counter\n"))
		for rows.Next() {
			var bucket string
			var total int64
			if err := rows.Scan(&bucket, &total); err == nil {
				_, _ = w.Write([]byte(
					`formly_http_requests_1h_total{status="` + bucket + `"} ` +
						strconv.FormatInt(total, 10) + "\n"))
			}
		}
	}
}

/* ------------------------------------------------------------------ */
/*  Admin-only ops endpoints.                                          */
/* ------------------------------------------------------------------ */

// Summary is a one-shot dashboard payload: component health, top-level
// counters (24h requests, error count, job totals), uptime, and process
// stats. Avoids the UI having to fan out to a dozen endpoints on load.
func (h *Handler) Summary(w http.ResponseWriter, r *http.Request) {
	if !adminOK(w, r) {
		return
	}
	ctx := r.Context()

	components := h.Checker.Check(ctx)
	overall := "ok"
	for _, c := range components {
		if c.Status == "down" {
			overall = "down"
			break
		}
		if c.Status == "degraded" && overall == "ok" {
			overall = "degraded"
		}
	}

	var req24h int64
	_ = h.DB.QueryRow(ctx, `
		SELECT COALESCE(SUM(count),0) FROM request_metrics
		 WHERE bucket_ts > now() - interval '24 hours'`).Scan(&req24h)

	var err24h int64
	_ = h.DB.QueryRow(ctx, `
		SELECT COUNT(*) FROM error_events
		 WHERE created_at > now() - interval '24 hours'`).Scan(&err24h)

	var jobsOK, jobsFail, jobsRunning, jobsQueued int64
	_ = h.DB.QueryRow(ctx, `SELECT
		SUM(CASE WHEN status='completed' AND finished_at > now() - interval '24 hours' THEN 1 ELSE 0 END),
		SUM(CASE WHEN status='failed'    AND finished_at > now() - interval '24 hours' THEN 1 ELSE 0 END),
		SUM(CASE WHEN status='running'   THEN 1 ELSE 0 END),
		SUM(CASE WHEN status='queued'    THEN 1 ELSE 0 END)
		FROM generation_jobs`).Scan(&jobsOK, &jobsFail, &jobsRunning, &jobsQueued)

	var activeSessions int64
	_ = h.DB.QueryRow(ctx, `
		SELECT COUNT(*) FROM user_sessions
		 WHERE revoked_at IS NULL
		   AND last_seen_at > now() - interval '30 minutes'`).Scan(&activeSessions)

	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)

	writeJSON(w, 200, map[string]any{
		"status":         overall,
		"components":     components,
		"uptimeSec":      int(time.Since(h.Started).Seconds()),
		"version":        h.Version,
		"goroutines":     runtime.NumGoroutine(),
		"heapAllocBytes": ms.Alloc,
		"requests24h":    req24h,
		"errors24h":      err24h,
		"jobs": map[string]int64{
			"completed24h": jobsOK,
			"failed24h":    jobsFail,
			"running":      jobsRunning,
			"queued":       jobsQueued,
		},
		"activeSessions": activeSessions,
	})
}

// Health returns the same per-component probe results as /healthz but admin-
// gated — used by the dashboard for a live refresh.
func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	if !adminOK(w, r) {
		return
	}
	writeJSON(w, 200, map[string]any{"components": h.Checker.Check(r.Context())})
}

// Queue returns live queue stats from the asynq inspector.
func (h *Handler) Queue(w http.ResponseWriter, r *http.Request) {
	if !adminOK(w, r) {
		return
	}
	insp := asynq.NewInspector(h.Redis)
	defer insp.Close()

	qs, err := insp.Queues()
	if err != nil {
		writeJSON(w, 200, map[string]any{
			"queues":    []any{},
			"available": false,
			"error":     err.Error(),
		})
		return
	}
	out := []map[string]any{}
	for _, q := range qs {
		info, err := insp.GetQueueInfo(q)
		if err != nil {
			continue
		}
		out = append(out, map[string]any{
			"name":         info.Queue,
			"pending":      info.Pending,
			"active":       info.Active,
			"scheduled":    info.Scheduled,
			"retry":        info.Retry,
			"archived":     info.Archived,
			"completed":    info.Completed,
			"processed24h": info.Processed,
			"failed24h":    info.Failed,
			"latencyMs":    info.Latency.Milliseconds(),
			"paused":       info.Paused,
		})
	}
	writeJSON(w, 200, map[string]any{
		"queues":    out,
		"available": true,
	})
}

// Jobs returns recent generation jobs for the caller's org with status
// breakdown. Useful for spotting repeated failures.
func (h *Handler) Jobs(w http.ResponseWriter, r *http.Request) {
	if !adminOK(w, r) {
		return
	}
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	type row struct {
		ID         string     `json:"id"`
		Kind       string     `json:"kind"`
		Status     string     `json:"status"`
		TemplateID string     `json:"templateId"`
		Total      int        `json:"total"`
		Done       int        `json:"done"`
		Error      *string    `json:"error,omitempty"`
		CreatedAt  time.Time  `json:"createdAt"`
		StartedAt  *time.Time `json:"startedAt,omitempty"`
		FinishedAt *time.Time `json:"finishedAt,omitempty"`
	}

	rows, err := h.DB.Query(r.Context(), `
		SELECT id, kind, status, template_id, total, done, error,
		       created_at, started_at, finished_at
		  FROM generation_jobs
		 WHERE org_id=$1
		 ORDER BY created_at DESC
		 LIMIT 50`, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	out := []row{}
	for rows.Next() {
		var it row
		if err := rows.Scan(&it.ID, &it.Kind, &it.Status, &it.TemplateID,
			&it.Total, &it.Done, &it.Error,
			&it.CreatedAt, &it.StartedAt, &it.FinishedAt); err == nil {
			out = append(out, it)
		}
	}

	// Status counts for the last 7 days.
	counts := map[string]int{}
	crows, _ := h.DB.Query(r.Context(), `
		SELECT status, COUNT(*) FROM generation_jobs
		 WHERE org_id=$1 AND created_at > now() - interval '7 days'
		 GROUP BY status`, c.OrgID)
	if crows != nil {
		for crows.Next() {
			var s string
			var n int
			if crows.Scan(&s, &n) == nil {
				counts[s] = n
			}
		}
		crows.Close()
	}

	writeJSON(w, 200, map[string]any{"jobs": out, "counts": counts})
}

// MetricsJSON is the admin dashboard view: hourly rollups for the last 24
// hours plus the top-N busiest endpoints in the last hour. The UI draws a
// stacked-by-status chart from `hourly` and a leaderboard from `top`.
func (h *Handler) MetricsJSON(w http.ResponseWriter, r *http.Request) {
	if !adminOK(w, r) {
		return
	}

	rows, err := h.DB.Query(r.Context(), `
		SELECT date_trunc('hour', bucket_ts) AS hour,
		       status,
		       SUM(count)   AS count,
		       SUM(sum_ms)  AS sum_ms,
		       MAX(max_ms)  AS max_ms
		  FROM request_metrics
		 WHERE bucket_ts > now() - interval '24 hours'
		 GROUP BY hour, status
		 ORDER BY hour ASC`)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	type bucket struct {
		Hour   time.Time `json:"hour"`
		Status string    `json:"status"`
		Count  int64     `json:"count"`
		AvgMs  int       `json:"avgMs"`
		MaxMs  int       `json:"maxMs"`
	}
	hourly := []bucket{}
	for rows.Next() {
		var b bucket
		var sumMs int64
		if err := rows.Scan(&b.Hour, &b.Status, &b.Count, &sumMs, &b.MaxMs); err == nil {
			if b.Count > 0 {
				b.AvgMs = int(sumMs / b.Count)
			}
			hourly = append(hourly, b)
		}
	}
	rows.Close()

	type endpoint struct {
		Method string `json:"method"`
		Path   string `json:"path"`
		Count  int64  `json:"count"`
		AvgMs  int    `json:"avgMs"`
		MaxMs  int    `json:"maxMs"`
		Errors int64  `json:"errors"`
	}
	top := []endpoint{}
	trows, err := h.DB.Query(r.Context(), `
		SELECT method, path,
		       SUM(count) AS total,
		       SUM(sum_ms),
		       MAX(max_ms),
		       SUM(CASE WHEN status IN ('4xx','5xx') THEN count ELSE 0 END) AS errs
		  FROM request_metrics
		 WHERE bucket_ts > now() - interval '1 hour'
		 GROUP BY method, path
		 ORDER BY total DESC
		 LIMIT 15`)
	if err == nil {
		defer trows.Close()
		for trows.Next() {
			var e endpoint
			var sumMs int64
			if err := trows.Scan(&e.Method, &e.Path, &e.Count, &sumMs, &e.MaxMs, &e.Errors); err == nil {
				if e.Count > 0 {
					e.AvgMs = int(sumMs / e.Count)
				}
				top = append(top, e)
			}
		}
	}

	writeJSON(w, 200, map[string]any{"hourly": hourly, "top": top})
}

// Errors returns the most recent error_events rows for the caller's org.
func (h *Handler) Errors(w http.ResponseWriter, r *http.Request) {
	if !adminOK(w, r) {
		return
	}
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	kind := r.URL.Query().Get("kind")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 200 {
		limit = 50
	}

	sql := `
		SELECT id, component, kind, message,
		       COALESCE(path,''), COALESCE(status,0),
		       context, created_at
		  FROM error_events
		 WHERE (org_id = $1 OR org_id IS NULL)`
	args := []any{c.OrgID}
	i := 2
	if kind != "" {
		sql += " AND kind=$" + strconv.Itoa(i)
		args = append(args, kind)
		i++
	}
	sql += " ORDER BY created_at DESC LIMIT $" + strconv.Itoa(i)
	args = append(args, limit)

	rows, err := h.DB.Query(r.Context(), sql, args...)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	type row struct {
		ID        string         `json:"id"`
		Component string         `json:"component"`
		Kind      string         `json:"kind"`
		Message   string         `json:"message"`
		Path      string         `json:"path,omitempty"`
		Status    int            `json:"status,omitempty"`
		Context   map[string]any `json:"context,omitempty"`
		CreatedAt string         `json:"createdAt"`
	}
	out := []row{}
	for rows.Next() {
		var it row
		var ctxRaw []byte
		var created time.Time
		if err := rows.Scan(&it.ID, &it.Component, &it.Kind, &it.Message,
			&it.Path, &it.Status, &ctxRaw, &created); err == nil {
			_ = json.Unmarshal(ctxRaw, &it.Context)
			it.CreatedAt = created.Format(time.RFC3339)
			out = append(out, it)
		}
	}
	writeJSON(w, 200, map[string]any{"events": out})
}

// HealthHistory returns 1-hour rollups of the latest health probes — one
// point per component per hour for the last 24 h, used to draw a sparkline.
func (h *Handler) HealthHistory(w http.ResponseWriter, r *http.Request) {
	if !adminOK(w, r) {
		return
	}
	rows, err := h.DB.Query(r.Context(), `
		SELECT component,
		       date_trunc('hour', created_at) AS hour,
		       AVG(latency_ms)::int,
		       SUM(CASE WHEN status='down' THEN 1 ELSE 0 END) AS down,
		       SUM(CASE WHEN status='degraded' THEN 1 ELSE 0 END) AS degraded,
		       COUNT(*) AS total
		  FROM health_checks
		 WHERE created_at > now() - interval '24 hours'
		 GROUP BY component, hour
		 ORDER BY component, hour ASC`)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	type pt struct {
		Component string    `json:"component"`
		Hour      time.Time `json:"hour"`
		LatencyMs int       `json:"latencyMs"`
		Down      int       `json:"down"`
		Degraded  int       `json:"degraded"`
		Total     int       `json:"total"`
	}
	out := []pt{}
	for rows.Next() {
		var p pt
		if err := rows.Scan(&p.Component, &p.Hour, &p.LatencyMs,
			&p.Down, &p.Degraded, &p.Total); err == nil {
			out = append(out, p)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Component != out[j].Component {
			return out[i].Component < out[j].Component
		}
		return out[i].Hour.Before(out[j].Hour)
	})
	writeJSON(w, 200, map[string]any{"history": out})
}

/* ------------------------------------------------------------------ */
/*  helpers                                                            */
/* ------------------------------------------------------------------ */

func adminOK(w http.ResponseWriter, r *http.Request) bool {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return false
	}
	if !c.IsAdmin() {
		writeErr(w, 403, "admin_only", "ops dashboard is admin-only")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
