package main

import (
	"context"
	"log/slog"
	"os"
	"time"

	"github.com/docforge/api/internal/db"
	"github.com/docforge/api/internal/generate"
	"github.com/docforge/api/internal/mergerecipes"
	"github.com/docforge/api/internal/pdfmerge"
	"github.com/docforge/api/internal/queue"
	"github.com/docforge/api/internal/scheduled"
	"github.com/docforge/api/internal/storage"
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

	store, err := storage.New()
	if err != nil {
		logger.Error("storage init", "err", err)
		os.Exit(1)
	}

	runner := &generate.Runner{DB: pool, Storage: store}
	// PDF merge handler shares its lifecycle with the HTTP layer; the
	// worker only needs the queue-processing methods on it. Queue here
	// is unused (workers don't enqueue) so we leave it nil.
	pm := pdfmerge.New(pool, store, nil)
	// Recipe runner — shares Runner + PDFMerge with the HTTP layer so a
	// recipe rendered async produces byte-identical output to one
	// rendered inline.
	mr := mergerecipes.New(pool, store, runner, pm, nil)
	h := &worker.Handlers{
		DB: pool, Storage: store, Runner: runner, Log: logger,
		PDFMerge: pm, MergeRecipes: mr,
	}

	srv := asynq.NewServer(queue.ClientOpt(), asynq.Config{
		Concurrency: 4,
		Queues:      map[string]int{"default": 1},
	})
	mux := asynq.NewServeMux()
	h.Register(mux)

	// Webhook delivery task (retries via asynq exponential backoff).
	whh := &webhooks.Handler{DB: pool}
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
		if n, err := sch.Tick(ctx); err == nil && n > 0 {
			logger.Info("schedules fired", "count", n)
		}
		for range tick.C {
			n, err := sch.Tick(ctx)
			if err != nil {
				logger.Error("schedule tick", "err", err)
				continue
			}
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
