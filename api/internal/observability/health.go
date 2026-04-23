package observability

import (
	"context"
	"time"

	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ComponentHealth describes the state of a single dependency probe.
type ComponentHealth struct {
	Component string `json:"component"`
	Status    string `json:"status"` // ok | degraded | down
	LatencyMs int    `json:"latencyMs"`
	Detail    string `json:"detail,omitempty"`
}

// StorageProber is the tiny slice of the storage API we need for health
// checks. Implemented by storage.Client.Bucket() + BucketExists at wire time
// (see Checker in handler.go — we accept a closure to avoid importing the
// storage package here and creating a cycle).
type StorageProber func(context.Context) error

// Checker runs the full health fan-out. Each probe has its own short timeout
// so a single slow component doesn't block the whole check.
type Checker struct {
	DB      *pgxpool.Pool
	Storage StorageProber
	Redis   asynq.RedisConnOpt
}

// Check runs all component probes in parallel-ish (sequential with short
// timeouts — probe count is tiny) and returns per-component results.
func (c *Checker) Check(ctx context.Context) []ComponentHealth {
	out := []ComponentHealth{
		c.probeDB(ctx),
	}
	if c.Storage != nil {
		out = append(out, c.probeStorage(ctx))
	}
	if c.Redis != nil {
		out = append(out, c.probeRedis(ctx))
	}
	return out
}

func (c *Checker) probeDB(ctx context.Context) ComponentHealth {
	cctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	t := time.Now()
	if err := c.DB.Ping(cctx); err != nil {
		return ComponentHealth{
			Component: "db", Status: "down",
			LatencyMs: int(time.Since(t).Milliseconds()),
			Detail:    err.Error(),
		}
	}
	lat := int(time.Since(t).Milliseconds())
	status := "ok"
	if lat > 500 {
		status = "degraded"
	}
	return ComponentHealth{Component: "db", Status: status, LatencyMs: lat}
}

func (c *Checker) probeStorage(ctx context.Context) ComponentHealth {
	cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	t := time.Now()
	if err := c.Storage(cctx); err != nil {
		return ComponentHealth{
			Component: "storage", Status: "down",
			LatencyMs: int(time.Since(t).Milliseconds()),
			Detail:    err.Error(),
		}
	}
	lat := int(time.Since(t).Milliseconds())
	status := "ok"
	if lat > 1000 {
		status = "degraded"
	}
	return ComponentHealth{Component: "storage", Status: status, LatencyMs: lat}
}

func (c *Checker) probeRedis(ctx context.Context) ComponentHealth {
	t := time.Now()
	insp := asynq.NewInspector(c.Redis)
	defer insp.Close()
	if _, err := insp.Queues(); err != nil {
		return ComponentHealth{
			Component: "redis", Status: "down",
			LatencyMs: int(time.Since(t).Milliseconds()),
			Detail:    err.Error(),
		}
	}
	lat := int(time.Since(t).Milliseconds())
	status := "ok"
	if lat > 500 {
		status = "degraded"
	}
	return ComponentHealth{Component: "redis", Status: status, LatencyMs: lat}
}

// StartHealthLoop persists one row of health_checks per component every
// `interval`, so the dashboard can render a rolling uptime line.
func StartHealthLoop(ctx context.Context, db *pgxpool.Pool, checker *Checker, interval time.Duration) {
	if interval <= 0 {
		interval = 60 * time.Second
	}
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		// Prime with an immediate check so the UI has data on first load.
		persist(ctx, db, checker)
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				persist(ctx, db, checker)
			}
		}
	}()
}

func persist(ctx context.Context, db *pgxpool.Pool, checker *Checker) {
	results := checker.Check(ctx)
	for _, r := range results {
		_, _ = db.Exec(ctx,
			`INSERT INTO health_checks (component, status, latency_ms, detail)
			 VALUES ($1,$2,$3,NULLIF($4,''))`,
			r.Component, r.Status, r.LatencyMs, r.Detail)
		if r.Status == "down" {
			RecordError(ctx, db, ErrorEvent{
				Component: r.Component,
				Kind:      "health_fail",
				Message:   r.Detail,
			})
		}
	}
}
