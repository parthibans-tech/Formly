package promquery

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// osGetenv aliases os.Getenv so InfraHandler can read URL-style
// env vars without forcing the rest of the file to depend on os.
func osGetenv(k string) string { return os.Getenv(k) }

// Handler exposes /v1/admin/observability/* over the curated
// Prometheus surface. The chi router wires both methods individually
// so each can sit behind requireSuperAdmin without bracketing more
// routes than we mean to.
type Handler struct {
	C *Client
}

func NewHandler(c *Client) *Handler { return &Handler{C: c} }

// Snapshot is the response shape for /v1/admin/observability/snapshot.
//
// Each card on the dashboard maps to one field below. Failures
// surface as a label-keyed entry on `Errors` rather than blanking
// the whole response — a 5xx blowup on one query shouldn't black
// out the rest of the operator's view.
type Snapshot struct {
	GeneratedAt time.Time `json:"generatedAt"`

	// HTTP — the global error / latency / saturation triad.
	HTTP struct {
		RPS         float64 `json:"rps"`
		ErrorRatio  float64 `json:"errorRatio"`  // 5xx fraction over 5m
		P95Latency  float64 `json:"p95Latency"`  // seconds
		InFlight    float64 `json:"inFlight"`
	} `json:"http"`

	// DB pool — the operational metric the on-call most often asks
	// for first ("are we out of connections?"). 0..1.
	DBPool struct {
		Utilization float64 `json:"utilization"`
		Acquired    float64 `json:"acquired"`
		Max         float64 `json:"max"`
	} `json:"dbPool"`

	// Queue — the asynq throughput + saturation summary.
	Queue struct {
		TasksPerSec float64 `json:"tasksPerSec"`
		FailRatio   float64 `json:"failRatio"`
		InFlight    float64 `json:"inFlight"`
	} `json:"queue"`

	// AI — per-provider error ratio. Empty when AI is disabled.
	AI []LabeledNumber `json:"ai"`

	// Webhook — outbound delivery health.
	Webhook struct {
		FailRatio float64 `json:"failRatio"`
		Rate      float64 `json:"rate"`
	} `json:"webhook"`

	// Tenant SLO — per-tier 5m error ratio. The fast-burn alert is
	// keyed off the same series; this is the dashboard companion.
	Tenant []LabeledNumber `json:"tenant"`

	// Auth abuse signal — current 5m totals by kind.
	Auth struct {
		LoginFailRate    float64 `json:"loginFailRate"`
		LoginSuccessRate float64 `json:"loginSuccessRate"`
		MFAFailRate      float64 `json:"mfaFailRate"`
		APIKeyAbuseRate  float64 `json:"apiKeyAbuseRate"`
		RateLimit429Rate float64 `json:"rateLimit429Rate"`
	} `json:"auth"`

	// Build info, joined across processes — drives the version
	// pin in the corner of the dashboard.
	Build []map[string]string `json:"build"`

	// Per-card errors: "http.errorRatio" → "prometheus error: ...".
	// A non-empty Errors map with otherwise-zero numbers tells the
	// UI to render "no data yet" rather than "0%".
	Errors map[string]string `json:"errors,omitempty"`
}

// LabeledNumber is a {label → value} pair for the dashboard cards
// that show a small breakdown (per-tier, per-provider, per-kind).
// We keep the carrier flat (one set of labels per row) because all
// our dashboards group by exactly one dimension.
type LabeledNumber struct {
	Labels map[string]string `json:"labels"`
	Value  float64           `json:"value"`
}

