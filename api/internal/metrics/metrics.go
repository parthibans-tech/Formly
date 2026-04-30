// Package metrics is the Prometheus seam for the API and worker
// processes. It owns:
//
//   - a single in-process *prometheus.Registry (one per binary, scoped
//     so the test suite and downstream packages don't collide on the
//     default global registry);
//   - the standard Go runtime + process collectors (heap, GC, FDs,
//     goroutines, GOMAXPROCS, RSS) — these come for free with the
//     official `collectors` package and replace the four hand-rolled
//     gauges in internal/observability;
//   - a chi-friendly HTTP middleware that emits four series the rest
//     of the platform's recording rules + alerting rules build on:
//
//        http_requests_total{method,route,code}      counter
//        http_request_duration_seconds{method,route} histogram
//        http_requests_in_flight                     gauge
//        http_response_size_bytes{method,route}      histogram
//
//   - the `Handler()` exposition endpoint, hardened with two layered
//     gates: (1) basic-auth via METRICS_BASIC_AUTH_USER/PASSWORD env
//     vars; (2) loopback-only fallback when those aren't set, so a
//     fresh dev checkout still scrapes from `localhost` without
//     leaking metrics to the public internet.
//
// Cardinality guard-rails baked in:
//
//   - the `route` label uses chi's matched route pattern (e.g.
//     "/v1/files/{id}") not the raw URL path, so 1M files don't blow
//     up the series count;
//   - the `code` label is bucketed (2xx/3xx/4xx/5xx), not the raw
//     status code — a single endpoint emitting 200/201/204/206 quietly
//     quadruples cardinality otherwise;
//   - high-volume noise endpoints (/healthz, /metrics) are excluded
//     entirely. They'd dominate the rate() and skew the latency
//     histogram with sub-millisecond reads.
//
// Build-info exposure: the `build_info` gauge is set once at
// construction with `version`, `commit`, `go_version` labels so
// dashboards can join on it via `* on() group_left(version) build_info`.
package metrics

