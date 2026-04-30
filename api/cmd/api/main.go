package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/docforge/api/internal/ai"
	"github.com/docforge/api/internal/aisearch"
	"github.com/docforge/api/internal/apikeys"
	"github.com/docforge/api/internal/audit"
	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/billing"
	"github.com/docforge/api/internal/comments"
	"github.com/docforge/api/internal/compliance"
	"github.com/docforge/api/internal/db"
	"github.com/docforge/api/internal/docchat"
	"github.com/docforge/api/internal/email"
	"github.com/docforge/api/internal/embeddings"
	"github.com/docforge/api/internal/files"
	"github.com/docforge/api/internal/folders"
	"github.com/docforge/api/internal/images"
	"github.com/docforge/api/internal/embed"
	"github.com/docforge/api/internal/formlinks"
	"github.com/docforge/api/internal/jobs"
	"github.com/docforge/api/internal/mail"
	"github.com/docforge/api/internal/mfa"
	"github.com/docforge/api/internal/mockdata"
	"github.com/docforge/api/internal/observability"
	"github.com/docforge/api/internal/ocr"
	"github.com/docforge/api/internal/ocrprofiles"
	"github.com/docforge/api/internal/memberships"
	"github.com/docforge/api/internal/metrics"
	"github.com/docforge/api/internal/onlyoffice"
	"github.com/docforge/api/internal/orggate"
	"github.com/docforge/api/internal/platform"
	"github.com/docforge/api/internal/promquery"
	"github.com/docforge/api/internal/vault"
	"github.com/docforge/api/internal/platformaudit"
	"github.com/docforge/api/internal/me"
	"github.com/docforge/api/internal/orgdashboard"
	"github.com/docforge/api/internal/orgs"
	"github.com/docforge/api/internal/platformdashboard"
	"github.com/docforge/api/internal/platformorgs"
	"github.com/docforge/api/internal/platformusers"
	"github.com/docforge/api/internal/presence"
	"github.com/docforge/api/internal/queue"
	"github.com/docforge/api/internal/reviewlinks"
	"github.com/docforge/api/internal/reviews"
	"github.com/docforge/api/internal/scheduled"
	"github.com/docforge/api/internal/security"
	"github.com/docforge/api/internal/sessions"
	"github.com/docforge/api/internal/sharing"
	"github.com/docforge/api/internal/starterai"
	"github.com/docforge/api/internal/starterbilling"
	"github.com/docforge/api/internal/legalai"
	"github.com/docforge/api/internal/hrai"
	"github.com/docforge/api/internal/certai"
	"github.com/docforge/api/internal/letterai"
	"github.com/docforge/api/internal/reportsai"
	"github.com/docforge/api/internal/marketingai"
	"github.com/docforge/api/internal/opsai"
	"github.com/docforge/api/internal/eventtools"
	"github.com/docforge/api/internal/eduai"
	"github.com/docforge/api/internal/storage"
	"github.com/docforge/api/internal/team"
	"github.com/docforge/api/internal/templates"
	"github.com/docforge/api/internal/tracing"
	"github.com/docforge/api/internal/uploadpolicy"
	"github.com/docforge/api/internal/mergerecipes"
	"github.com/docforge/api/internal/pdfmerge"
	"github.com/docforge/api/internal/textcontent"
	"github.com/docforge/api/internal/webhooks"
	"github.com/hibiken/asynq"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