// SnapshotHandler answers GET /v1/admin/observability/snapshot. It
// fans out the curated query bundle in parallel and assembles the
// JSON response. Total wallclock is bounded by the 10s per-query
// timeout on the underlying client × the slowest query, not the sum
// — the WaitGroup waits in parallel.
func (h *Handler) SnapshotHandler(w http.ResponseWriter, r *http.Request) {
	if h.C == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": map[string]string{
				"code":    "prom_unconfigured",
				"message": "PROMETHEUS_URL is not set on the API process",
			},
		})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()

	var snap Snapshot
	snap.GeneratedAt = time.Now().UTC()
	snap.Errors = map[string]string{}

	// Tiny helper: each (key, queryFn) pair runs in its own
	// goroutine; the closure stuffs the result into the snapshot
	// (or into Errors). This keeps the call sites readable rather
	// than 12 explicit goroutine declarations.
	type job func(ctx context.Context, snap *Snapshot, errs map[string]string)
	var (
		mu   sync.Mutex
		jobs = []struct {
			key string
			fn  job
		}{
			{"http.rps", func(ctx context.Context, s *Snapshot, e map[string]string) {
				v, _, err := h.C.QueryInstant(ctx,
					`sum(rate(formly_http_requests_total[5m]))`)
				if err != nil {
					mu.Lock()
					e["http.rps"] = err.Error()
					mu.Unlock()
					return
				}
				s.HTTP.RPS = v
			}},
			{"http.errorRatio", func(ctx context.Context, s *Snapshot, e map[string]string) {
				v, _, err := h.C.QueryInstant(ctx, `
sum(rate(formly_http_requests_total{code="5xx"}[5m]))
  /
clamp_min(sum(rate(formly_http_requests_total[5m])), 1e-9)
`)
				if err != nil {
					mu.Lock()
					e["http.errorRatio"] = err.Error()
					mu.Unlock()
					return
				}
				s.HTTP.ErrorRatio = v
			}},
			{"http.p95Latency", func(ctx context.Context, s *Snapshot, e map[string]string) {
				v, _, err := h.C.QueryInstant(ctx, `
histogram_quantile(0.95,
  sum by (le) (rate(formly_http_request_duration_seconds_bucket[5m]))
)
`)
				if err != nil {
					mu.Lock()
					e["http.p95Latency"] = err.Error()
					mu.Unlock()
					return
				}
				s.HTTP.P95Latency = v
			}},
			{"http.inFlight", func(ctx context.Context, s *Snapshot, e map[string]string) {
				v, _, err := h.C.QueryInstant(ctx,
					`sum(formly_http_requests_in_flight)`)
				if err != nil {
					mu.Lock()
					e["http.inFlight"] = err.Error()
					mu.Unlock()
					return
				}
				s.HTTP.InFlight = v
			}},

			{"dbPool", func(ctx context.Context, s *Snapshot, e map[string]string) {
				util, _, err := h.C.QueryInstant(ctx,
					`max(process:formly_db_pool_utilization:ratio)`)
				if err != nil {
					mu.Lock()
					e["dbPool"] = err.Error()
					mu.Unlock()
					return
				}
				s.DBPool.Utilization = util
				if v, _, err := h.C.QueryInstant(ctx,
					`sum(formly_db_pool_connections{state="acquired"})`); err == nil {
					s.DBPool.Acquired = v
				}
				if v, _, err := h.C.QueryInstant(ctx,
					`sum(formly_db_pool_connections{state="max"})`); err == nil {
					s.DBPool.Max = v
				}
			}},

			{"queue", func(ctx context.Context, s *Snapshot, e map[string]string) {
				if v, _, err := h.C.QueryInstant(ctx,
					`sum(rate(formly_queue_tasks_total[5m]))`); err != nil {
					mu.Lock()
					e["queue.rate"] = err.Error()
					mu.Unlock()
				} else {
					s.Queue.TasksPerSec = v
				}
				if v, _, err := h.C.QueryInstant(ctx, `
sum(rate(formly_queue_tasks_total{result="failed"}[5m]))
  /
clamp_min(sum(rate(formly_queue_tasks_total[5m])), 1e-9)
`); err != nil {
					mu.Lock()
					e["queue.failRatio"] = err.Error()
					mu.Unlock()
				} else {
					s.Queue.FailRatio = v
				}
				if v, _, err := h.C.QueryInstant(ctx,
					`sum(formly_queue_tasks_in_flight)`); err == nil {
					s.Queue.InFlight = v
				}
			}},

			{"webhook", func(ctx context.Context, s *Snapshot, e map[string]string) {
				if v, _, err := h.C.QueryInstant(ctx,
					`webhook:formly_webhook_total:rate5m`); err == nil {
					s.Webhook.Rate = v
				} else {
					mu.Lock()
					e["webhook.rate"] = err.Error()
					mu.Unlock()
				}
				if v, _, err := h.C.QueryInstant(ctx,
					`webhook:formly_webhook_failure_ratio:rate5m`); err == nil {
					s.Webhook.FailRatio = v
				}
			}},

			{"ai", func(ctx context.Context, s *Snapshot, e map[string]string) {
				rows, err := h.C.QueryInstantVector(ctx,
					`provider:formly_ai_error_ratio:rate5m`)
				if err != nil {
					mu.Lock()
					e["ai"] = err.Error()
					mu.Unlock()
					return
				}
				out := make([]LabeledNumber, 0, len(rows))
				for _, r := range rows {
					if len(r.Values) == 0 {
						continue
					}
					out = append(out, LabeledNumber{
						Labels: r.Metric,
						Value:  r.Values[0].V,
					})
				}
				mu.Lock()
				s.AI = out
				mu.Unlock()
			}},

			{"tenant", func(ctx context.Context, s *Snapshot, e map[string]string) {
				rows, err := h.C.QueryInstantVector(ctx,
					`tier:formly_tenant_error_ratio:rate5m`)
				if err != nil {
					mu.Lock()
					e["tenant"] = err.Error()
					mu.Unlock()
					return
				}
				out := make([]LabeledNumber, 0, len(rows))
				for _, r := range rows {
					if len(r.Values) == 0 {
						continue
					}
					out = append(out, LabeledNumber{
						Labels: r.Metric,
						Value:  r.Values[0].V,
					})
				}
				mu.Lock()
				s.Tenant = out
				mu.Unlock()
			}},

			{"auth", func(ctx context.Context, s *Snapshot, e map[string]string) {
				if v, _, err := h.C.QueryInstant(ctx,
					`sum(rate(formly_auth_attempts_total{kind="login",result="failed"}[5m]))`); err == nil {
					s.Auth.LoginFailRate = v
				}
				if v, _, err := h.C.QueryInstant(ctx,
					`sum(rate(formly_auth_attempts_total{kind="login",result="success"}[5m]))`); err == nil {
					s.Auth.LoginSuccessRate = v
				}
				if v, _, err := h.C.QueryInstant(ctx,
					`sum(rate(formly_auth_attempts_total{kind="mfa_verify",result="failed"}[5m]))`); err == nil {
					s.Auth.MFAFailRate = v
				}
				if v, _, err := h.C.QueryInstant(ctx,
					`formly_apikey_abuse:rate5m`); err == nil {
					s.Auth.APIKeyAbuseRate = v
				}
				if v, _, err := h.C.QueryInstant(ctx,
					`sum(bucket:formly_rate_limit_hits:rate5m)`); err == nil {
					s.Auth.RateLimit429Rate = v
				}
			}},

			{"build", func(ctx context.Context, s *Snapshot, e map[string]string) {
				rows, err := h.C.QueryInstantVector(ctx, `formly_build_info`)
				if err != nil {
					mu.Lock()
					e["build"] = err.Error()
					mu.Unlock()
					return
				}
				out := make([]map[string]string, 0, len(rows))
				for _, r := range rows {
					out = append(out, r.Metric)
				}
				mu.Lock()
				s.Build = out
				mu.Unlock()
			}},
		}
	)

	// Run them all in parallel; the response shape settles after
	// the WG drains. 10s per query × parallel = at most one query's
	// worth of wallclock for the whole bundle.
	var wg sync.WaitGroup
	for _, j := range jobs {
		j := j
		wg.Add(1)
		go func() {
			defer wg.Done()
			j.fn(ctx, &snap, snap.Errors)
		}()
	}
	wg.Wait()

	if len(snap.Errors) == 0 {
		snap.Errors = nil
	}
	writeJSON(w, http.StatusOK, snap)
}

