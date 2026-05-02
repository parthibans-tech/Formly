package main

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/pprof"
	"os"
	"time"

	"github.com/docforge/api/internal/ai"
	"github.com/docforge/api/internal/autotag"
	"github.com/docforge/api/internal/db"
	"github.com/docforge/api/internal/email"
	"github.com/docforge/api/internal/embeddings"
	"github.com/docforge/api/internal/generate"
	"github.com/docforge/api/internal/generate/delivery"
	"github.com/docforge/api/internal/mail"
	"github.com/docforge/api/internal/mergerecipes"
	"github.com/docforge/api/internal/metrics"
	"github.com/docforge/api/internal/pdfmerge"
	"github.com/docforge/api/internal/queue"
	"github.com/docforge/api/internal/scanner"
	"github.com/docforge/api/internal/scheduled"
	"github.com/docforge/api/internal/sharing"
	"github.com/docforge/api/internal/storage"
	"github.com/docforge/api/internal/tracing"
	"github.com/docforge/api/internal/webhooks"
	"github.com/docforge/api/internal/worker"
	"github.com/hibiken/asynq"
	"github.com/joho/godotenv"
)

func main() {
	_ = godotenv.Load()
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	pool, err := db.Connect(context.Background())
	if err != nil {
		logger.Error("db connect", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	// OpenTelemetry tracer for the worker. The worker doesn't
	// receive HTTP requests, but jobs that originate from the API
	// carry a traceparent on the asynq payload (when we add that
	// follow-up); even today, having a tracer running here means
	// the `service.name=formly-worker` node shows up on Tempo's
	// service graph and any future outbound HTTP wrapped in
	// otelhttp will produce well-formed spans.
	tracingShutdown := tracing.Init(context.Background(), "formly-worker")
	defer func() {
		flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := tracingShutdown(flushCtx); err != nil {
			logger.Warn("tracing shutdown", "err", err)
		}
	}()

	store, err := storage.New()
	if err != nil {
		logger.Error("storage init", "err", err)
		os.Exit(1)
	}

	// Prometheus registry — built early so the AI client can be wrapped
	// with the observer at construction time. /metrics is exposed on a
	// dedicated listener further down (asynq has no HTTP surface).
	metricsReg := metrics.New(metrics.Options{
		Process: "worker",
		Version: os.Getenv("APP_VERSION"),
		Commit:  os.Getenv("APP_COMMIT"),
	})
	metricsReg.StartDBPoolCollector(context.Background(), pool)

	runner := &generate.Runner{DB: pool, Storage: store}
	// Async renders go through this same Runner, so the post-render
	// delivery fan-out (auto-share-link + auto-email) needs the same
	// adapters wired here that the API process wires in cmd/api/main.go.
	// Without these the worker would silently skip delivery on every
	// scheduled / queued render — surprising integrators who set
	// `delivery.email.enabled` and saw it work in the playground but
	// not in production.
	workerSharing := sharing.New(pool, store)
	workerMailer := mail.NewMailer(pool)
	runner.ShareCreator = workerShareAdapter{h: workerSharing}
	runner.Mailer = workerMailerAdapter{m: workerMailer}
	// PDF merge handler shares its lifecycle with the HTTP layer; the
	// worker only needs the queue-processing methods on it. Queue here
	// is unused (workers don't enqueue) so we leave it nil.
	pm := pdfmerge.New(pool, store, nil)
	// Recipe runner — shares Runner + PDFMerge with the HTTP layer so a
	// recipe rendered async produces byte-identical output to one
	// rendered inline.
	mr := mergerecipes.New(pool, store, runner, pm, nil)
	// AI client — same off-by-default contract as the API process. When
	// AI_ENABLED is unset we get a Disabled provider; the embed handler
	// will gracefully no-op for any TaskEmbedFile that arrives (e.g.
	// from a stale enqueue before AI was turned off).
	aiClient := ai.WithMetrics(ai.NewFromEnv(), workerAIObserver{reg: metricsReg})
	var emb *embeddings.Embedder
	if aiClient.Enabled() && aiClient.Capabilities().Embed {
		emb = embeddings.New(pool, store, aiClient, logger)
	}
	// Auto-tag piggy-backs on Chat (not Embed): some providers ship
	// chat-only (Anthropic) and we still want auto-tag there even
	// though Smart Search stays disabled. Constructed independently
	// so each feature can light up on its own capability gate.
	var tg *autotag.Tagger
	if aiClient.Enabled() && aiClient.Capabilities().Chat {
		tg = autotag.New(pool, store, aiClient, logger)
	}

	h := &worker.Handlers{
		DB: pool, Storage: store, Runner: runner, Log: logger,
		PDFMerge: pm, MergeRecipes: mr,
		// Scanner selection is env-driven so dev/CI default to Noop
		// without any config and prod attaches to ClamAV via
		// CLAMAV_ADDR. See scanner.FromEnv for the precedence ladder.
		Scanner:  scanner.FromEnv(os.Getenv),
		Embedder: emb,
		Tagger:   tg,
	}
	logger.Info("scanner selected", "engine", h.Scanner.Name())
	logger.Info("ai", "enabled", aiClient.Enabled(), "provider", aiClient.Provider())

	// /metrics is served on a dedicated listener since asynq has no
	// HTTP surface of its own. Default :9090 is the canonical "metrics
	// on a sidecar port" choice — distinct from the API's public port
	// so a single Prometheus job can target both with one relabel.
	// Auth gating mirrors the API path: basic auth in production,
	// loopback-only in dev.
	metricsAddr := os.Getenv("WORKER_METRICS_ADDR")
	if metricsAddr == "" {
		metricsAddr = ":9090"
	}
	go func() {
		mux := http.NewServeMux()
		metricsUser := os.Getenv("METRICS_BASIC_AUTH_USER")
		metricsPass := os.Getenv("METRICS_BASIC_AUTH_PASSWORD")
		mux.Handle("/metrics", metricsReg.Handler(metricsUser, metricsPass))
		mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ok\n"))
		})

		// /debug/pprof/* — same access guard as /metrics so Pyroscope
		// can scrape continuous profiles from the worker. Unlike the
		// API (which uses chi.Mount via internal/profiling), this
		// process speaks raw http.ServeMux — register each pprof
		// handler explicitly through metrics.AccessGuard so the
		// profile surface stays gated identically to /metrics.
		guard := func(h http.Handler) http.Handler {
			return metrics.AccessGuard(metricsUser, metricsPass, h)
		}
		mux.Handle("/debug/pprof/", guard(http.HandlerFunc(pprof.Index)))
		mux.Handle("/debug/pprof/cmdline", guard(http.HandlerFunc(pprof.Cmdline)))
		mux.Handle("/debug/pprof/profile", guard(http.HandlerFunc(pprof.Profile)))
		mux.Handle("/debug/pprof/symbol", guard(http.HandlerFunc(pprof.Symbol)))
		mux.Handle("/debug/pprof/trace", guard(http.HandlerFunc(pprof.Trace)))
		for _, name := range []string{"allocs", "block", "goroutine", "heap", "mutex", "threadcreate"} {
			mux.Handle("/debug/pprof/"+name, guard(pprof.Handler(name)))
		}
		srv := &http.Server{
			Addr:              metricsAddr,
			Handler:           mux,
			ReadHeaderTimeout: 5 * time.Second,
		}
		logger.Info("worker metrics listening", "addr", metricsAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("worker metrics server", "err", err)
		}
	}()

	srv := asynq.NewServer(queue.ClientOpt(), asynq.Config{
		Concurrency: 4,
		Queues:      map[string]int{"default": 1},
	})
	mux := asynq.NewServeMux()
	// Metrics middleware mounted before handler registration so it
	// wraps every task — including the bespoke webhook handler
	// registered below — and emits the same {queue,task,result}
	// labels the dashboards expect.
	mux.Use(metricsReg.AsynqMiddleware())
	h.Register(mux)

	// Webhook delivery task (retries via asynq exponential backoff).
	whh := &webhooks.Handler{DB: pool}
	whh.SetMetricsObserver(func(result string, _ int, dur time.Duration) {
		// `code` is dropped at the metric layer — bucketed in `result`
		// already. The deliveries DB table keeps the raw code for
		// drill-down forensics.
		metricsReg.WebhookDeliveries.WithLabelValues(result).Inc()
		metricsReg.WebhookDuration.WithLabelValues(result).Observe(dur.Seconds())
	})
	mux.HandleFunc(queue.TaskWebhookDeliver, whh.ProcessDelivery)

	// Scheduled-jobs tick: every minute, fan due schedules into generate tasks.
	qc := asynq.NewClient(queue.ClientOpt())
	sch := scheduled.New(pool, qc)
	go func() {
		ctx := context.Background()
		tick := time.NewTicker(60 * time.Second)
		defer tick.Stop()
		// Fire immediately once at boot so short-interval schedules don't
		// have to wait a full minute.
		if n, err := sch.Tick(ctx); err == nil {
			// Tier 4 deadman: mark every successful tick, even when no
			// schedules fired — the alert fires when this gauge STOPS
			// advancing, so an idle scheduler must still record its
			// heartbeat. The gauge stays unset on error so a failing
			// tick correctly looks like a stuck cron.
			metricsReg.MarkCronRun("schedules")
			if n > 0 {
				logger.Info("schedules fired", "count", n)
			}
		}
		for range tick.C {
			n, err := sch.Tick(ctx)
			if err != nil {
				logger.Error("schedule tick", "err", err)
				continue
			}
			metricsReg.MarkCronRun("schedules")
			if n > 0 {
				logger.Info("schedules fired", "count", n)
			}
		}
	}()

	logger.Info("worker listening", "redis", queue.RedisAddr())
	if err := srv.Run(mux); err != nil {
		logger.Error("worker stopped", "err", err)
		os.Exit(1)
	}
}