func main() {
	_ = godotenv.Load()
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	ctx := context.Background()
	pool, err := db.Connect(ctx)
	if err != nil {
		logger.Error("db connect", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	if err := runMigrations(ctx, pool); err != nil {
		logger.Error("migrate", "err", err)
		os.Exit(1)
	}
	logger.Info("migrations applied")

	// OpenTelemetry tracer — set up before the metrics registry so
	// the metrics middleware (mounted later) can read the same
	// trace_id we'll inject into the request context. Disabled by
	// default in environments without OTEL_EXPORTER_OTLP_ENDPOINT;
	// returns a no-op shutdown so the deferred call below is safe.
	tracingShutdown := tracing.Init(ctx, "formly-api")
	defer func() {
		// Bounded shutdown — don't let a wedged Tempo block
		// process exit. 5s is generous for the in-flight batch
		// flush plus the OTLP HTTP roundtrip.
		flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := tracingShutdown(flushCtx); err != nil {
			logger.Warn("tracing shutdown", "err", err)
		}
	}()

	// Prometheus registry — constructed early so downstream services
	// (AI client, mail observer) can hand metrics into the wiring as
	// they're built. The /metrics handler that exposes this registry
	// is mounted later, after the chi router is set up.
	metricsReg := metrics.New(metrics.Options{
		Process: "api",
		Version: os.Getenv("APP_VERSION"),
		Commit:  os.Getenv("APP_COMMIT"),
	})
	metricsReg.StartDBPoolCollector(ctx, pool)
	// Adapter satisfies ai.Observer by funnelling each call into the
	// AIRequests counter and AIDuration histogram. Token counts will
	// land here once ChatResponse carries usage data — for now the
	// observer pushes 0/0 and the metrics package treats 0 as
	// "unknown" (no AITokens samples emitted on that path).
	aiObserver := metricsAIObserver{reg: metricsReg}

	store, err := storage.New()
	if err != nil {
		logger.Error("storage init", "err", err)
		os.Exit(1)
	}
	logger.Info("storage ready", "bucket", store.Bucket())

	qc := asynq.NewClient(queue.ClientOpt())
	defer qc.Close()

	a := auth.New(pool)

	// Tier 2 metrics wiring. Three independent threads:
	//
	//  1. Tenant annotator — runs from auth middleware after Claims are
	//     attached; resolves the org's billing tier (cached, 30s TTL)
	//     and stashes it in the metrics request slot so the outer
	//     metrics middleware can label the per-tier SLO counter.
	//
	//  2. Login-attempt observer — fires from auth.Login / auth.Register
	//     and the MFA branch with stable {kind, result} labels.
	//
	// Wired here (not in metrics.New) so the metrics package keeps zero
	// imports of auth/billing and is unit-testable in isolation.
	planResolver := newPlanTierResolver(pool)
	a.TenantAnnotator = func(req *http.Request) {
		c, _ := req.Context().Value(auth.UserCtxKey).(*auth.Claims)
		if c == nil || c.OrgID == "" {
			return
		}
		metrics.SetRequestTenant(req, planResolver.Resolve(req.Context(), c.OrgID))
	}
	a.OnLoginAttempt = func(_ context.Context, kind, result string) {
		metricsReg.AuthAttempts.WithLabelValues(kind, result).Inc()
	}
	t := templates.New(pool, store)
	t.Queue = qc
	// Surface the org-level iframe-sandbox token in PreviewURL responses
	// so the frontend's <iframe sandbox="..."> stays in lockstep with
	// the active upload policy. Wired after upSvc is constructed below.
	// Layered upload-policy resolver: product_config → org_upload_config.
	// Wired into the files handler so every CreateUploadURL / Complete
	// path enforces the same rules without each handler re-reading the
	// DB.
	upSvc := uploadpolicy.New(pool)
	upH := uploadpolicy.NewHandler(upSvc)
	t.Policy = upSvc
	f := files.New(pool, store)
	f.Detector = t.DetectAndCreate
	f.Queue = qc
	f.Policy = upSvc
	img := images.New(pool, store)
	md := mockdata.New(pool)
	jh := jobs.New(pool)
	fh := folders.New(pool)
	sh := sharing.New(pool, store)
	ak := apikeys.New(pool)
	wh := webhooks.New(pool, qc)
	wh.WireEventBus()
	fl := formlinks.New(pool, store, t.Runner)
	mh := mail.New(pool, store, t.Runner)
	// Wire the central Mailer into sharing so access-request flows can
	// send notifications. The adapter is a one-method shim that lets
	// `internal/sharing` stay free of an `internal/mail` import (and
	// therefore of `internal/email` + `internal/generate`).
	sh.Mailer = mailerAdapter{m: mh.Mailer}
	sc := scheduled.New(pool, qc)
	tm := team.New(pool, a)
	// Same adapter pattern as sharing — gives team invites a path to
	// the central Mailer without making `internal/team` import
	// `internal/mail` directly.
	tm.Mailer = teamMailerAdapter{m: mh.Mailer}
	cm := comments.New(pool)
	rv := reviews.New(pool)
	pr := presence.New(pool)
	rl := reviewlinks.New(pool)
	embedH := embed.New(pool, upSvc)

	// ONLYOFFICE Document Server integration. Optional — if the JWT
	// secret env var isn't set, we leave the routes unwired so deploys
	// without a document server fall back to the existing behaviour
	// (download / PDF-export). New() returns the config error so we can
	// log it once at startup and move on.
	oo, ooErr := onlyoffice.New(pool, store)
	if ooErr != nil {
		logger.Info("onlyoffice disabled", "reason", ooErr.Error())
	}

	// Code-editor (CodeMirror) backend. Pure GET/PUT of UTF-8 text;
	// no third-party dance, just our API and the browser.
	tc := textcontent.New(pool, store)

	// PDF merge / stitch / page-ops module. Sync path runs inline for
	// small native-PDF jobs; large or heterogeneous (DOCX/RTF/image)
	// inputs route through asynq via the shared queue client.
	pm := pdfmerge.New(pool, store, qc)

	// Saved merge recipes — the productized merge module. CRUD lives
	// in /v1/merge-recipes; running a recipe shares the merge_jobs
	// table (and therefore /v1/merge-jobs/{id} polling) with the
	// ad-hoc /v1/files/merge endpoint.
	mr := mergerecipes.New(pool, store, t.Runner, pm, qc)

	// Security & compliance handlers.
	ad := audit.New(pool)
	mf := mfa.New(pool, a)
	ss := sessions.New(pool)
	cp := compliance.New(pool)
	vt := vault.New(pool)

	// AI seam — off by default. Turning on requires the operator to
	// set AI_ENABLED=1 (and pick a provider). When off, NewFromEnv
	// returns a Disabled client whose every method returns
	// ErrDisabled, and the public /v1/ai/config endpoint reports
	// `enabled:false` so the frontend hides AI affordances.
	aiClient := ai.WithMetrics(ai.NewFromEnv(), aiObserver)
	logger.Info("ai", "enabled", aiClient.Enabled(), "provider", aiClient.Provider())
	aiH := ai.NewHandler(aiClient)

	// Tell the files handler to enqueue TaskEmbedFile from Complete()
	// only when AI is on AND the active provider supports embeddings.
	// Anthropic-only deployments keep search disabled (no Embed API);
	// Ollama/vLLM enable it. The flag is read at boot and not mutable
	// at runtime — flipping AI on/off requires a restart, same as
	// every other env-driven config in this app.
	f.AIEmbedEnabled = aiClient.Enabled() && aiClient.Capabilities().Embed
	// Auto-tag uses Chat (not Embed) so it can light up even on chat-
	// only providers — the file handler enqueues TaskAutoTagFile from
	// Complete() when this flag is on.
	f.AIAutoTagEnabled = aiClient.Enabled() && aiClient.Capabilities().Chat

	// Smart-search HTTP surface. Constructed unconditionally so the
	// route mount stays in one place; the handler self-503s when AI is
	// off so a request never reaches the embedder in disabled mode.
	// Sharing the same Embedder instance with the worker (via the AI
	// client) keeps query-side and index-side embeddings model-aligned.
	embedder := embeddings.New(pool, store, aiClient, logger)
	asH := aisearch.New(pool, embedder, aiClient)
	// "Summarize / Ask in document preview" — same off-by-default
	// contract as aisearch (handler self-503s when AI is off / chat
	// capability is missing). Lives in its own package so the AI
	// dependency stays out of the everyday files handler.
	//
	// OCR is layered on via WithOCR. When OCR_ENABLED is unset the call
	// is a no-op so the docchat handler still 415s on scanned PDFs and
	// images — exactly the behaviour pre-OCR. We probe the binaries on
	// startup and log a clear warning if they're missing so an operator
	// who flips the flag without installing tesseract+pdftoppm sees the
	// problem immediately rather than per-request.
	ocrCfg := ocr.FromEnv()
	if ocrCfg.Enabled {
		if err := ocrCfg.Probe(); err != nil {
			logger.Warn("ocr.probe_failed",
				"error", err.Error(),
				"hint", "install tesseract-ocr and poppler-utils, or unset OCR_ENABLED")
		} else {
			logger.Info("ocr.enabled",
				"lang", ocrCfg.Lang, "max_pages", ocrCfg.MaxPages, "dpi", ocrCfg.DPI)
		}
	}
	// OCR profile registry + CRUD. The handler owns the DBRegistry
	// instance; we reuse it on docchat so /extract-text reads from
	// the same DB-backed source the picker writes to. Built-ins live
	// alongside org-authored profiles in the `ocr_profiles` table
	// (migration 047); the package falls back to a hardcoded static
	// set when the DB is empty (fresh dev box pre-migration).
	opH := ocrprofiles.NewHandler(pool)
	dcH := docchat.New(pool, store, aiClient, logger).WithOCR(ocrCfg)
	dcH.Profiles = opH.Registry
	// Resume / certificate designer surface. Owns the AI cards
	// (/profile-summary, /cover-letter, /review) and the inline-HTML
	// render pipeline (/export, /save-to-drive) that powers the
	// designer's Download and "Save to Drive" buttons. Reuses the
	// shared aiClient and storage instances; no extra deps.
	saH := starterai.New(pool, store, aiClient, logger)

	// Category-level starter handlers. Each owns the AI / pure-function
	// surface for one starter category (Billing, Legal, HR, etc.). All
	// share the aiClient + logger; none own DB state of their own.
	// Mount points are documented per-package — see internal/<pkg>/<pkg>.go.
	sbH := starterbilling.New(aiClient, logger)
	laH := legalai.New(aiClient, logger)
	hrH := hrai.New(aiClient, logger)
	caH := certai.New(aiClient, logger)
	leH := letterai.New(aiClient, logger)
	raH := reportsai.New(aiClient, logger)
	maH := marketingai.New(aiClient, logger)
	osH := opsai.New(aiClient, logger)
	etH := eventtools.New(logger)
	euH := eduai.New(aiClient, logger)

	// Super-admin user management (Phase 1 — list, lock, MFA reset,
	// session revoke). Routes are protected by the requireSuperAdmin
	// middleware below; the handler trusts that gate and only writes
	// audit rows for state-changing actions.
	pu := platformusers.New(pool)
	// Phase 3: org-level controls + cross-org audit + memberships.
	po := platformorgs.New(pool)
	pa := platformaudit.New(pool)
	pd := platformdashboard.New(pool)
	od := orgdashboard.New(pool)
	meh := me.New(pool)
	// /v1/me/profile surfaces the org logo URL too — the me handler
	// needs the storage client to mint a presigned GET on each read.
	meh.AttachStore(store)
	// Org branding (logo upload / delete). Lives on /v1/orgs/me/* so
	// the namespace stays predictable as we grow per-tenant settings.
	orgsH := orgs.New(pool, store)
	mb := memberships.New(pool, a)
	// Phase 4a: subscription module (read-only catalog + manual provider).
	// Phase 4b: live providers — Razorpay (INR) and Stripe (USD/other).
	// Either driver may be unconfigured; in that case the handler returns
	// 501 to nudge the operator to set credentials in .env.
	bl := billing.New(pool)
	bl.AttachDrivers(billing.Drivers{
		Razorpay: billing.NewRazorpayDriver(pool,
			os.Getenv("RAZORPAY_KEY_ID"),
			os.Getenv("RAZORPAY_KEY_SECRET"),
			os.Getenv("RAZORPAY_WEBHOOK_SECRET")),
		Stripe: billing.NewStripeDriver(pool,
			os.Getenv("STRIPE_SECRET_KEY"),
			os.Getenv("STRIPE_WEBHOOK_SECRET")),
	})
	bl.AttachMailer(mh.Mailer)
	bl.WireNotifier(ctx)
	// Tier 4 deadman: each dunning tick stamps the cron gauge so the
	// "billing-dunning hasn't run in N hours" alert can fire if this
	// goroutine wedges or its context is canceled by accident.
	bl.OnDunningTick = func() { metricsReg.MarkCronRun("billing-dunning") }
	bl.StartDunningLoop(ctx, time.Hour)
	a.OnRegister = func(ctx context.Context, q auth.PostRegisterDB, orgID string) error {
		return billing.StartTrial(ctx, q, orgID)
	}

	// Observability: request metrics aggregator + health checker + error
	// recorder. The aggregator is middleware-scoped; health probes run in the
	// background; /v1/ops/* routes read both.
	obsAgg := observability.NewAggregator()
	obsChecker := &observability.Checker{
		DB:      pool,
		Storage: store.Ping,
		Redis:   queue.ClientOpt(),
	}
	obs := observability.New(pool, obsAgg, obsChecker, queue.ClientOpt())
	observability.StartFlusher(ctx, pool, obsAgg)
	observability.StartHealthLoop(ctx, pool, obsChecker, time.Minute)

	// Mail observer — fires once per Send so we can alert on mail
	// failures by kind (invite, billing_*, access_request_*) and
	// provider. Wired here (rather than next to metricsReg above)
	// because mh.Mailer is constructed further down the boot chain.
	// Kept as a hook on the Mailer to keep `internal/mail` free of
	// any prometheus import.
	mh.Mailer.SetMetricsObserver(func(kind, provider string, ok bool) {
		result := "sent"
		if !ok {
			result = "failed"
		}
		if kind == "" {
			kind = "unknown"
		}
		if provider == "" {
			provider = "unknown"
		}
		metricsReg.MailSent.WithLabelValues(kind, provider, result).Inc()
	})
	// Credentials for the /metrics scrape gate. When unset, the handler
	// falls back to loopback-only — safe default for dev, matches what
	// most homelab Prometheus instances do anyway. Set both env vars in
	// production so scrapers off-host can authenticate.
	metricsUser := os.Getenv("METRICS_BASIC_AUTH_USER")
	metricsPass := os.Getenv("METRICS_BASIC_AUTH_PASSWORD")

	// Wire auth hooks so login → session tracking + audit, middleware →
	// revocation check, login → optional MFA challenge.
	a.MFAChallengeRequired = mf.ChallengeRequired
	a.MFAVerifyChallenge = mf.VerifyChallenge
	a.OnLogin = func(ctx context.Context, userID, orgID, token, ip, ua string) {
		sessions.Record(ctx, pool, userID, orgID, token, ip, ua)
	}
	a.OnLogout = func(ctx context.Context, token string) {
		if token == "" {
			return
		}
		_, _ = pool.Exec(ctx,
			`UPDATE user_sessions SET revoked_at=now()
			  WHERE token_hash=$1 AND revoked_at IS NULL`,
			sessions.HashToken(token))
	}
	a.SessionRevokedCheck = func(ctx context.Context, token string) bool {
		return sessions.IsRevoked(ctx, pool, token)
	}
	a.AuditFn = func(ctx context.Context, action, uid, oid, email, ip, ua string, meta map[string]any) {
		audit.Log(ctx, pool, audit.Event{
			OrgID: oid, ActorID: uid, ActorEmail: email,
			Action: action, IP: ip, UserAgent: ua, Meta: meta,
		})
	}

	// Vault re-uses the same audit sink + the existing MFA hooks so
	// unlocks get the same enforcement as fresh logins.
	vt.AuditFn = a.AuditFn
	vt.MFAVerify = mf.VerifyChallenge
	vt.MFARequired = mf.ChallengeRequired

	// Register the API key verifier with auth so Bearer tokens starting with
	// `fk_` authenticate against the api_keys table instead of as a JWT. We
	// register the v2 verifier so the auth middleware attaches the key ID +
	// scopes to the request context (used by scope-guard + per-key logger).
	//
	// Tier 2: classify the verifier outcome into a small enum (ok /
	// invalid / revoked / expired / error) and increment APIKeyAuth.
	// `invalid` + `revoked` dominating with no `ok` is the canonical
	// leaked-key-being-scanned signal.
	auth.RegisterAPIKeyVerifierV2(func(r *http.Request, raw string) (string, string, string, string, string, []string, error) {
		uid, oid, email, role, keyID, scopes, err := apikeys.VerifyAndLoadV2(pool, r, raw)
		metricsReg.APIKeyAuth.WithLabelValues(apiKeyAuthResult(err)).Inc()
		return uid, oid, email, role, keyID, scopes, err
	})

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)
	// OpenTelemetry server-side spans — mounted between RequestID
	// and the metrics middleware so:
	//   1. The chi RequestID is already on the context (the tracing
	//      middleware copies it onto the span as
	//      `formly.request_id` for cross-system correlation).
	//   2. The metrics middleware sees the W3C `traceparent` header
	//      that this middleware injects, so HTTP histogram exemplars
	//      and the actual span share the same trace_id.
	r.Use(tracing.Middleware())
	// Prometheus HTTP middleware — mounted high so it observes the
	// status the user actually sees (post-Recoverer 5xx, pre-CORS so
	// preflights count). Skips /healthz and /metrics internally to keep
	// cardinality and the latency histogram honest.
	r.Use(metricsReg.Middleware())
	// gzip / deflate response compression. JSON list endpoints (drive,
	// audit, OCR profiles, embeddings search) ship multi-KB payloads
	// that compress 5–10× on the wire; we leave the heavy binary
	// surfaces (file downloads, inline preview, PDF export, image
	// thumbnails, ZIP export) untouched because chi's default MIME
	// allowlist already excludes application/pdf, image/*, and
	// application/octet-stream — re-compressing already-compressed
	// blobs only burns CPU. Level 5 is the standard "balanced" setting
	// — level 9 saves a few percent for ~3× the CPU and isn't worth
	// it on dynamically-rendered JSON. Mounted after Recoverer so a
	// panic deeper in the chain still produces a clean 500 (rather
	// than a half-flushed gzip stream).
	r.Use(middleware.Compress(5))
	// Global request budget. 30s was too tight for any endpoint that
	// invokes Chromium (generate, batch, html preview): cold-start alone
	// can eat 5–10s on dev machines, leaving too little headroom before
	// the parent context fires and surfaces as
	// `chromium render: context deadline exceeded`. 90s gives the render
	// pipeline room and still bounds runaway requests. Individual routes
	// that should stay fast have their own guards (DB statement_timeout,
	// rate limit buckets).
	r.Use(middleware.Timeout(90 * time.Second))
	r.Use(security.Headers())
	// Observability: record per-request timing + capture 5xx responses.
	// Mounted after RequestID so captured errors carry X-Request-Id.
	r.Use(obsAgg.Middleware())
	r.Use(observability.ErrorCapture(pool))
	// CORS_ALLOWED_ORIGINS is a comma-separated list of origins. Falls back
	// to localhost dev so a fresh checkout works without env config.
	corsOrigins := []string{"http://localhost:3000"}
	if v := strings.TrimSpace(os.Getenv("CORS_ALLOWED_ORIGINS")); v != "" {
		corsOrigins = nil
		for _, o := range strings.Split(v, ",") {
			if o = strings.TrimSpace(o); o != "" {
				corsOrigins = append(corsOrigins, o)
			}
		}
	}
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   corsOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		AllowCredentials: true,
	}))

	// Rate-limit auth endpoints (login, register, MFA verify) to slow down
	// credential-stuffing. 30 requests / minute / IP-path is plenty for a
	// human and painful for a bot.
	//
	// Tier 2: Name + OnLimit feed the security RateLimitHits counter.
	// "auth" is the canonical bucket name — a future per-endpoint
	// limiter (e.g. password-reset only) gets its own Name without
	// inflating the bucket label cardinality past a handful.
	authRateLimit := security.RateLimit(pool, security.LimitOpts{
		Window:    time.Minute,
		Max:       30,
		BucketKey: security.LoginBucketKey,
		Name:      "auth",
		OnLimit: func(name string) {
			metricsReg.RateLimitHits.WithLabelValues(name).Inc()
		},
	})

	// Deep health + metrics exposition. Public (unauthenticated) so probes
	// and scrapers can hit them, but return structured data.
	r.Get("/healthz", obs.DeepHealth)
	// /metrics serves the full prom exposition (Go runtime, process,
	// HTTP series, build_info). Auth-gated: basic auth when env creds
	// are set, otherwise loopback-only. The legacy obs.Metrics endpoint
	// (last-hour rollup from request_metrics) moves to /v1/ops/metrics
	// so existing dashboards don't break while we cut over.
	r.Method("GET", "/metrics", metricsReg.Handler(metricsUser, metricsPass))
	r.Get("/v1/ops/metrics", obs.Metrics)

	// OpenAPI spec — public so docs viewers can fetch it without a token.
	r.Get("/v1/openapi.json", platform.OpenAPIHandler())

	r.Route("/v1/auth", func(r chi.Router) {
		r.Use(authRateLimit)
		r.Post("/register", a.Register)
		r.Post("/login", a.Login)
	})

	// Public share resolution (no auth).
	r.Get("/v1/public/shares/{token}/info", sh.Info)
	r.Get("/v1/public/shares/{token}", sh.Resolve)
	r.Post("/v1/public/shares/{token}", sh.Resolve)
	r.Get("/v1/public/forms/{token}", fl.Resolve)
	r.Post("/v1/public/forms/{token}", fl.Submit)
	r.Get("/v1/public/invites/{token}", tm.ResolvePublic)
	r.Post("/v1/public/invites/{token}/accept", tm.Accept)
	r.Get("/v1/public/reviews/{token}", rl.Resolve)
	r.Get("/v1/public/reviews/{token}/comments", rl.PublicListComments)
	r.Post("/v1/public/reviews/{token}/comments", rl.PublicCreateComment)
	r.Post("/v1/public/reviews/{token}/decision", rl.PublicDecide)
	// Embed-policy lookup. The Next.js middleware calls this once per
	// embed-page render to fetch the org's iframe-allowlist before
	// emitting the per-request frame-ancestors CSP. Public + cached.
	r.Get("/v1/public/embed-policy", embedH.Resolve)
	// Phase 4b: provider webhooks. Public — providers don't carry our
	// JWT — but each handler verifies a provider-specific signature and
	// rejects unsigned bodies when the secret is configured.
	r.Post("/v1/webhooks/razorpay", bl.RazorpayWebhook)
	r.Post("/v1/webhooks/stripe", bl.StripeWebhook)

	// ONLYOFFICE document server endpoints. Both content and callback
	// are server-to-server (the document server hits us, not a browser),
	// so they live in the public block — auth is enforced by the
	// short-lived HMAC token + JWT-in-body that ONLYOFFICE attaches.
	// Config is auth'd and lives in the Group() block below.
	if oo != nil {
		r.Get("/v1/files/{id}/onlyoffice/content", oo.Content)
		r.Post("/v1/files/{id}/onlyoffice/callback", oo.Callback)
	}

	r.Group(func(r chi.Router) {
		r.Use(a.Middleware)
		// Org gate (Phase 3): enforce frozen / deleted flags before any
		// business logic runs. Mounted right after the auth middleware
		// so claims are available; before scope/rate/logging so a
		// frozen org's writes never reach the per-key request log.
		r.Use(orggate.Middleware(pool))
		// Platform: scope enforcement + rate-limit headers + per-key request
		// log. All three are cheap and safely chain after the auth middleware
		// (which attaches the API-key info to ctx). Scope guard only applies
		// to API-key-authenticated traffic; JWT callers are passed through.
		r.Use(platform.ScopeGuard())
		r.Use(platform.RateLimitHeaders(600, time.Minute))
		r.Use(platform.RequestLogger(pool))
		r.Get("/v1/me", a.Me)

		// Enriched profile + edit. Lives next to the JWT-claims-only /v1/me
		// so the existing endpoint stays cheap; the Settings → Profile page
		// hits /v1/me/profile to get the richer view.
		r.Get("/v1/me/profile", meh.Get)
		r.Patch("/v1/me/profile", meh.Patch)

		// Per-tenant branding. Admin-only is enforced inside the handler
		// (claims aren't visible at the route declaration site since the
		// require-admin middleware is mounted on a different subtree).
		r.Post("/v1/orgs/me/logo", orgsH.PostLogo)
		r.Delete("/v1/orgs/me/logo", orgsH.DeleteLogo)
		r.Post("/v1/auth/logout", a.Logout)
		r.Post("/v1/auth/set-password", a.SetPassword)

		// Security & compliance.
		ad.Mount(r)
		mf.Mount(r)
		ss.Mount(r)
		cp.Mount(r)

		// AI capability discovery. Single GET that drives both backend
		// gating and frontend feature visibility — no second source of
		// truth to drift from.
		aiH.Mount(r)
		// Smart-search lives behind the same auth middleware as every
		// other authenticated endpoint; the handler itself enforces
		// AI-on + Embed-capable and re-applies file visibility per
		// caller, so admins and viewers see results scoped to what
		// they could already access via /v1/files.
		asH.Mount(r)
		// Summarize / Ask in document preview. Mounted alongside the
		// other AI surfaces; the handler enforces sharing.CanAccessFile
		// + scanner gate per request, identical to /v1/files/{id}/download.
		dcH.Mount(r)
		// Starter / resume designer routes (AI cards + Download +
		// Save to Drive). Mounted next to the other AI surfaces; the
		// LLM endpoints share docchat's "ai_disabled when off" gate
		// and the export ones reuse the same chromium pipeline as the
		// document-mode renderer.
		saH.Mount(r)
		// Category-level starter routes (Billing recalc, Legal redline,
		// HR JD, Certificates citation, Letter rewrite, Reports
		// extract-actions / summarize, Marketing section / headline,
		// Ops SOP, Event ICS / QR, Edu syllabus). Each handler does its
		// own ai_disabled gating where applicable; the pure-function
		// endpoints (recalc, redline, ICS, QR) ignore the AI client
		// entirely.
		sbH.Mount(r)
		laH.Mount(r)
		hrH.Mount(r)
		caH.Mount(r)
		leH.Mount(r)
		raH.Mount(r)
		maH.Mount(r)
		osH.Mount(r)
		etH.Mount(r)
		euH.Mount(r)
		// OCR profiles — small read-only list, used by the Extract
		// Text picker on every designer/preview surface.
		opH.Mount(r)

		// Observability (admin-only inside the handler).
		obs.Mount(r)

		r.Post("/v1/files/upload-url", f.CreateUploadURL)
		r.Post("/v1/files/{id}/complete", f.Complete)
		// Backfill: run DetectAndCreate on a pre-existing file that
		// has no template yet. Lets the Drive click handler open
		// images / HTML / markdown uploaded before their detector
		// shipped without forcing a re-upload.
		r.Post("/v1/files/{id}/ensure-template", f.EnsureTemplate)
		// Explicit, user-triggered office-doc → PDF export. The source
		// stays in its original format; the PDF lands as a sibling row.
		r.Post("/v1/files/{id}/export-pdf", f.ExportPDF)
		// ONLYOFFICE editor config. Auth'd: enforces read/edit ACL and
		// returns the JWT-signed config the browser feeds to DocsAPI.
		// Content + callback (which are server-to-server) live in the
		// public block above.
		if oo != nil {
			r.Get("/v1/files/{id}/onlyoffice/config", oo.Config)
		}
		// Code editor content read/write. Auth'd; ACL enforced inside
		// the handler. Mounted next to the other file routes.
		r.Get("/v1/files/{id}/content", tc.Get)
		r.Put("/v1/files/{id}/content", tc.Put)
		// PDF merge module. /v1/files/merge stitches N inputs into a
		// new PDF; /v1/files/{id}/insert splices a source's pages into
		// an existing PDF in place; /v1/files/{id}/pages handles
		// rotate / remove / extract on a single PDF. Async jobs are
		// reported via /v1/merge-jobs/{id}.
		r.Post("/v1/files/merge", pm.Merge)
		r.Post("/v1/files/{id}/insert", pm.Insert)
		r.Post("/v1/files/{id}/pages", pm.PageOps)
		r.Get("/v1/merge-jobs/{id}", pm.JobStatus)

		// Saved merge recipes (the productized merge module).
		// CRUD: list / get / create / update / delete. Running a
		// recipe is a separate verb because it has side effects (new
		// file row, optional async job).
		r.Get("/v1/merge-recipes", mr.List)
		r.Post("/v1/merge-recipes", mr.Create)
		r.Get("/v1/merge-recipes/{id}", mr.Get)
		r.Patch("/v1/merge-recipes/{id}", mr.Update)
		r.Delete("/v1/merge-recipes/{id}", mr.Delete)
		r.Get("/v1/merge-recipes/{id}/schema", mr.Schema)
		r.Post("/v1/merge-recipes/{id}/run", mr.Run)
		r.Get("/v1/files", f.List)
		r.Get("/v1/files/{id}", f.Get)
		r.Patch("/v1/files/{id}", f.Patch)
		r.Get("/v1/files/{id}/download", f.Download)
		// Bulk download as a streaming ZIP. POSTs an `{ ids: [...] }`
		// body and gets back a `Content-Type: application/zip`
		// streaming response. Replaces the old browser-side
		// "open N tabs" approach which the popup blocker silently
		// killed after the first 1–2 files. See files.Zip for the
		// pre-flight authz/scan/vault contract.
		r.Post("/v1/files/zip", f.Zip)
		// Same-origin streaming proxy for sandboxed iframe previews.
		// Attaches Content-Security-Policy + X-Content-Type-Options +
		// Content-Disposition: inline so a forged HTML/SVG can't escape
		// the iframe sandbox. ?meta=1 returns metadata (CSP + sandbox
		// attribute value); default returns the bytes.
		r.Get("/v1/files/{id}/inline-preview", f.InlinePreview)
		r.Delete("/v1/files/{id}", f.Delete)
		r.Post("/v1/files/{id}/restore", f.Restore)
		// Hard delete of a single trashed file (blob + row). Distinct
		// from the soft-delete above — the trash → purge flow is
		// deliberately two-step so users can restore by mistake.
		r.Delete("/v1/files/{id}/purge", f.Purge)
		// Empty the current user's trash (or the whole org's, for admins).
		r.Post("/v1/trash/empty", f.EmptyTrash)
		// Per-user starred state. Star/Unstar are idempotent so the
		// client can call them without knowing the current state.
		// The `view=starred` query on List returns the user's starred
		// files in reverse-star-time order.
		r.Post("/v1/files/{id}/star", f.Star)
		r.Delete("/v1/files/{id}/star", f.Unstar)

		// Folders
		r.Post("/v1/folders", fh.Create)
		r.Post("/v1/folders/ensure-path", fh.EnsurePath)
		r.Get("/v1/folders", fh.List)
		r.Get("/v1/folders/{id}/breadcrumbs", fh.Breadcrumbs)
		r.Patch("/v1/folders/{id}", fh.Patch)
		r.Delete("/v1/folders/{id}", fh.Delete)

		// Vault: per-folder lock toggle + global re-auth session.
		// /vault/unlock issues a 5-minute unlock; locked folders return
		// 423 until the caller has an active vault_sessions row.
		r.Post("/v1/folders/{id}/lock", vt.LockFolder)
		r.Delete("/v1/folders/{id}/lock", vt.UnlockFolder)
		r.Get("/v1/vault/status", vt.Status)
		r.Post("/v1/vault/unlock", vt.Unlock)
		r.Post("/v1/vault/lock", vt.Lock)
		// Privacy telemetry: client beacons (PrintScreen, tab hidden,
		// focus lost, etc.) while a vault-locked surface is mounted.
		// Server logs as audit events; cannot prevent OS-level capture.
		r.Post("/v1/vault/privacy-event", vt.PrivacyEvent)

		// Shares (public token links).
		r.Post("/v1/files/{id}/share", sh.Create)
		r.Get("/v1/files/{id}/shares", sh.List)
		r.Delete("/v1/shares/{shareId}", sh.Revoke)

		// Per-user / per-group ACL — grant a teammate or group access
		// to a specific file or folder. See internal/sharing/acl.go.
		r.Post("/v1/files/{id}/access", sh.GrantFile)
		r.Get("/v1/files/{id}/access", sh.ListFileShares)
		r.Delete("/v1/files/{id}/access/{shareId}", sh.RevokeFile)
		r.Post("/v1/folders/{id}/access", sh.GrantFolder)
		r.Get("/v1/folders/{id}/access", sh.ListFolderShares)
		r.Delete("/v1/folders/{id}/access/{shareId}", sh.RevokeFolder)
		r.Get("/v1/shared-with-me", sh.SharedWithMe)

		// Access-request inbox — pull-mode alternative to the
		// owner-push grant above. Viewers who need more than read
		// rights file a request here; owners see pending rows and
		// approve/deny from /settings/access-requests.
		r.Post("/v1/files/{id}/request-access", sh.RequestFileAccess)
		r.Get("/v1/access-requests", sh.ListAccessRequests)
		r.Post("/v1/access-requests/{id}/approve", sh.ApproveAccessRequest)
		r.Post("/v1/access-requests/{id}/deny", sh.DenyAccessRequest)
		r.Post("/v1/access-requests/{id}/cancel", sh.CancelAccessRequest)

		// Groups — named collections of users used as share principals.
		r.Get("/v1/groups", sh.GroupsList)
		r.Post("/v1/groups", sh.GroupsCreate)
		r.Get("/v1/groups/{id}", sh.GroupsGet)
		r.Patch("/v1/groups/{id}", sh.GroupsUpdate)
		r.Delete("/v1/groups/{id}", sh.GroupsDelete)
		r.Get("/v1/groups/{id}/members", sh.GroupMembersList)
		r.Post("/v1/groups/{id}/members", sh.GroupMembersAdd)
		r.Delete("/v1/groups/{id}/members/{userId}", sh.GroupMembersRemove)

		r.Get("/v1/templates/{id}", t.Get)
		r.Get("/v1/templates/{id}/schema", t.Schema)
		r.Patch("/v1/templates/{id}", t.Rename)
		r.Put("/v1/templates/{id}/config", t.UpdateConfig)
		r.Get("/v1/templates/{id}/preview-url", t.PreviewURL)
		r.Post("/v1/templates/{id}/generate", t.Generate)
		r.Post("/v1/templates/{id}/batch", t.Batch)
		r.Post("/v1/templates/{id}/batch-sheet", t.BatchSheet)
		r.Get("/v1/templates/{id}/widgets", t.ListWidgets)
		r.Put("/v1/templates/{id}/widgets", t.ReplaceWidgets)
		r.Put("/v1/templates/{id}/acroform/structure", t.UpdateAcroformStructure)

		// Image designer — runs the transform pipeline (crop / rotate /
		// flip / resize / quality / upscale / filters) against the image
		// attached to a mode=image template. Same endpoint serves both
		// the live preview (returns bytes inline) and the save path
		// (writes a sibling file or overwrites in place).
		r.Post("/v1/templates/{id}/images/transform", img.Transform)

		r.Get("/v1/templates/{id}/mock-data", md.List)
		r.Post("/v1/templates/{id}/mock-data", md.Save)
		r.Delete("/v1/templates/{id}/mock-data/{setId}", md.Delete)

		r.Get("/v1/jobs/{id}", jh.Get)

		// Versions
		r.Get("/v1/templates/{id}/versions", t.ListVersions)
		r.Post("/v1/templates/{id}/versions/{ver}/restore", t.RestoreVersion)

		// HTML source edits
		r.Get("/v1/templates/{id}/source", t.Source)
		r.Put("/v1/templates/{id}/source", t.UpdateSource)
		r.Post("/v1/templates/{id}/preview", t.Preview)
		r.Post("/v1/templates/blank-pdf", t.CreateBlankPDF)
		r.Post("/v1/templates/form-builder", t.CreateFormTemplate)
		r.Post("/v1/templates/doc", t.CreateDocTemplate)

		// API keys — programmatic access to the REST API.
		r.Get("/v1/api-keys", ak.List)
		r.Post("/v1/api-keys", ak.Create)
		r.Delete("/v1/api-keys/{id}", ak.Revoke)
		r.Get("/v1/api-keys/{id}/activity", ak.Activity)

		// Webhooks.
		r.Get("/v1/webhooks", wh.List)
		r.Post("/v1/webhooks", wh.Create)
		r.Patch("/v1/webhooks/{id}", wh.Update)
		r.Delete("/v1/webhooks/{id}", wh.Delete)
		r.Get("/v1/webhooks/{id}/deliveries", wh.Deliveries)
		r.Post("/v1/webhooks/{id}/deliveries/{deliveryId}/retry", wh.Redeliver)
		r.Post("/v1/webhooks/{id}/test", wh.Test)

		// Public form links (per-template fill URLs).
		r.Get("/v1/templates/{id}/form-links", fl.List)
		r.Post("/v1/templates/{id}/form-links", fl.Create)
		r.Patch("/v1/form-links/{id}", fl.Update)
		r.Delete("/v1/form-links/{id}", fl.Delete)

		// Email delivery (settings + send-and-attach).
		r.Get("/v1/email/settings", mh.GetSettings)
		r.Put("/v1/email/settings", mh.SaveSettings)
		r.Post("/v1/email/test", mh.TestSend)
		r.Get("/v1/email/sends", mh.ListSends)
		// Super-admin cross-org audit. Server-side gate on admin role
		// inside the handler — separate path so the org-scoped list
		// stays a clean default for normal users.
		r.Get("/v1/admin/email/sends", mh.ListSendsAdmin)

		// Super-admin user management. requireSuperAdmin checks the
		// users.is_super_admin column (via Claims.IsSuper) — letting
		// org admins keep their per-workspace controls untouched while
		// reserving these platform-wide endpoints for the operator.
		r.Route("/v1/admin/users", func(r chi.Router) {
			r.Use(requireSuperAdmin)
			r.Get("/", pu.List)
			r.Get("/{id}", pu.Detail)
			r.Post("/{id}/lock", pu.Lock)
			r.Post("/{id}/unlock", pu.Unlock)
			r.Post("/{id}/reset-mfa", pu.ResetMFA)
			r.Post("/{id}/force-password-reset", pu.ForcePasswordReset)
			r.Delete("/{id}/sessions", pu.RevokeSessions)
			r.Post("/{id}/memberships", pu.AddMembership)
			r.Delete("/{id}/memberships/{orgId}", pu.RemoveMembership)
		})

		// Phase 3: super-admin org management.
		r.Route("/v1/admin/orgs", func(r chi.Router) {
			r.Use(requireSuperAdmin)
			r.Get("/", po.List)
			r.Get("/{id}", po.Detail)
			r.Post("/{id}/freeze", po.Freeze)
			r.Post("/{id}/unfreeze", po.Unfreeze)
			r.Delete("/{id}", po.SoftDelete)
			r.Post("/{id}/restore", po.Restore)
			r.Patch("/{id}/quotas", po.SetQuotas)
		})

		// Phase 3: platform-wide audit log viewer.
		r.With(requireSuperAdmin).Get("/v1/admin/audit", pa.List)

		// Tier 3: Prometheus-powered super-admin observability.
		// Both routes 503 cleanly when PROMETHEUS_URL is unset, so a
		// fresh dev checkout still loads /settings/admin/observability
		// — the page just hides its live panels.
		obsq := promquery.NewHandler(promquery.New(
			os.Getenv("PROMETHEUS_URL"),
			os.Getenv("PROMETHEUS_USER"),
			os.Getenv("PROMETHEUS_PASSWORD"),
		))
		r.With(requireSuperAdmin).Get("/v1/admin/observability/snapshot", obsq.SnapshotHandler)
		r.With(requireSuperAdmin).Get("/v1/admin/observability/series", obsq.SeriesHandler)
		r.With(requireSuperAdmin).Get("/v1/admin/observability/targets", obsq.TargetsHandler)
		r.With(requireSuperAdmin).Get("/v1/admin/observability/alerts", obsq.AlertsHandler)
		r.With(requireSuperAdmin).Get("/v1/admin/observability/infra", obsq.InfraHandler)

		// Super-admin dashboard: one-shot aggregator with org/user/sub
		// counts, 30-day revenue, recent signups, paid + open invoices,
		// and recent audit events. The console page hits this on load.
		r.With(requireSuperAdmin).Get("/v1/admin/dashboard", pd.Get)

		// Org-scoped admin dashboard. Handler self-checks role=admin and
		// scopes every query to the caller's org. Powers the /dashboard
		// landing page that admins see right after login.
		r.Get("/v1/dashboard/admin", od.Get)

		// Phase 3: per-user memberships (multi-org).
		r.Get("/v1/me/memberships", mb.List)
		r.Post("/v1/me/switch-org", mb.Switch)

		// Phase 4a: subscription module. Read-only for all callers; the
		// super-admin assignment endpoint mounts under /v1/admin/orgs.
		r.Get("/v1/billing/plans", bl.ListPlans)
		r.Get("/v1/billing/subscription", bl.Subscription)
		r.Get("/v1/billing/invoices", bl.ListInvoices)
		r.Get("/v1/billing/profile", bl.GetProfile)
		r.Put("/v1/billing/profile", bl.PutProfile)
		// Phase 4b: live checkout + cancel. Webhooks mount publicly
		// outside this auth-protected group below.
		r.Post("/v1/billing/checkout", bl.Checkout)
		r.Post("/v1/billing/cancel", bl.CancelSubscription)
		// Phase 4c: reactivate, plan switching, customer portal, coupons.
		r.Post("/v1/billing/reactivate", bl.Reactivate)
		r.Post("/v1/billing/change-plan", bl.ChangePlan)
		r.Post("/v1/billing/portal", bl.CustomerPortalSession)
		r.Get("/v1/billing/coupons/preview", bl.PreviewCoupon)
		r.With(requireSuperAdmin).Get("/v1/admin/orgs/{id}/subscription", bl.AdminGet)
		r.With(requireSuperAdmin).Post("/v1/admin/orgs/{id}/subscription", bl.AdminAssign)
		// Plan catalog CRUD — only super-admin manages what plans exist.
		// Org admins still GET /v1/billing/plans to see the storefront.
		r.With(requireSuperAdmin).Get("/v1/admin/plans", bl.AdminListPlans)
		r.With(requireSuperAdmin).Get("/v1/admin/plans/{id}", bl.AdminGetPlan)
		r.With(requireSuperAdmin).Post("/v1/admin/plans", bl.AdminUpsertPlan)
		r.With(requireSuperAdmin).Put("/v1/admin/plans/{id}", bl.AdminUpsertPlan)
		r.With(requireSuperAdmin).Delete("/v1/admin/plans/{id}", bl.AdminDeletePlan)

		// Product-wide upload policy (super-admin only). Org admins read
		// the merged "effective" view via /v1/settings/upload-policy below.
		r.With(requireSuperAdmin).Get("/v1/admin/product-config", upH.GetProduct)
		r.With(requireSuperAdmin).Patch("/v1/admin/product-config", upH.PatchProduct)

		// Per-org upload policy overrides. Handler self-checks role=admin.
		r.Get("/v1/settings/upload-policy", upH.GetOrg)
		r.Patch("/v1/settings/upload-policy", upH.PatchOrg)
		r.Delete("/v1/settings/upload-policy", upH.DeleteOrg)

		r.Post("/v1/templates/{id}/send", mh.SendTemplate)

		// Scheduled generation jobs.
		r.Get("/v1/schedules", sc.List)
		r.Post("/v1/schedules", sc.Create)
		r.Patch("/v1/schedules/{id}", sc.Update)
		r.Delete("/v1/schedules/{id}", sc.Delete)
		r.Get("/v1/schedules/{id}/runs", sc.Runs)

		// Team members + invitations. Admin-only writes are enforced inside
		// the handlers; listing is open to any authenticated member.
		r.Get("/v1/team/members", tm.ListMembers)
		r.Patch("/v1/team/members/{id}", tm.UpdateMember)
		r.Delete("/v1/team/members/{id}", tm.RemoveMember)
		r.Post("/v1/team/members/{id}/reset-mfa", tm.ResetMFA)
		r.Get("/v1/team/invites", tm.ListInvites)
		r.Post("/v1/team/invites", tm.CreateInvite)
		// Resend rotates the token + extends expiry, then re-emails.
		// Old URLs forwarded around stop working the moment a resend
		// fires, so this is the safe equivalent of "send the email
		// again" for an invite the recipient claims they didn't get.
		r.Post("/v1/team/invites/{id}/resend", tm.ResendInvite)
		r.Delete("/v1/team/invites/{id}", tm.RevokeInvite)

		// Comments + @mentions inbox.
		r.Get("/v1/templates/{id}/comments", cm.List)
		r.Post("/v1/templates/{id}/comments", cm.Create)
		r.Patch("/v1/comments/{id}/resolve", cm.Resolve)
		r.Delete("/v1/comments/{id}", cm.Delete)
		r.Get("/v1/mentions", cm.Mentions)
		r.Post("/v1/mentions/mark-read", cm.MarkAllRead)

		// Reviews.
		r.Get("/v1/templates/{id}/reviews", rv.ListForTemplate)
		r.Post("/v1/templates/{id}/reviews", rv.Request)
		r.Post("/v1/reviews/{id}/decision", rv.Decide)
		r.Post("/v1/reviews/{id}/cancel", rv.Cancel)
		r.Get("/v1/reviews/inbox", rv.Inbox)

		// Presence (heartbeat + leave).
		r.Get("/v1/templates/{id}/presence", pr.Heartbeat)
		r.Delete("/v1/templates/{id}/presence", pr.Leave)

		// External reviewer links (admin side).
		r.Get("/v1/templates/{id}/review-links", rl.List)
		r.Post("/v1/templates/{id}/review-links", rl.Create)
		r.Delete("/v1/review-links/{id}", rl.Revoke)
	})

	// Listen address. Default ":8080" preserves the historical behaviour
	// for any caller that doesn't set the env. The blue-green deploy
	// pipeline runs two instances of this binary side-by-side on
	// different ports (8080 + 8081) and flips an nginx upstream
	// between them — see scripts/deploy/install-api.sh. Without the
	// env override, both instances would race for the same port and
	// the second to start would crash the first deploy.
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	logger.Info("api listening", "addr", addr)
	if err := http.ListenAndServe(addr, r); err != nil {
		logger.Error("serve", "err", err)
	}
}