// SeriesHandler answers GET /v1/admin/observability/series.
//
// The metric to return is selected by the `metric` query param,
// matched against a fixed allowlist below. Any unrecognized name
// gets a 400 — we will not pass through arbitrary PromQL even from
// a super-admin context.
//
// The window is selected by `minutes` (default 60, capped at 24h —
// past that the per-step rate() smooths everything to a flat line
// and Prometheus's range-query cost climbs steeply).
func (h *Handler) SeriesHandler(w http.ResponseWriter, r *http.Request) {
	if h.C == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": map[string]string{
				"code":    "prom_unconfigured",
				"message": "PROMETHEUS_URL is not set on the API process",
			},
		})
		return
	}
	metric := r.URL.Query().Get("metric")
	q, ok := seriesAllowlist[metric]
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": map[string]string{
				"code":    "unknown_metric",
				"message": "metric not in allowlist; see seriesAllowlist for valid names",
			},
		})
		return
	}
	mins, _ := strconv.Atoi(r.URL.Query().Get("minutes"))
	if mins <= 0 {
		mins = 60
	}
	// 24h cap. The rate window inside each query is fixed at 5m so
	// going past 24h just thins the points — not useful, expensive.
	if mins > 24*60 {
		mins = 24 * 60
	}

	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()

	rows, err := h.C.QueryRange(ctx, q, time.Duration(mins)*time.Minute)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error": map[string]string{
				"code":    "prom_query_failed",
				"message": err.Error(),
			},
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"metric":     metric,
		"minutes":    mins,
		"series":     rows,
		"generatedAt": time.Now().UTC(),
	})
}