import (
	"net"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Registry bundles the in-process collectors so the API and worker
// each have one. It is intentionally not a global — the unit tests
// and any future fork (a long-running `cmd/jobs` process, say)
// construct their own.
type Registry struct {
	Reg *prometheus.Registry

	// HTTP series — exported so adjacent packages can wire bespoke
	// observers (e.g. webhook delivery, queue consumer) into the same
	// histograms without re-declaring labels.
	HTTPRequests        *prometheus.CounterVec
	HTTPDuration        *prometheus.HistogramVec
	HTTPInFlight        prometheus.Gauge
	HTTPResponseSize    *prometheus.HistogramVec

	// BuildInfo carries the version / commit / go_version pin. Filled
	// at New() and never updated.
	BuildInfo *prometheus.GaugeVec

	// --- Tier 1: operational metrics ---------------------------------
	//
	// These are the lowest-effort / highest-leverage signals beyond
	// HTTP. Each one answers a question the on-call already has at 3am
	// ("is the DB pool exhausted?", "is the queue backed up?", "is
	// Anthropic erroring?") without requiring app-level dashboards
	// people forget to update.

	// DBPool is updated by the dbpoolCollector goroutine in this
	// package. State labels: acquired / idle / total / max / new /
	// canceled — matches the surface that pgxpool.Stat exposes, less
	// the fields nobody alerts on.
	DBPool *prometheus.GaugeVec

	// QueueTasks is incremented by the asynq middleware in this
	// package when a task handler returns. result ∈ {success, failed}.
	QueueTasks *prometheus.CounterVec

	// QueueDuration is observed by the same middleware. Buckets are
	// wide because async tasks legitimately span seconds (Chromium
	// renders) to tens of minutes (large embeds).
	QueueDuration *prometheus.HistogramVec

	// QueueInFlight is a gauge incremented at task entry, decremented
	// on return. Sustained values near asynq.Config.Concurrency mean
	// the worker is saturated.
	QueueInFlight *prometheus.GaugeVec

	// WebhookDeliveries counts outbound webhook attempts. result ∈
	// {2xx, 3xx, 4xx, 5xx, error} — `error` is a transport / DNS /
	// timeout failure where we never got an HTTP status back.
	WebhookDeliveries *prometheus.CounterVec
	WebhookDuration   *prometheus.HistogramVec

	// MailSent counts transactional email send attempts. result ∈
	// {sent, failed}; provider ∈ {resend, ses, smtp, log}; kind is
	// the SendOptions.Kind from the caller (e.g. invite, billing_*).
	MailSent *prometheus.CounterVec

	// AIRequests covers all calls into the AI provider, broken out by
	// op (chat / embed) and provider so dashboards can show
	// per-provider error rate when one degrades. Tokens is a separate
	// counter so we can sum cost without polluting the request label set.
	AIRequests *prometheus.CounterVec
	AIDuration *prometheus.HistogramVec
	AITokens   *prometheus.CounterVec

	// --- Tier 2: multi-tenant SLO + abuse detection -------------------
	//
	// The hard rule for Tier 2 is cardinality discipline. Every label
	// is bounded by something we control (tier name, auth-kind enum,
	// rate-limit bucket name, key-auth result enum) — never a
	// user-supplied value (org_id, IP, key_id) which would explode
	// the series count past usefulness on a multi-tenant install.

	// TenantRequests is the SLO-grade per-tier success counter. The
	// tier comes from billing.Limits.Tier (free / starter / pro /
	// enterprise / unknown / anon for unauthenticated routes), so
	// per-tier SLOs and burn-rate alerts work without leaking org
	// identifiers into Prometheus.
	//
	// The `kind` label splits read vs write traffic — Tier 4. Reads
	// (GET/HEAD/OPTIONS) and writes (everything else) have different
	// SLOs in practice: a 5xx on a write is a stuck mutation that
	// pages, while a 5xx on a read is often a cache miss that retries
	// invisibly. Cardinality stays bounded — 2 kinds × ~5 tiers × 5
	// status classes = 50 series, still order-of-magnitude below the
	// per-route http counter.
	TenantRequests *prometheus.CounterVec

	// AuthAttempts answers "are we under credential-stuffing?"
	// kind ∈ {login, register, mfa_verify}; result ∈ {success, failed}.
	// A surge in `failed` with steady `success` is the canonical
	// signal — the rate-limit alert keys off this same series.
	AuthAttempts *prometheus.CounterVec

	// RateLimitHits counts 429s emitted by security.RateLimit. bucket
	// is a friendly name set on LimitOpts.Name (login / register /
	// mfa_verify / etc.) — NOT the per-IP bucket key, which would
	// blow up cardinality. A spike here is the early warning before
	// the AuthAttempts surge.
	RateLimitHits *prometheus.CounterVec

	// APIKeyAuth tracks Bearer-token verifier outcomes. result ∈
	// {ok, invalid, revoked, expired, error}. invalid + revoked
	// dominate when a leaked key is being scanned; expired is an
	// integration that needs a key rotation.
	APIKeyAuth *prometheus.CounterVec

	// --- Tier 4: deadman + cardinality watchdogs ---------------------
	//
	// CronLastRun is a per-cron unix-timestamp gauge updated each time
	// a scheduled job actually runs. Pair with `time() - <gauge> >
	// expected_interval` in alerts.rules.yml to page when a cron has
	// silently stopped firing — the failure mode liveness checks miss
	// (the worker is up, the queue is up, but nothing is scheduling).
	//
	// Cardinality bound: one series per cron job. Today: schedules,
	// archive, billing-reconcile — 3 series. Stays small as long as
	// callers don't shove user-controlled IDs into `name`.
	CronLastRun *prometheus.GaugeVec
}

// Options configures the registry. Sensible zero values everywhere —
// only fill what you need.
type Options struct {
	// Process tags one of "api" or "worker" so a single Prometheus
	// instance can scrape both without label collision. Used as the
	// `process` label on `build_info` and as the `Namespace` is held
	// constant ("formly") so PromQL across processes joins cleanly.
	Process string

	// Version, Commit, GoVersion populate `build_info`. GoVersion
	// defaults to runtime.Version() when blank.
	Version, Commit, GoVersion string
}

// New constructs a Registry, registers the standard Go + process
// collectors, declares the HTTP metric vectors, and stamps build_info.
// Safe to call once per binary.
func New(opts Options) *Registry {
	if opts.GoVersion == "" {
		opts.GoVersion = runtime.Version()
	}
	if opts.Process == "" {
		opts.Process = "unknown"
	}

	reg := prometheus.NewRegistry()

	// Standard collectors — Go runtime (goroutines, GC, mem) and
	// process metrics (open FDs, RSS, CPU). Replace the hand-rolled
	// gauges in internal/observability that we'll keep around for
	// the DB-backed dashboard but stop emitting via /metrics.
	reg.MustRegister(
		collectors.NewGoCollector(
			collectors.WithGoCollections(collectors.GoRuntimeMetricsCollection),
		),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{
			Namespace: "formly",
		}),
	)

	r := &Registry{Reg: reg}

	r.HTTPRequests = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "formly",
		Subsystem: "http",
		Name:      "requests_total",
		Help:      "Total HTTP requests handled by the API, partitioned by method, chi route pattern, and status class.",
	}, []string{"method", "route", "code"})

	// Latency buckets cover the full spread we see in production:
	// sub-10ms cache hits up to ~30s Chromium renders. Twelve buckets
	// is the upper end of what's comfortable to scrape — more than
	// that and a dense /metrics page slows the agent.
	r.HTTPDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: "formly",
		Subsystem: "http",
		Name:      "request_duration_seconds",
		Help:      "HTTP request duration distribution by method and chi route pattern.",
		Buckets: []float64{
			0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
		},
	}, []string{"method", "route"})

	r.HTTPInFlight = prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: "formly",
		Subsystem: "http",
		Name:      "requests_in_flight",
		Help:      "Number of HTTP requests currently being served. Sustained values near GOMAXPROCS suggest CPU saturation.",
	})

	// Response-size histogram — picks up a slow leak (e.g. a list
	// endpoint that started returning every row instead of the
	// first 100) before latency does.
	r.HTTPResponseSize = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: "formly",
		Subsystem: "http",
		Name:      "response_size_bytes",
		Help:      "HTTP response body size distribution.",
		Buckets: []float64{
			256, 1024, 4096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304,
		},
	}, []string{"method", "route"})

	r.BuildInfo = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: "formly",
		Name:      "build_info",
		Help:      "Build metadata (always 1). Use `* on() group_left(version) formly_build_info` to surface version on other charts.",
	}, []string{"process", "version", "commit", "go_version"})

	// --- Tier 1 operational metrics ----------------------------------

	r.DBPool = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: "formly",
		Subsystem: "db",
		Name:      "pool_connections",
		Help:      "pgxpool connection counts by state. Sourced from pgxpool.Stat() every 10s.",
	}, []string{"state"})

	// Queue duration buckets are intentionally wider than HTTP — a
	// generate task can run 30s+ on cold Chromium, an embed batch
	// can run for minutes. Sub-50ms buckets exist to catch the fast
	// no-op tasks (e.g. embed for AI-disabled org).
	r.QueueTasks = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "formly",
		Subsystem: "queue",
		Name:      "tasks_total",
		Help:      "Async task processing outcomes by queue, task type, and result.",
	}, []string{"queue", "task", "result"})

	r.QueueDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: "formly",
		Subsystem: "queue",
		Name:      "task_duration_seconds",
		Help:      "Async task duration distribution by queue and task type.",
		Buckets: []float64{
			0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900,
		},
	}, []string{"queue", "task"})

	r.QueueInFlight = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: "formly",
		Subsystem: "queue",
		Name:      "tasks_in_flight",
		Help:      "Async tasks currently executing, by queue. Sustained values near asynq concurrency = saturation.",
	}, []string{"queue"})

	r.WebhookDeliveries = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "formly",
		Subsystem: "webhook",
		Name:      "deliveries_total",
		Help:      "Outbound webhook attempts by HTTP status class (2xx/3xx/4xx/5xx) or `error` for transport-level failures.",
	}, []string{"result"})

	// Webhook duration buckets cap at 30s — that's the per-attempt
	// timeout we set on the HTTP client. Anything past that is a
	// retry, not a longer first attempt.
	r.WebhookDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: "formly",
		Subsystem: "webhook",
		Name:      "delivery_duration_seconds",
		Help:      "Outbound webhook attempt duration distribution.",
		Buckets: []float64{
			0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
		},
	}, []string{"result"})

	r.MailSent = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "formly",
		Subsystem: "mail",
		Name:      "sent_total",
		Help:      "Transactional email send attempts. result ∈ {sent, failed}; provider is the configured backend; kind is the caller-supplied SendOptions.Kind.",
	}, []string{"kind", "provider", "result"})

	r.AIRequests = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "formly",
		Subsystem: "ai",
		Name:      "requests_total",
		Help:      "AI provider requests by provider (openai/anthropic/disabled), op (chat/embed), and result (ok/error).",
	}, []string{"provider", "op", "result"})

	// AI duration buckets stretch to 60s — chat completions on long
	// prompts, especially with reasoning models, can routinely run
	// 20–40s. Embeds are fast (sub-second) but live in the same
	// vector for label consistency.
	r.AIDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: "formly",
		Subsystem: "ai",
		Name:      "request_duration_seconds",
		Help:      "AI provider request duration distribution by provider and op.",
		Buckets: []float64{
			0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 40, 60,
		},
	}, []string{"provider", "op"})

	// AITokens uses `kind` (prompt / completion) so per-cost summing
	// works: `sum by (provider) (rate(formly_ai_tokens_total[5m]))`
	// gives you the dollar-burn proxy per provider.
	r.AITokens = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "formly",
		Subsystem: "ai",
		Name:      "tokens_total",
		Help:      "Token counter for AI provider calls. kind ∈ {prompt, completion}.",
	}, []string{"provider", "op", "kind"})

	// --- Tier 2 metric vectors --------------------------------------

	r.TenantRequests = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "formly",
		Subsystem: "tenant",
		Name:      "requests_total",
		Help:      "HTTP requests labelled by billing tier (free/starter/pro/enterprise/anon/unknown), kind (read/write), and status class. The SLO grain — never label by org_id.",
	}, []string{"tier", "kind", "code"})

	r.AuthAttempts = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "formly",
		Subsystem: "auth",
		Name:      "attempts_total",
		Help:      "Authentication attempts. kind ∈ {login, register, mfa_verify}; result ∈ {success, failed}.",
	}, []string{"kind", "result"})

	r.RateLimitHits = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "formly",
		Subsystem: "security",
		Name:      "rate_limit_hits_total",
		Help:      "429 responses emitted by security.RateLimit, partitioned by friendly bucket name (login/register/...).",
	}, []string{"bucket"})

	r.APIKeyAuth = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "formly",
		Subsystem: "auth",
		Name:      "apikey_attempts_total",
		Help:      "API key (fk_*) verification outcomes. result ∈ {ok, invalid, revoked, expired, error}.",
	}, []string{"result"})

	// --- Tier 4 metric vectors --------------------------------------

	r.CronLastRun = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: "formly",
		Subsystem: "cron",
		Name:      "last_run_timestamp_seconds",
		Help:      "Unix timestamp of the last successful run for a named cron job. Pair with `time() - _ > interval` to alert on a stuck scheduler (deadman).",
	}, []string{"name"})

	reg.MustRegister(
		r.HTTPRequests,
		r.HTTPDuration,
		r.HTTPInFlight,
		r.HTTPResponseSize,
		r.BuildInfo,
		r.DBPool,
		r.QueueTasks,
		r.QueueDuration,
		r.QueueInFlight,
		r.WebhookDeliveries,
		r.WebhookDuration,
		r.MailSent,
		r.AIRequests,
		r.AIDuration,
		r.AITokens,
		r.TenantRequests,
		r.AuthAttempts,
		r.RateLimitHits,
		r.APIKeyAuth,
		r.CronLastRun,
	)

	r.BuildInfo.WithLabelValues(
		opts.Process,
		nonEmpty(opts.Version, "dev"),
		nonEmpty(opts.Commit, "unknown"),
		opts.GoVersion,
	).Set(1)

	return r
}

