// Package observability owns runtime metrics, error recording, deep health
// checks, and the /v1/ops/* dashboard endpoints. It is deliberately
// lightweight — no Prometheus client dependency, no time-series store — and
// relies on:
//
//   - An in-memory sliding aggregator for request metrics, flushed to the
//     request_metrics table once per minute.
//   - An error_events table for 5xx / panic / job-failure samples.
//   - Periodic health probes of the DB / storage / Redis components, written
//     to the health_checks table so the UI can show a rolling uptime view.
//
// The Go std lib (time, runtime) provides enough for process-level gauges.
package observability

import (
	"context"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Aggregator buckets request metrics in-memory until a periodic flush.
// One aggregator is shared by the middleware and the flusher goroutine.
type Aggregator struct {
	mu    sync.Mutex
	cells map[string]*cell // key = method|path|status
}

type cell struct {
	method, path, status string
	count                int
	sumMs                int64
	maxMs                int
}

// NewAggregator returns a zero-state aggregator.
func NewAggregator() *Aggregator {
	return &Aggregator{cells: map[string]*cell{}}
}

// observe records one request's outcome. Cheap: one map lookup + int adds
// under a single mutex.
func (a *Aggregator) observe(method, path, status string, durMs int) {
	key := method + "|" + path + "|" + status
	a.mu.Lock()
	defer a.mu.Unlock()
	c, ok := a.cells[key]
	if !ok {
		c = &cell{method: method, path: path, status: status}
		a.cells[key] = c
	}
	c.count++
	c.sumMs += int64(durMs)
	if durMs > c.maxMs {
		c.maxMs = durMs
	}
}

// drain returns and resets the accumulated cells. Called once per flush tick.
func (a *Aggregator) drain() []*cell {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]*cell, 0, len(a.cells))
	for _, c := range a.cells {
		out = append(out, c)
	}
	a.cells = map[string]*cell{}
	return out
}

// StartFlusher runs a goroutine that periodically writes aggregated metrics
// to the DB (once per minute, aligned to wall-clock minute boundaries).
// The same loop prunes expired error/metric rows opportunistically.
func StartFlusher(ctx context.Context, db *pgxpool.Pool, a *Aggregator) {
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-t.C:
				bucket := now.UTC().Truncate(time.Minute)
				cells := a.drain()
				for _, c := range cells {
					avg := c.maxMs
					if c.count > 0 {
						avg = int(c.sumMs / int64(c.count))
					}
					_ = avg // kept as max_ms; sum_ms stored so UI can compute avg
					_, _ = db.Exec(ctx, `
						INSERT INTO request_metrics
						  (bucket_ts, method, path, status, count, sum_ms, max_ms)
						VALUES ($1,$2,$3,$4,$5,$6,$7)
						ON CONFLICT (bucket_ts, method, path, status)
						DO UPDATE SET
						  count  = request_metrics.count  + EXCLUDED.count,
						  sum_ms = request_metrics.sum_ms + EXCLUDED.sum_ms,
						  max_ms = GREATEST(request_metrics.max_ms, EXCLUDED.max_ms)
					`, bucket, c.method, c.path, c.status, c.count, c.sumMs, c.maxMs)
				}
				// Retention: 7 days of request_metrics, 30 days of
				// error_events, 24 h of health_checks.
				_, _ = db.Exec(ctx,
					`DELETE FROM request_metrics WHERE bucket_ts < now() - interval '7 days'`)
				_, _ = db.Exec(ctx,
					`DELETE FROM error_events   WHERE created_at < now() - interval '30 days'`)
				_, _ = db.Exec(ctx,
					`DELETE FROM health_checks  WHERE created_at < now() - interval '24 hours'`)
			}
		}
	}()
}

// Middleware wraps the router and records request metrics on each response.
// Path is normalised to the matched chi route pattern (e.g. "/v1/files/{id}")
// so cardinality stays bounded — raw URL paths would explode the bucket set.
func (a *Aggregator) Middleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			sr := &statusRecorder{ResponseWriter: w, status: 200}
			next.ServeHTTP(sr, r)

			p := routePattern(r)
			if p == "" {
				return
			}
			// Skip high-volume noise endpoints from the per-path breakdown;
			// health checks and static pings would drown the top-paths view.
			if p == "/healthz" || p == "/metrics" {
				return
			}
			a.observe(r.Method, p, statusBucket(sr.status), int(time.Since(start).Milliseconds()))
		})
	}
}

func routePattern(r *http.Request) string {
	if ctx := chi.RouteContext(r.Context()); ctx != nil {
		if p := ctx.RoutePattern(); p != "" {
			return cleanPattern(p)
		}
	}
	return cleanPattern(r.URL.Path)
}

// cleanPattern collapses trailing slashes and chi "/*" wildcards so buckets
// match across mount points.
func cleanPattern(p string) string {
	p = strings.TrimSuffix(p, "/*")
	if len(p) > 1 {
		p = strings.TrimSuffix(p, "/")
	}
	return path.Clean(p)
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func statusBucket(code int) string {
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

// LatencyString turns a millisecond value into a compact display form.
// Exported so the handler can format summary rows.
func LatencyString(ms int) string {
	if ms < 1000 {
		return strconv.Itoa(ms) + " ms"
	}
	return strconv.FormatFloat(float64(ms)/1000, 'f', 2, 64) + " s"
}