// runMigrations applies every SQL file in migrations/ that hasn't already
// been recorded as applied. Each file runs in its own transaction so a
// failure rolls back cleanly; on success the filename is recorded in
// schema_migrations so we don't re-run it on the next boot.
func runMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	if _, err := pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
		  filename TEXT PRIMARY KEY,
		  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`); err != nil {
		return err
	}

	applied := map[string]bool{}
	rows, err := pool.Query(ctx, `SELECT filename FROM schema_migrations`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var f string
		if err := rows.Scan(&f); err == nil {
			applied[f] = true
		}
	}
	rows.Close()

	matches, err := filepath.Glob("migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(matches)
	for _, path := range matches {
		name := filepath.Base(path)
		if applied[name] {
			continue
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		tx, err := pool.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(b)); err != nil {
			_ = tx.Rollback(ctx)
			return err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO schema_migrations (filename) VALUES ($1)
			 ON CONFLICT (filename) DO NOTHING`, name); err != nil {
			_ = tx.Rollback(ctx)
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
	}
	return nil
}


// mailerAdapter exposes mail.Mailer as the slim sharing.Notifier
// interface. We translate the two SendOptions struct shapes here so
// neither package has to depend on the other directly.
type mailerAdapter struct{ m *mail.Mailer }

func (a mailerAdapter) Send(ctx context.Context, opts sharing.NotifyOptions) (string, error) {
	return a.m.Send(ctx, mail.SendOptions{
		OrgID:  opts.OrgID,
		UserID: opts.UserID,
		Kind:   opts.Kind,
		Source: opts.Source,
		Message: email.Message{
			To:       opts.To,
			Subject:  opts.Subject,
			HTMLBody: opts.HTMLBody,
			TextBody: opts.TextBody,
		},
		Metadata: opts.Metadata,
	})
}

