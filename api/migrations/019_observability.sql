-- Operations & observability: rolled-up request metrics, error events, and
-- component health history. Everything here is workspace-scoped where
-- sensible and admin-only at the API layer.

-- request_metrics: one row per {method, path pattern, status bucket} per
-- 1-minute window, populated by the observability middleware on flush.
-- status_bucket is "2xx"/"3xx"/"4xx"/"5xx" to keep cardinality bounded.
CREATE TABLE IF NOT EXISTS request_metrics (
  id           BIGSERIAL PRIMARY KEY,
  bucket_ts    TIMESTAMPTZ NOT NULL,
  method       TEXT NOT NULL,
  path         TEXT NOT NULL,
  status       TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  sum_ms       BIGINT  NOT NULL DEFAULT 0,
  max_ms       INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bucket_ts, method, path, status)
);
CREATE INDEX IF NOT EXISTS request_metrics_bucket_idx
  ON request_metrics (bucket_ts DESC);

-- error_events: unhandled panics + surface-level 5xx responses + background
-- job failures. Retained 30 days for incident review; older rows pruned
-- opportunistically by the metrics flusher.
CREATE TABLE IF NOT EXISTS error_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID,
  component    TEXT NOT NULL,        -- api | worker | webhook | scheduled
  kind         TEXT NOT NULL,        -- panic | http_5xx | job_failed | health_fail
  message      TEXT NOT NULL,
  context      JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_id   TEXT,
  path         TEXT,
  status       INTEGER,
  actor_id     UUID,
  ip_addr      INET,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS error_events_created_idx
  ON error_events (created_at DESC);
CREATE INDEX IF NOT EXISTS error_events_org_idx
  ON error_events (org_id, created_at DESC);

-- health_checks: last-N component health probe results. A small rolling
-- history helps the UI show "up 99.9% this hour" style status.
CREATE TABLE IF NOT EXISTS health_checks (
  id           BIGSERIAL PRIMARY KEY,
  component    TEXT NOT NULL,        -- db | storage | redis
  status       TEXT NOT NULL,        -- ok | degraded | down
  latency_ms   INTEGER NOT NULL DEFAULT 0,
  detail       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS health_checks_component_idx
  ON health_checks (component, created_at DESC);