// Middleware returns a chi-aware HTTP middleware that records the
// four standard HTTP series. Mount it once per chi.Router, after
// middleware.RequestID and middleware.Recoverer (so panics get
// captured as 5xx) and before any compression / per-route handlers
// (so we observe the user-visible status, not a half-flushed gzip).
//
// Routes that match `/healthz` or `/metrics` are skipped entirely —
// observing them would (a) drown the per-route leaderboards and
// (b) produce a misleading p50 (those endpoints are sub-ms reads).
func (r *Registry) Middleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			route := chiRoutePattern(req)
			if route == "/healthz" || route == "/metrics" {
				next.ServeHTTP(w, req)
				return
			}

			// Allocate the tenant slot so downstream auth middleware
			// can call SetRequestTenant(req, tier) and we can read the
			// resolved tier back here once the chain unwinds. Default
			// "anon" stays in place if nothing writes — that's correct
			// for unauthenticated routes (login, healthz-class, etc.).
			ctx, slot := withTenantSlot(req.Context())
			req = req.WithContext(ctx)

			r.HTTPInFlight.Inc()
			defer r.HTTPInFlight.Dec()

			rec := &statusRecorder{ResponseWriter: w, status: 200}
			start := time.Now()
			next.ServeHTTP(rec, req)
			dur := time.Since(start).Seconds()

			// Resolve the route AFTER the handler runs — chi only
			// populates RoutePattern() once a match has been found.
			// Pre-routing this would label everything as the raw
			// URL path and torch cardinality.
			if route == "" {
				route = chiRoutePattern(req)
			}
			if route == "" {
				route = "unknown"
			}

			method := req.Method
			code := codeBucket(rec.status)
			kind := methodKind(method)

			r.HTTPRequests.WithLabelValues(method, route, code).Inc()

			// Tier 4: attach an exemplar to the latency observation when
			// we have either a chi request_id or a W3C traceparent
			// trace_id. Exemplars stitch a single-request trace into a
			// histogram bucket, so when the dashboard shows a 30s p99
			// spike the operator can click straight through to the
			// offending request_id without grepping logs by timestamp.
			//
			// The Observe call is split: ObserveWithExemplar emits an
			// exemplar only when one is present (so unauthenticated /
			// edge-router requests still get a sample, just without the
			// extra label). The cast is the published API for opting
			// in — promhttp.HandlerOpts.EnableOpenMetrics on the
			// scrape side decides whether they're actually exposed.
			durObs := r.HTTPDuration.WithLabelValues(method, route)
			if exLabels := requestExemplar(req); len(exLabels) > 0 {
				if eo, ok := durObs.(prometheus.ExemplarObserver); ok {
					eo.ObserveWithExemplar(dur, exLabels)
				} else {
					durObs.Observe(dur)
				}
			} else {
				durObs.Observe(dur)
			}

			r.HTTPResponseSize.WithLabelValues(method, route).Observe(float64(rec.bytes))

			// Tier 2/4: per-tier, per-kind SLO counter. Cardinality is
			// bounded by the resolver (a handful of plan tiers + "anon"
			// + "unknown") × 2 kinds × 5 status classes ≈ 50 series.
			// Crucially we do NOT label by route here; the SLO is
			// "the tenant's traffic", not "the tenant's per-route
			// traffic" (that would multiply 5 tiers × ~80 routes ×
			// 2 kinds × 5 codes = 4k series for a metric meant to
			// drive a couple of burn-rate alerts per tier).
			r.TenantRequests.WithLabelValues(slot.tier, kind, code).Inc()
		})
	}
}