// seriesAllowlist is the fixed mapping from the public `metric`
// query-string value to the PromQL the API actually runs. Adding a
// new sparkline is a deliberate two-line change here; we never let
// the browser drive PromQL.
var seriesAllowlist = map[string]string{
	"http.rps": `sum(rate(formly_http_requests_total[5m]))`,
	"http.errorRatio": `
sum(rate(formly_http_requests_total{code="5xx"}[5m]))
  /
clamp_min(sum(rate(formly_http_requests_total[5m])), 1e-9)
`,
	"http.p95Latency": `
histogram_quantile(0.95,
  sum by (le) (rate(formly_http_request_duration_seconds_bucket[5m]))
)
`,
	"queue.rate":  `sum(rate(formly_queue_tasks_total[5m]))`,
	"queue.fails": `sum(rate(formly_queue_tasks_total{result="failed"}[5m]))`,
	"dbPool.utilization": `
max(process:formly_db_pool_utilization:ratio)
`,
	"tenant.errorRatio.5m": `tier:formly_tenant_error_ratio:rate5m`,
	"auth.failRate":        `sum(rate(formly_auth_attempts_total{result="failed"}[5m]))`,
	"auth.rateLimit429":    `sum(bucket:formly_rate_limit_hits:rate5m)`,
	"webhook.failRatio":    `webhook:formly_webhook_failure_ratio:rate5m`,
	"ai.errorRatio":        `provider:formly_ai_error_ratio:rate5m`,

	// Tier 4 — read/write split, error budget remaining, cardinality
	// watchdog. Each one corresponds to a recording rule in
	// infra/prometheus/recording.rules.yml; the dashboard reads them
	// the same way it reads the Tier 2/3 series.
	"tenant.errorRatio.read.5m":  `tier_kind:formly_tenant_error_ratio:rate5m{kind="read"}`,
	"tenant.errorRatio.write.5m": `tier_kind:formly_tenant_error_ratio:rate5m{kind="write"}`,
	"errorBudget.remaining.28d":  `tier:formly_error_budget_remaining:ratio28d`,
	"cardinality.activeSeries":   `topk(10, metric:formly_series_count:active)`,
}

