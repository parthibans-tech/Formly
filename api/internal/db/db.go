package db

import (
	"context"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
)

func Connect(ctx context.Context) (*pgxpool.Pool, error) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		url = "postgres://docforge:docforge@localhost:5432/docforge?sslmode=disable"
	}
	return pgxpool.New(ctx, url)
}
