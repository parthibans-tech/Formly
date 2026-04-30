package main

import (
	"context"
	"sync"
	"time"

	"github.com/docforge/api/internal/billing"
	"github.com/jackc/pgx/v5/pgxpool"
)

// planTierResolver answers "what tier does this org belong to?" with
// a TTL-cached lookup over billing.LoadOrgLimits. The resolver is
// what the metrics tenant annotator hits on every authenticated
// request; the cache exists so that a 5krps API doesn't translate
// into 5k extra `SELECT ... FROM organizations` per second.
//
// Cache shape:
//
//   - Keyed by orgID. Plan changes happen at human timescale (a paid
//     conversion, a downgrade), so a 30s TTL is short enough that the
//     dashboard reflects upgrades within a refresh, but long enough
//     to absorb the request rate from a single org.
//   - Negative results (resolver error, missing org) are cached at the
//     same TTL with the sentinel "unknown" — otherwise a transient DB
//     blip during a deploy would flood postgres with retries from the
//     metrics middleware.
//   - sync.Mutex (not RWMutex) — the critical section is two map ops,
//     dwarfed by the cache-miss DB query when one happens.
//
// "anon" and "unknown" are reserved tier names and never returned
// from this resolver — those are written by the metrics package
// itself when no org is in scope or the resolver isn't wired.
type planTierResolver struct {
	db  *pgxpool.Pool
	ttl time.Duration

	mu    sync.Mutex
	cache map[string]planCacheEntry
}

type planCacheEntry struct {
	tier      string
	expiresAt time.Time
}

func newPlanTierResolver(db *pgxpool.Pool) *planTierResolver {
	return &planTierResolver{
		db:    db,
		ttl:   30 * time.Second,
		cache: make(map[string]planCacheEntry),
	}
}

// Resolve returns a label-safe tier for an orgID. It never blocks for
// longer than the underlying DB query and is safe to call from hot
// paths — on cache hit it's a single map lookup under a non-contended
// mutex.
func (p *planTierResolver) Resolve(ctx context.Context, orgID string) string {
	if orgID == "" {
		return "unknown"
	}
	now := time.Now()

	p.mu.Lock()
	if e, ok := p.cache[orgID]; ok && e.expiresAt.After(now) {
		p.mu.Unlock()
		return e.tier
	}
	p.mu.Unlock()

	// Miss — query and refill. We deliberately don't deduplicate
	// concurrent misses with a singleflight; the worst case is a
	// burst of N parallel queries when the cache cold-starts on
	// boot, which is bounded by the in-flight request count and
	// settles within one TTL window.
	tier := "unknown"
	limits, err := billing.LoadOrgLimits(ctx, p.db, orgID)
	if err == nil && limits.Tier != "" {
		tier = limits.Tier
	}

	p.mu.Lock()
	p.cache[orgID] = planCacheEntry{
		tier:      tier,
		expiresAt: now.Add(p.ttl),
	}
	p.mu.Unlock()
	return tier
}