// teamMailerAdapter does the same translation for team invites.
type teamMailerAdapter struct{ m *mail.Mailer }

func (a teamMailerAdapter) Send(ctx context.Context, opts team.NotifyOptions) (string, error) {
	return a.m.Send(ctx, mail.SendOptions{
		OrgID:  opts.OrgID,
		UserID: opts.UserID,
		Kind:   opts.Kind,
		Source: opts.Source,
		Message: email.Message{
			To:       opts.To,
			Subject:  opts.Subject,
			HTMLBody: opts.HTMLBody,
			TextBody: opts.TextBody,
		},
		Metadata: opts.Metadata,
	})
}

// metricsAIObserver bridges ai.Observer onto the prometheus
// AIRequests / AIDuration / AITokens vectors. Kept here (not in
// internal/ai or internal/metrics) so neither package has to know
// about the other — main is the wiring level by design.
type metricsAIObserver struct {
	reg *metrics.Registry
}

func (o metricsAIObserver) Observe(op, provider string, dur time.Duration, tokensIn, tokensOut int, err error) {
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
	// Treat 0 as "unknown" rather than "definitely zero" — we'd
	// rather skip the sample than poison the rate() with phantom
	// zero-token calls. When ChatResponse grows usage data we'll
	// land non-zero counts here and these branches start firing.
	if tokensIn > 0 {
		o.reg.AITokens.WithLabelValues(provider, op, "prompt").Add(float64(tokensIn))
	}
	if tokensOut > 0 {
		o.reg.AITokens.WithLabelValues(provider, op, "completion").Add(float64(tokensOut))
	}
}

