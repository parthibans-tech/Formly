# Formly Prometheus rules

This directory holds the Prometheus configuration that turns the
metrics emitted by `internal/metrics` into dashboards + alerts.

## Files

| File | Purpose |
|------|---------|
| `prometheus.yml.example` | Scrape config template — copy to `prometheus.yml` and edit the targets / basic-auth block |
| `recording.rules.yml` | Pre-computed rates, error ratios, latency quantiles, availability |
| `alerts.rules.yml` | Page + ticket alerts on availability, error rate, latency, runtime saturation |

## What gets exposed

Both `cmd/api` and `cmd/worker` register a Prometheus registry via
`internal/metrics.New(...)` and serve it on `/metrics`:

- The **API** mounts `/metrics` on its main chi router.
- The **worker** brings up a dedicated listener (default `:9090`,
  override with `WORKER_METRICS_ADDR`) since asynq has no HTTP
  surface of its own.

The exposition handler enforces one of two access policies:

1. **Basic auth** — when both `METRICS_BASIC_AUTH_USER` and
   `METRICS_BASIC_AUTH_PASSWORD` are set on the process. Required for
   any non-loopback scraper. This is the production-recommended path.
2. **Loopback-only** — when those env vars are unset. Requests from
   `127.0.0.0/8`, `::1`, or unix sockets are allowed; everything else
   gets a `403`. This keeps a fresh dev checkout working with
   `curl localhost:8080/metrics` while preventing accidental public
   exposure when the operator forgets to set credentials.

## Series shape

| Metric | Type | Labels |
|--------|------|--------|
| `formly_http_requests_total` | counter | `method`, `route`, `code` (2xx/3xx/4xx/5xx) |
| `formly_http_request_duration_seconds` | histogram | `method`, `route` |
| `formly_http_requests_in_flight` | gauge | — |
| `formly_http_response_size_bytes` | histogram | `method`, `route` |
| `formly_build_info` | gauge | `process`, `version`, `commit`, `go_version` |
| `formly_db_pool_connections` | gauge | `state` (acquired/idle/total/max) |
| `formly_queue_tasks_total` | counter | `queue`, `task`, `result` (success/failed) |
| `formly_queue_task_duration_seconds` | histogram | `queue`, `task` |
| `formly_queue_tasks_in_flight` | gauge | `queue` |
| `formly_webhook_deliveries_total` | counter | `result` (2xx/3xx/4xx/5xx/error) |
| `formly_webhook_delivery_duration_seconds` | histogram | `result` |
| `formly_mail_sent_total` | counter | `kind`, `provider`, `result` (sent/failed) |
| `formly_ai_requests_total` | counter | `provider`, `op` (chat/embed), `result` (ok/error) |
| `formly_ai_request_duration_seconds` | histogram | `provider`, `op` |
| `formly_ai_tokens_total` | counter | `provider`, `op`, `kind` (prompt/completion) |
| `formly_tenant_requests_total` | counter | `tier` (free/starter/pro/enterprise/anon/unknown), `kind` (read/write), `code` (2xx/3xx/4xx/5xx) |
| `formly_auth_attempts_total` | counter | `kind` (login/register/mfa_verify), `result` (success/failed) |
| `formly_auth_apikey_attempts_total` | counter | `result` (ok/invalid/revoked/expired/error) |
| `formly_security_rate_limit_hits_total` | counter | `bucket` (auth/...) |
| `formly_cron_last_run_timestamp_seconds` | gauge | `name` (schedules/billing-dunning/...) |
| Standard `go_*` runtime metrics | various | — |
| Standard `formly_process_*` collectors | various | — |

The HTTP latency histogram (`formly_http_request_duration_seconds`)
also emits **OpenMetrics exemplars** linking each observation back
to its request: a `request_id` (chi middleware) and, when present,
a `trace_id` extracted from the W3C `traceparent` header. Configure
your Prometheus scrape with `Accept: application/openmetrics-text`
to ingest them, then jump from a histogram bucket to the exact
trace in your tracing backend.

Cardinality is bounded by:

- `route` is the chi route pattern (`/v1/files/{id}`), not the raw URL,
  so a million distinct `id`s collapse to one series.
- `code` is the status class, not the raw status code — a single
  endpoint emitting 200/201/204/206 stays as one `2xx` series.
- `/healthz` and `/metrics` are excluded entirely so they don't drown
  the per-route leaderboards.

## Wiring up Prometheus

```bash
cp prometheus.yml.example prometheus.yml
# edit targets + basic_auth, then:
prometheus --config.file=prometheus.yml
```

If you're running everything via `infra/docker-compose.yml`, mount
this directory into the Prometheus container and point
`--config.file` at `/etc/prometheus/prometheus.yml`.

## Useful PromQL starters

```promql
# global error rate
sum(rate(formly_http_requests_total{code="5xx"}[5m]))
  /
sum(rate(formly_http_requests_total[5m]))

# top 10 slowest routes by p95
topk(10,
  histogram_quantile(0.95,
    sum by (route, le) (
      rate(formly_http_request_duration_seconds_bucket[5m])
    )
  )
)

# requests-per-second per process (use to spot worker saturation)
sum by (process) (rate(formly_http_requests_total[1m]))

# pin every chart to a specific release on the legend
sum(rate(formly_http_requests_total[5m]))
  * on() group_left(version) formly_build_info

# 28d error budget remaining per tier (Tier 4)
tier:formly_error_budget_remaining:ratio28d

# Write-only error ratio per tier (Tier 4 — separates stuck mutations
# from transient read failures)
tier_kind:formly_tenant_error_ratio:rate5m{kind="write"}

# Cardinality watchdog: top metrics by active series count
topk(10, metric:formly_series_count:active)

# Cron heartbeat freshness: seconds since each scheduled job last ran
time() - max by (name) (formly_cron_last_run_timestamp_seconds)
```

## Recording-rule naming

`level:metric:operation` — read as "the {operation} of {metric}
aggregated to the {level} level". So
`route:formly_http_request_duration_seconds:p95` is the p95 of the
duration histogram aggregated to the route level. Dashboards should
prefer the recorded series over re-computing the quantile every
refresh.

## Adding new metrics

1. Declare the new vector inside `internal/metrics/metrics.go` (so
   the registry is the single declaration site).
2. Wire it into the package that observes it.
3. If the metric is meant to drive an alert or dashboard panel, add
   a recording rule here so the dashboard query stays cheap.