// InfraHandler answers GET /v1/admin/observability/infra. It probes
// the auxiliary observability components (Alertmanager,
// OpenTelemetry/Tempo) and returns a small status payload for the
// dashboard's "infrastructure" strip. The probes are deliberately
// shallow: a single ready check per backend, with a short timeout
// — we're answering "is this thing reachable?" and nothing more.
//
// The corresponding env vars (ALERTMANAGER_URL, TEMPO_URL) are
// optional; an unset URL surfaces as `configured:false` so the UI
// can render a "not wired up" hint rather than a fake red dot.
func (h *Handler) InfraHandler(w http.ResponseWriter, r *http.Request) {
	type compStatus struct {
		Name       string `json:"name"`
		Configured bool   `json:"configured"`
		Healthy    bool   `json:"healthy"`
		URL        string `json:"url,omitempty"`
		Detail     string `json:"detail,omitempty"`
	}
	type resp struct {
		GeneratedAt time.Time    `json:"generatedAt"`
		Components  []compStatus `json:"components"`
	}

	out := resp{GeneratedAt: time.Now().UTC()}
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()

	// Prometheus — surface what we already know about the
	// configured client.
	{
		c := compStatus{Name: "prometheus", Configured: h.C != nil}
		if h.C != nil {
			c.URL = h.C.BaseURL()
			// Cheap reachability probe: a constant-time instant
			// query that touches the HTTP API and the storage
			// engine simultaneously.
			if _, _, err := h.C.QueryInstant(ctx, "vector(1)"); err != nil {
				c.Healthy = false
				c.Detail = err.Error()
			} else {
				c.Healthy = true
			}
		}
		out.Components = append(out.Components, c)
	}

	// Alertmanager.
	out.Components = append(out.Components, probeURL(ctx, "alertmanager",
		strings.TrimSpace(getenv("ALERTMANAGER_URL")), "/-/healthy"))

	// Tempo — defaults to the in-compose port if unset, since
	// most operators don't bother setting TEMPO_URL when running
	// the dev compose stack.
	tempoURL := strings.TrimSpace(getenv("TEMPO_URL"))
	if tempoURL == "" && strings.TrimSpace(getenv("OTEL_EXPORTER_OTLP_ENDPOINT")) != "" {
		// Best-effort default. /ready is the canonical Tempo probe.
		tempoURL = "http://localhost:3200"
	}
	out.Components = append(out.Components, probeURL(ctx, "tempo",
		tempoURL, "/ready"))

	// Grafana — operator dashboards. /api/health returns a JSON
	// payload but the status code alone tells us whether
	// provisioning succeeded.
	out.Components = append(out.Components, probeURL(ctx, "grafana",
		strings.TrimSpace(getenv("GRAFANA_URL")), "/api/health"))

	// Blackbox exporter — synthetic probe runner. /-/healthy is
	// the canonical readiness check.
	out.Components = append(out.Components, probeURL(ctx, "blackbox",
		strings.TrimSpace(getenv("BLACKBOX_URL")), "/-/healthy"))

	writeJSON(w, http.StatusOK, out)
}

// probeURL is the small reachability probe shared by the
// Alertmanager and Tempo branches above. Returns a compStatus-
// compatible struct (declared inline at the call site to keep the
// JSON shape one definition).
func probeURL(ctx context.Context, name, base, path string) struct {
	Name       string `json:"name"`
	Configured bool   `json:"configured"`
	Healthy    bool   `json:"healthy"`
	URL        string `json:"url,omitempty"`
	Detail     string `json:"detail,omitempty"`
} {
	out := struct {
		Name       string `json:"name"`
		Configured bool   `json:"configured"`
		Healthy    bool   `json:"healthy"`
		URL        string `json:"url,omitempty"`
		Detail     string `json:"detail,omitempty"`
	}{Name: name}
	if base == "" {
		return out
	}
	out.Configured = true
	out.URL = base
	full := strings.TrimRight(base, "/") + path
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, full, nil)
	if err != nil {
		out.Detail = err.Error()
		return out
	}
	hc := &http.Client{Timeout: 3 * time.Second}
	res, err := hc.Do(req)
	if err != nil {
		out.Detail = err.Error()
		return out
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		out.Detail = "HTTP " + http.StatusText(res.StatusCode)
		return out
	}
	out.Healthy = true
	return out
}

