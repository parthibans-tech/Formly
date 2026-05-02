# FormlyTenantSLOFastBurn

## TL;DR

A single tier (`free` / `pro` / `enterprise`) is burning its
30-day error budget at >14.4× the rate that keeps it inside
99.5% availability. **One specific customer cohort** is seeing
an outage right now.

## Verify

```promql
tier:formly_tenant_error_ratio:rate1h{tier="<tier>"}
tier:formly_tenant_error_ratio:rate5m{tier="<tier>"}
```

Both should be above `0.072` (= 14.4 × 0.005). If only the 5m
window is hot, the problem just started; the 1h gate hasn't
caught up yet — keep watching, the alert is about to fire or
self-clear.

## Diagnose

1. **One customer** — check the per-tier traffic on the SLO
   dashboard. If a single org's RPS dominates the tier, this is
   a customer-specific issue (their integration is misbehaving,
   their data triggered a code path).
2. **One feature** — overlay the route-level error panel.
   If errors concentrate on a handler, it's a regression scoped
   to that route, not the whole tier.
3. **Tier-shared dependency** — billing? feature gates? the tier
   resolver itself? A 5xx in the tier-resolution middleware
   would surface here uniformly.

## Mitigate

- **One customer**: rate-limit the offending org at the edge
  (`/v1/admin/orgs/<org>/throttle`) until they fix their side.
  Document in the audit log.
- **One feature**: if a recent deploy introduced it, roll back.
  Otherwise feature-flag the bad path off.
- **Tier dependency**: see the upstream alert (most often this
  is a symptom, not the cause).

## Escalate

A fast-burn alert on `enterprise` is a customer-comms event —
notify the account team within 30 minutes. Pro and free tiers
get communicated via status page only.
