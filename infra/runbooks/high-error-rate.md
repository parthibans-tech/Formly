# FormlyHighErrorRate

## TL;DR

5xx ratio above 5% sustained 10m on the API. Customers are
seeing failures across the board, not on one specific endpoint.

## Verify

Open the [Global Health dashboard](http://localhost:3001/d/formly-global-health)
and look at the "5xx error ratio" stat panel. If it's already
green, the alert is in its `for:` window cool-off.

```promql
sum(rate(formly_http_requests_total{process="api",code="5xx"}[5m]))
  /
sum(rate(formly_http_requests_total{process="api"}[5m]))
```

## Diagnose

1. **Recent deploy** — check the git log of `main` for commits
   in the last hour. The "5xx ratio by route" panel will show
   the regression localized to one or two handlers.
2. **Downstream outage** — Postgres or Redis up? See the
   `formly-postgres` / `formly-redis` alert groups; if either
   is firing, this is a symptom not the cause.
3. **Capacity** — `formly_http_requests_in_flight` near
   GOMAXPROCS means CPU saturation. The API will start timing
   out before it can respond.

## Mitigate

- **Recent deploy** — roll back. The runtime cost of a rollback
  is always lower than waiting for the diff to be understood.
- **Downstream outage** — there's nothing to do at the API layer
  until the downstream comes back. Communicate status, ack the
  alert with a note pointing at the downstream incident.
- **Capacity** — scale out. Add 50% headroom; reduce when the
  in-flight count is back to baseline.

## Escalate

If the error rate stays above 5% for >30m and the rollback didn't
help, escalate to the engineering manager — at that point we
need product signoff on enabling degraded-mode (read-only,
disable writes) while we investigate.