// workerShareAdapter / workerMailerAdapter mirror the adapters in
// cmd/api/main.go — see the comments there. Duplicated rather than
// extracted to a shared package because adapters are wiring code
// (the only place that knows about both sides), and consolidating
// them would add a tiny package whose only purpose is to glue four
// types together.
type workerShareAdapter struct{ h *sharing.Handler }

func (a workerShareAdapter) CreateShareLink(ctx context.Context, opts delivery.ShareCreateOptions) (delivery.ShareCreateResult, error) {
	res, err := a.h.CreateInternal(ctx, sharing.InternalCreateOptions{
		OrgID:         opts.OrgID,
		UserID:        opts.UserID,
		FileID:        opts.FileID,
		Role:          opts.Role,
		ExpiresIn:     opts.ExpiresIn,
		Password:      opts.Password,
		OneTime:       opts.OneTime,
		DownloadLimit: opts.DownloadLimit,
	})
	if err != nil {
		return delivery.ShareCreateResult{}, err
	}
	return delivery.ShareCreateResult{ShareID: res.ShareID, Token: res.Token, URL: res.URL}, nil
}

type workerMailerAdapter struct{ m *mail.Mailer }

func (a workerMailerAdapter) Send(ctx context.Context, opts delivery.EmailSendOptions) (string, error) {
	return a.m.Send(ctx, mail.SendOptions{
		OrgID:        opts.OrgID,
		UserID:       opts.UserID,
		TemplateID:   opts.TemplateID,
		OutputFileID: opts.OutputFileID,
		Kind:         opts.Kind,
		Source:       opts.Source,
		Message: email.Message{
			To:          opts.To,
			CC:          opts.CC,
			BCC:         opts.BCC,
			Subject:     opts.Subject,
			TextBody:    opts.TextBody,
			HTMLBody:    opts.HTMLBody,
			Attachments: opts.Attachments,
		},
		Metadata: opts.Metadata,
	})
}

// workerAIObserver bridges ai.Observer onto the prometheus AI vectors
// from the worker process. Mirrors metricsAIObserver in cmd/api/main.go
// — kept distinct (rather than shared in internal/metrics) because
// neither package should grow a dependency on the other; main is the
// wiring level by design.
type workerAIObserver struct {
	reg *metrics.Registry
}

func (o workerAIObserver) Observe(op, provider string, dur time.Duration, tokensIn, tokensOut int, err error) {
	if o.reg == nil {
		return
	}
	if op == "" {
		op = "unknown"
	}
	if provider == "" {
		provider = "unknown"
	}
	result := "ok"
	if err != nil {
		result = "error"
	}
	o.reg.AIRequests.WithLabelValues(provider, op, result).Inc()
	o.reg.AIDuration.WithLabelValues(provider, op).Observe(dur.Seconds())
	if tokensIn > 0 {
		o.reg.AITokens.WithLabelValues(provider, op, "prompt").Add(float64(tokensIn))
	}
	if tokensOut > 0 {
		o.reg.AITokens.WithLabelValues(provider, op, "completion").Add(float64(tokensOut))
	}
}
