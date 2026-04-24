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
	"github.com/docforge/api/internal/comments"
	"github.com/docforge/api/internal/compliance"
	"github.com/docforge/api/internal/db"
	"github.com/docforge/api/internal/files"
	"github.com/docforge/api/internal/folders"
	"github.com/docforge/api/internal/formlinks"
	"github.com/docforge/api/internal/jobs"
	"github.com/docforge/api/internal/mail"
	"github.com/docforge/api/internal/mfa"
	"github.com/docforge/api/internal/mockdata"
	"github.com/docforge/api/internal/observability"
	"github.com/docforge/api/internal/platform"
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
	md := mockdata.New(pool)
	jh := jobs.New(pool)
	fh := folders.New(pool)
	sh := sharing.New(pool, store)
	ak := apikeys.New(pool)
	wh := webhooks.New(pool, qc)
	wh.WireEventBus()
	fl := formlinks.New(pool, store, t.Runner)
	mh := mail.New(pool, store, t.Runner)
	sc := scheduled.New(pool, qc)
	tm := team.New(pool, a)
	cm := comments.New(pool)
	rv := reviews.New(pool)
	pr := presence.New(pool)
	rl := reviewlinks.New(pool)

	// Security & compliance handlers.
	ad := audit.New(pool)
	mf := mfa.New(pool, a)
	ss := sessions.New(pool)
	cp := compliance.New(pool)

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

	r.Group(func(r chi.Router) {
		r.Use(a.Middleware)
		// Platform: scope enforcement + rate-limit headers + per-key request
		// log. All three are cheap and safely chain after the auth middleware
		// (which attaches the API-key info to ctx). Scope guard only applies
		// to API-key-authenticated traffic; JWT callers are passed through.
		r.Use(platform.ScopeGuard())
		r.Use(platform.RateLimitHeaders(600, time.Minute))
		r.Use(platform.RequestLogger(pool))
		r.Get("/v1/me", a.Me)
		r.Post("/v1/auth/logout", a.Logout)

		// Security & compliance.
		ad.Mount(r)
		mf.Mount(r)
		ss.Mount(r)
		cp.Mount(r)

		// Observability (admin-only inside the handler).
		obs.Mount(r)

		r.Post("/v1/files/upload-url", f.CreateUploadURL)
		r.Post("/v1/files/{id}/complete", f.Complete)
		r.Get("/v1/files", f.List)
		r.Get("/v1/files/{id}", f.Get)
		r.Patch("/v1/files/{id}", f.Patch)
		r.Get("/v1/files/{id}/download", f.Download)
		r.Delete("/v1/files/{id}", f.Delete)
		r.Post("/v1/files/{id}/restore", f.Restore)

		// Folders
		r.Post("/v1/folders", fh.Create)
		r.Get("/v1/folders", fh.List)
		r.Get("/v1/folders/{id}/breadcrumbs", fh.Breadcrumbs)
		r.Patch("/v1/folders/{id}", fh.Patch)
		r.Delete("/v1/folders/{id}", fh.Delete)

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
		r.Patch("/v1/templates/{id}", t.Rename)
		r.Put("/v1/templates/{id}/config", t.UpdateConfig)
		r.Get("/v1/templates/{id}/preview-url", t.PreviewURL)
		r.Post("/v1/templates/{id}/generate", t.Generate)
		r.Post("/v1/templates/{id}/batch", t.Batch)
		r.Post("/v1/templates/{id}/batch-sheet", t.BatchSheet)
		r.Get("/v1/templates/{id}/widgets", t.ListWidgets)
		r.Put("/v1/templates/{id}/widgets", t.ReplaceWidgets)
		r.Put("/v1/templates/{id}/acroform/structure", t.UpdateAcroformStructure)

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
