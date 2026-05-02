# FormlyDBPoolNearExhaustion

## TL;DR

pgxpool acquired/max ≥95% sustained 5m. New requests are about
to start blocking on `pool.Acquire()` — once that happens the
P99 latency cliff comes immediately after.

## Verify

```promql
process:formly_db_pool_utilization:ratio
```

Also check Postgres-side connection count — a leaking pool on
the API process side would show here too:

```sql
SELECT count(*), state
FROM pg_stat_activity
WHERE datname = 'drive360'
GROUP BY state;
```

## Diagnose

1. **Slow queries holding connections** — `pg_stat_activity`
   ordered by `query_start` will surface the long-runners. The
   `FormlyPostgresLongRunningQueries` alert may be firing too.
2. **Connection leak in app code** — look for a recent change
   that takes a connection in a request scope but doesn't return
   it (missing `defer rows.Close()`, missing `pool.Release()`).
3. **Traffic spike** — compare RPS to baseline. If RPS is 3×
   normal, the pool is undersized for the new load.

## Mitigate

- **Slow queries**: kill the worst offender with
  `pg_terminate_backend(<pid>)`. Document the kill in the
  incident timeline.
- **Connection leak**: roll back the suspect deploy. The leak
  will resurface on the next deploy if you don't fix the code.
- **Traffic spike**: increase the pool size on the next deploy
  (env var `DB_POOL_MAX`). Don't hot-tune in prod; restart the
  process with a new env value.

## Escalate

If the pool exhaustion is paired with `FormlyPostgresConnectionSaturation`
(>80% of `max_connections`), the upstream limit is the issue
and only Postgres-side mitigation will help. Page the DBA.