// Handler returns the /metrics exposition handler with the access
// gate baked in. The gate is one of:
//
//   1. Basic auth — when both METRICS_BASIC_AUTH_USER and
//      METRICS_BASIC_AUTH_PASSWORD env vars are set on the process
//      that calls Handler(). This is the production-recommended path:
//      Prometheus scrape configs set `basic_auth: { username, password }`
//      and the credentials never travel in URLs.
//
//   2. Loopback-only — when basic auth is unset. Requests from
//      127.0.0.0/8, ::1, or unix sockets (RemoteAddr == "@") are
//      allowed; everything else gets 403. This makes a fresh dev
//      checkout work with `curl localhost:8080/metrics` while
//      preventing accidental public exposure when the operator
//      forgets to set credentials.
//
// `user` and `pass` are passed in (rather than read from os.Getenv
// here) so the API and worker processes can share a single helper
// without each one re-reading the env independently — the bootstrap
// in main.go reads once and decides.
func (r *Registry) Handler(user, pass string) http.Handler {
	// EnableOpenMetrics turns on the exposition format that includes
	// exemplars (the trace_id / request_id pointers attached to
	// histogram observations). Prometheus content-negotiates: scrapers
	// that only speak text/plain still get a clean response, those
	// that speak application/openmetrics-text get the exemplars.
	base := promhttp.HandlerFor(r.Reg, promhttp.HandlerOpts{
		ErrorHandling:     promhttp.ContinueOnError,
		Registry:          r.Reg,
		EnableOpenMetrics: true,
	})
	return AccessGuard(user, pass, base)
}

