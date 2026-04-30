package metrics

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// StartDBPoolCollector spawns a goroutine that periodically samples
// pgxpool.Stat() and updates the DBPool gauge vector. The pool's own
// stats are cheap to read (atomic counters under the hood) so a 10s
// cadence costs nothing and keeps the gauge fresh enough for an
// alert that fires within ~1 minute of saturation.
//
// The goroutine exits cleanly when ctx is canceled — wire it to the
// process root context so it dies with the binary.
//
// Why a sampler and not a custom prometheus.Collector? Either works;
// the sampler is simpler to reason about (one ticker, no Describe/
// Collect contract) and lets us keep all gauges declared in one
// place (`Registry.DBPool`) rather than scattered across collectors.
// Cost is negligible compared to a real scrape.
func (r *Registry) StartDBPoolCollector(ctx context.Context, pool *pgxpool.Pool) {
	if pool == nil || r == nil || r.DBPool == nil {
		return
	}
	go func() {
		// Initial sample at boot so the first scrape isn't all zeros.
		r.sampleDBPool(pool)
		t := time.NewTicker(10 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				r.sampleDBPool(pool)
			}
		}
	}()
}

func (r *Registry) sampleDBPool(pool *pgxpool.Pool) {
	s := pool.Stat()
	// pgxpool.Stat exposes a wider surface (constructing, max-lifetime
	// destroy counts, etc.) but the four gauges below are the ones an
	// operator actually alerts on. Adding the rest would balloon
	// cardinality without value. The ratio `acquired/max` is the
	// canonical "pool exhaustion" alert — recorded as a rule in
	// recording.rules.yml.
	r.DBPool.WithLabelValues("acquired").Set(float64(s.AcquiredConns()))
	r.DBPool.WithLabelValues("idle").Set(float64(s.IdleConns()))
	r.DBPool.WithLabelValues("total").Set(float64(s.TotalConns()))
	r.DBPool.WithLabelValues("max").Set(float64(s.MaxConns()))
}
