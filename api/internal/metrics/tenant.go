package metrics

import (
	"context"
	"net/http"
)

// Why this file exists
// --------------------
// Tier 2 wants a `tier` label on every served request so per-plan SLOs
// (free vs paid vs enterprise) can light up. The tier is only knowable
// AFTER the auth middleware has resolved the JWT and a downstream
// resolver has looked up the org's billing plan — but our chi metrics
// middleware runs BEFORE auth (it has to, otherwise unauthenticated
// 401/404 traffic stops being observable).
//
// Go's request context only flows downstream: any context value the
// auth middleware sets is invisible to the outer metrics middleware
// once next.ServeHTTP returns. The classic workaround is the "slot"
// pattern below — the outer middleware allocates a tiny mutable
// struct, stashes a pointer to it on the context, then reads the
// struct after the inner chain runs. Inner middlewares (auth) write
// the tier into the slot via SetRequestTenant, never knowing or
// caring that the metrics package is the consumer.
//
// Cardinality is bounded by the resolver — `tier` should map to at
// most a handful of plan tiers ("free", "trial", "starter", "pro",
// "enterprise") plus "anon" for unauthenticated paths and "unknown"
// for the resolver-failed case. Anything else is a bug in the
// resolver and worth catching with a recording rule.

type tenantSlotKey struct{}

// tenantSlot is the mutable carrier the slot pattern hangs off the
// request context. The pointer never escapes the request lifetime
// (we don't store it anywhere), so no GC concern.
type tenantSlot struct {
	tier string
}

// SetRequestTenant records the tenant's billing tier for the current
// request. Called from the auth middleware (or anywhere downstream
// of the metrics middleware that knows the tier) — a no-op if the
// metrics middleware isn't on the request, so safe to call always.
//
// Conventional values: "anon" (no Claims), "free", "trial",
// "starter", "pro", "enterprise", "unknown" (resolver failed).
func SetRequestTenant(r *http.Request, tier string) {
	if r == nil {
		return
	}
	if slot, ok := r.Context().Value(tenantSlotKey{}).(*tenantSlot); ok && slot != nil {
		slot.tier = tier
	}
}

// withTenantSlot allocates a new tenantSlot on the request context.
// Internal — only the chi middleware calls this.
func withTenantSlot(ctx context.Context) (context.Context, *tenantSlot) {
	slot := &tenantSlot{tier: "anon"}
	return context.WithValue(ctx, tenantSlotKey{}, slot), slot
}