// AccessGuard wraps an arbitrary handler with the same gate Handler()
// uses. Exported so tests and any out-of-tree mounts can reuse the
// exact same access policy.
func AccessGuard(user, pass string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if user != "" && pass != "" {
			u, p, ok := r.BasicAuth()
			if !ok || !constantTimeEqual(u, user) || !constantTimeEqual(p, pass) {
				w.Header().Set("WWW-Authenticate", `Basic realm="metrics"`)
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
			return
		}

		// No basic auth configured — fall back to loopback-only. The
		// safe default avoids the historical mistake of leaving
		// /metrics public on the internet.
		if !isLoopback(r.RemoteAddr) {
			http.Error(w, "metrics endpoint requires METRICS_BASIC_AUTH_USER/PASSWORD when not on loopback", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// --- helpers --------------------------------------------------------

type statusRecorder struct {
	http.ResponseWriter
	status     int
	bytes      int
	wroteHead  bool
}

func (s *statusRecorder) WriteHeader(code int) {
	if !s.wroteHead {
		s.status = code
		s.wroteHead = true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(p []byte) (int, error) {
	if !s.wroteHead {
		s.wroteHead = true
	}
	n, err := s.ResponseWriter.Write(p)
	s.bytes += n
	return n, err
}

func chiRoutePattern(r *http.Request) string {
	if rc := chi.RouteContext(r.Context()); rc != nil {
		if p := rc.RoutePattern(); p != "" {
			// Drop chi's "/*" subroute marker so a mounted subrouter
			// looks the same as a flat route to the dashboards.
			p = strings.TrimSuffix(p, "/*")
			if len(p) > 1 {
				p = strings.TrimSuffix(p, "/")
			}
			return p
		}
	}
	return ""
}

// MarkCronRun records the current unix timestamp against a named
// cron job so the corresponding deadman alert can fire if the gauge
// stops advancing. Safe to call from any goroutine; cheap enough to
// call once per tick.
//
// `name` should be a stable, low-cardinality identifier ("schedules",
// "billing-reconcile", "archive-purge", ...) — never a user-supplied
// value. The Prometheus side keeps one series per name forever, so
// dynamic names are a leak.
func (r *Registry) MarkCronRun(name string) {
	if r == nil || r.CronLastRun == nil {
		return
	}
	r.CronLastRun.WithLabelValues(name).Set(float64(time.Now().Unix()))
}

// requestExemplar builds the label set for a Prometheus exemplar
// from the inbound request. We pull two stable IDs:
//
//   - trace_id from the W3C traceparent header (00-{32hex}-{16hex}-{flags}).
//     This is the canonical OpenTelemetry handoff — when a downstream
//     gateway or service mesh injects traceparent, the exemplar
//     points the operator straight at the trace in their tracing
//     backend (Tempo, Honeycomb, Datadog).
//
//   - request_id from chi's middleware.RequestID, which is what our
//     own logs are keyed by. This is the fallback when no trace
//     header is present, and it's what the audit log + slog records
//     correlate against.
//
// Cardinality concern: exemplars don't bloat series count (they're
// stored alongside individual samples, not as a label dimension), but
// the labels themselves still appear once per exemplar. The 128-byte
// total exemplar-label budget is enforced by Prometheus; both IDs
// here are short hex strings well inside that budget.
func requestExemplar(req *http.Request) prometheus.Labels {
	labels := prometheus.Labels{}
	if tp := req.Header.Get("traceparent"); tp != "" {
		if traceID := parseTraceparent(tp); traceID != "" {
			labels["trace_id"] = traceID
		}
	}
	if rid := chimw.GetReqID(req.Context()); rid != "" {
		labels["request_id"] = rid
	}
	if len(labels) == 0 {
		return nil
	}
	return labels
}

// parseTraceparent extracts the 32-hex trace_id from a W3C
// traceparent header. Format is `version-traceid-spanid-flags`,
// e.g. `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`.
// We tolerate other versions (forward-compat) but require the
// trace_id to be 32 hex chars; anything else is treated as missing.
func parseTraceparent(h string) string {
	parts := strings.Split(h, "-")
	if len(parts) < 4 {
		return ""
	}
	tid := parts[1]
	if len(tid) != 32 {
		return ""
	}
	for i := 0; i < len(tid); i++ {
		c := tid[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return ""
		}
	}
	// Reject the all-zero trace_id — W3C says invalid.
	allZero := true
	for i := 0; i < len(tid); i++ {
		if tid[i] != '0' {
			allZero = false
			break
		}
	}
	if allZero {
		return ""
	}
	return tid
}

// methodKind splits HTTP methods into "read" vs "write" so per-tier
// SLOs can target each independently. We treat HTTP semantics
// straight: GET/HEAD/OPTIONS are reads; PUT/POST/PATCH/DELETE and
// anything else are writes. Unknown methods are bucketed as "write"
// — a custom verb is almost always a state-changing RPC.
func methodKind(method string) string {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return "read"
	default:
		return "write"
	}
}

func codeBucket(code int) string {
	switch {
	case code >= 500:
		return "5xx"
	case code >= 400:
		return "4xx"
	case code >= 300:
		return "3xx"
	case code >= 200:
		return "2xx"
	default:
		return "1xx"
	}
}

// isLoopback returns true for RemoteAddr values that originated on
// the same host. We accept IPv4 127.0.0.0/8, IPv6 ::1, and Unix
// domain sockets (chi/net.http reports "@" for them).
func isLoopback(remoteAddr string) bool {
	if remoteAddr == "@" || remoteAddr == "" {
		return true
	}
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		// Hostnames in RemoteAddr are unusual but possible behind
		// some proxies — refuse to assume loopback in that case.
		return false
	}
	return ip.IsLoopback()
}

// constantTimeEqual avoids a timing oracle on the basic-auth check.
// crypto/subtle would also work; we use the std-lib `subtle` import
// indirectly via this helper to keep the credential comparison out of
// the hot path of the metrics scrape.
func constantTimeEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := 0; i < len(a); i++ {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}

func nonEmpty(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}