// getenv is split out of the handler so the probe code reads
// without an os import scattered through the file.
func getenv(k string) string { return osGetenv(k) }

// TargetsHandler answers GET /v1/admin/observability/targets — the
// dashboard's "is Prometheus actually reaching us?" strip. We sort
// down before up so an operator triaging a dead live-preview sees
// the broken row first.
func (h *Handler) TargetsHandler(w http.ResponseWriter, r *http.Request) {
	if h.C == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": map[string]string{
				"code":    "prom_unconfigured",
				"message": "PROMETHEUS_URL is not set on the API process",
			},
		})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
	defer cancel()
	rows, err := h.C.Targets(ctx)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error": map[string]string{
				"code":    "prom_query_failed",
				"message": err.Error(),
			},
		})
		return
	}
	// Stable order: down → up → unknown, then alphabetical by job.
	sortFn := func(s string) int {
		switch s {
		case "down":
			return 0
		case "unknown":
			return 1
		case "up":
			return 2
		}
		return 3
	}
	for i := 1; i < len(rows); i++ {
		j := i
		for j > 0 {
			a, b := rows[j-1], rows[j]
			if sortFn(a.Health) > sortFn(b.Health) ||
				(sortFn(a.Health) == sortFn(b.Health) && a.Job > b.Job) {
				rows[j-1], rows[j] = b, a
				j--
				continue
			}
			break
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"targets":     rows,
		"generatedAt": time.Now().UTC(),
	})
}

// AlertsHandler answers GET /v1/admin/observability/alerts. firing
// rows first, severity page before ticket, newest first inside each
// bucket. The dashboard renders the top N as a banner and the rest
// in a collapsible.
func (h *Handler) AlertsHandler(w http.ResponseWriter, r *http.Request) {
	if h.C == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": map[string]string{
				"code":    "prom_unconfigured",
				"message": "PROMETHEUS_URL is not set on the API process",
			},
		})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
	defer cancel()
	rows, err := h.C.Alerts(ctx)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error": map[string]string{
				"code":    "prom_query_failed",
				"message": err.Error(),
			},
		})
		return
	}
	stateRank := func(s string) int {
		switch s {
		case "firing":
			return 0
		case "pending":
			return 1
		}
		return 2
	}
	sevRank := func(s string) int {
		switch s {
		case "page":
			return 0
		case "ticket":
			return 1
		}
		return 2
	}
	for i := 1; i < len(rows); i++ {
		j := i
		for j > 0 {
			a, b := rows[j-1], rows[j]
			swap := false
			if stateRank(a.State) > stateRank(b.State) {
				swap = true
			} else if stateRank(a.State) == stateRank(b.State) {
				if sevRank(a.Severity) > sevRank(b.Severity) {
					swap = true
				} else if sevRank(a.Severity) == sevRank(b.Severity) && a.ActiveAt.Before(b.ActiveAt) {
					swap = true
				}
			}
			if swap {
				rows[j-1], rows[j] = b, a
				j--
				continue
			}
			break
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"alerts":      rows,
		"generatedAt": time.Now().UTC(),
	})
}

// AllowlistedMetrics returns the keys clients can pass as
// ?metric=...; exposed so the UI's chart-picker can stay in lockstep
// without hardcoding strings on both sides.
func AllowlistedMetrics() []string {
	out := make([]string, 0, len(seriesAllowlist))
	for k := range seriesAllowlist {
		out = append(out, k)
	}
	return out
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
