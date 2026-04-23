package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/docforge/api/internal/db"
	"github.com/docforge/api/internal/generate"
	"github.com/docforge/api/internal/queue"
	"github.com/docforge/api/internal/storage"
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
	h := &worker.Handlers{DB: pool, Storage: store, Runner: runner, Log: logger}

	srv := asynq.NewServer(queue.ClientOpt(), asynq.Config{
		Concurrency: 4,
		Queues:      map[string]int{"default": 1},
	})
	mux := asynq.NewServeMux()
	h.Register(mux)

	logger.Info("worker listening", "redis", queue.RedisAddr())
	if err := srv.Run(mux); err != nil {
		logger.Error("worker stopped", "err", err)
		os.Exit(1)
	}
}
