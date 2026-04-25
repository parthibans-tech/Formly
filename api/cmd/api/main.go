package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/docforge/api/internal/apikeys"
	"github.com/docforge/api/internal/audit"
	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/billing"
	"github.com/docforge/api/internal/comments"
	"github.com/docforge/api/internal/compliance"
	"github.com/docforge/api/internal/db"
	"github.com/docforge/api/internal/email"
	"github.com/docforge/api/internal/files"
	"github.com/docforge/api/internal/folders"
	"github.com/docforge/api/internal/images"
	"github.com/docforge/api/internal/formlinks"
	"github.com/docforge/api/internal/jobs"
	"github.com/docforge/api/internal/mail"
	"github.com/docforge/api/internal/mfa"
	"github.com/docforge/api/internal/mockdata"
	"github.com/docforge/api/internal/observability"
	"github.com/docforge/api/internal/memberships"
	"github.com/docforge/api/internal/onlyoffice"
	"github.com/docforge/api/internal/orggate"
	"github.com/docforge/api/internal/platform"
	"github.com/docforge/api/internal/vault"
	"github.com/docforge/api/internal/platformaudit"
	"github.com/docforge/api/internal/me"
	"github.com/docforge/api/internal/orgdashboard"
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
	"github.com/docforge/api/internal/storage"
	"github.com/docforge/api/internal/team"
	"github.com/docforge/api/internal/templates"
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

	store, err := storage.New()
	if err != nil {
		logger.Error("storage init", "err", err)
		os.Exit(1)
	}
	logger.Info("storage ready", "bucket", store.Bucket())

	qc := asynq.NewClient(queue.ClientOpt())
	defer qc.Close()

	a := auth.New(pool)
	t := templates.New(pool, store)
	t.Queue = qc
	f := files.New(pool, store)
	f.Detector = t.DetectAndCreate
	f.Queue = qc
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
	auth.RegisterAPIKeyVerifierV2(func(r *http.Request, raw string) (string, string, string, string, string, []string, error) {
		return apikeys.VerifyAndLoadV2(pool, r, raw)
	})

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)
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
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"http://localhost:3000"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		AllowCredentials: true,
	}))

	// Rate-limit auth endpoints (login, register, MFA verify) to slow down
	// credential-stuffing. 30 requests / minute / IP-path is plenty for a
	// human and painful for a bot.
	authRateLimit := security.RateLimit(pool, security.LimitOpts{
		Window:    time.Minute,
		Max:       30,
		BucketKey: security.LoginBucketKey,
	})

	// Deep health + metrics exposition. Public (unauthenticated) so probes
	// and scrapers can hit them, but return structured data.
	r.Get("/healthz", obs.DeepHealth)
	r.Get("/metrics", obs.Metrics)

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
		r.Post("/v1/auth/logout", a.Logout)
		r.Post("/v1/auth/set-password", a.SetPassword)

		// Security & compliance.
		ad.Mount(r)
		mf.Mount(r)
		ss.Mount(r)
		cp.Mount(r)

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

		// Super-admin user management. The middleware checks role=admin
		// and (when set) PLATFORM_ROOT_ORG_ID — letting org admins keep
		// their per-workspace controls untouched while reserving these
		// platform-wide endpoints for the operator org.
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

	addr := ":8080"
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

// requireSuperAdmin gates the /v1/admin/users/* routes.
//
// Two-step check:
//  1. Caller must already be authenticated as an admin (role=admin) —
//     same gate the per-org admin endpoints use.
//  2. If PLATFORM_ROOT_ORG_ID is set in the environment, the caller's
//     org must match it. This is what separates "I'm the admin of my
//     own little workspace" from "I run the platform." If the env var
//     is unset (typical in dev), step 2 is skipped so a single admin
//     can wear both hats — useful before you have a dedicated
//     operator org provisioned.
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
