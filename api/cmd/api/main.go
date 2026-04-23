package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/db"
	"github.com/docforge/api/internal/files"
	"github.com/docforge/api/internal/folders"
	"github.com/docforge/api/internal/jobs"
	"github.com/docforge/api/internal/mockdata"
	"github.com/docforge/api/internal/queue"
	"github.com/docforge/api/internal/sharing"
	"github.com/docforge/api/internal/storage"
	"github.com/docforge/api/internal/templates"
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

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(30 * time.Second))
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"http://localhost:3000"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		AllowCredentials: true,
	}))

	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := pool.Ping(r.Context()); err != nil {
			http.Error(w, "db down", 503)
			return
		}
		w.Write([]byte("ok"))
	})

	r.Route("/v1/auth", func(r chi.Router) {
		r.Post("/register", a.Register)
		r.Post("/login", a.Login)
	})

	// Public share resolution (no auth).
	r.Get("/v1/public/shares/{token}", sh.Resolve)

	r.Group(func(r chi.Router) {
		r.Use(a.Middleware)
		r.Get("/v1/me", a.Me)

		r.Post("/v1/files/upload-url", f.CreateUploadURL)
		r.Post("/v1/files/{id}/complete", f.Complete)
		r.Get("/v1/files", f.List)
		r.Get("/v1/files/{id}", f.Get)
		r.Patch("/v1/files/{id}", f.Patch)
		r.Get("/v1/files/{id}/download", f.Download)
		r.Delete("/v1/files/{id}", f.Delete)

		// Folders
		r.Post("/v1/folders", fh.Create)
		r.Get("/v1/folders", fh.List)
		r.Get("/v1/folders/{id}/breadcrumbs", fh.Breadcrumbs)
		r.Patch("/v1/folders/{id}", fh.Patch)
		r.Delete("/v1/folders/{id}", fh.Delete)

		// Shares
		r.Post("/v1/files/{id}/share", sh.Create)
		r.Get("/v1/files/{id}/shares", sh.List)
		r.Delete("/v1/shares/{shareId}", sh.Revoke)

		r.Get("/v1/templates/{id}", t.Get)
		r.Put("/v1/templates/{id}/config", t.UpdateConfig)
		r.Get("/v1/templates/{id}/preview-url", t.PreviewURL)
		r.Post("/v1/templates/{id}/generate", t.Generate)
		r.Post("/v1/templates/{id}/batch", t.Batch)
		r.Get("/v1/templates/{id}/widgets", t.ListWidgets)
		r.Put("/v1/templates/{id}/widgets", t.ReplaceWidgets)

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
	})

	addr := ":8080"
	logger.Info("api listening", "addr", addr)
	if err := http.ListenAndServe(addr, r); err != nil {
		logger.Error("serve", "err", err)
	}
}

func runMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	matches, err := filepath.Glob("migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(matches)
	for _, path := range matches {
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if _, err := pool.Exec(ctx, string(b)); err != nil {
			return err
		}
	}
	return nil
}