// apiKeyAuthResult buckets an APIKeyVerifierV2 error into the small
// label set the metrics dashboard understands. Kept here (not in
// internal/apikeys) so the apikeys package stays free of an
// observability dependency — and the label vocabulary is what the
// metrics dashboards / alerts know about, not what the apikeys
// package happens to expose.
func apiKeyAuthResult(err error) string {
	switch {
	case err == nil:
		return "ok"
	case errors.Is(err, apikeys.ErrInvalidKey):
		return "invalid"
	case errors.Is(err, apikeys.ErrRevokedKey):
		return "revoked"
	case errors.Is(err, apikeys.ErrExpiredKey):
		return "expired"
	default:
		return "error"
	}
}

// requireSuperAdmin gates the /v1/admin/users/* routes.
//
// Authoritative source: users.is_super_admin (migration 049), surfaced
// onto the JWT via Claims.IsSuper. Org-level admins (admin of their
// own workspace) get 403 here; only the platform operator passes.
//
// The middleware writes nothing — handlers do their own audit logging
// once they know the action succeeded.
func requireSuperAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
		if c == nil || !c.IsAdmin() {
			http.Error(w, `{"error":{"code":"forbidden","message":"admin role required"}}`, http.StatusForbidden)
			return
		}
		if !c.IsSuperAdmin() {
			http.Error(w, `{"error":{"code":"forbidden","message":"super-admin only"}}`, http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
