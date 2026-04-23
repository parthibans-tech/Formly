-- Platform & dev-experience: API key scopes + per-key request log.

-- Scopes grant a key access only to specific surfaces of the API.
-- Stored as an array of strings of the form "resource:action", e.g.
-- "files:read", "templates:write", "*:read". Empty = legacy "full access"
-- for backward compatibility with keys created before this migration.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT '{}';

-- Per-request log for API-key-authenticated traffic. Not populated for
-- JWT / browser sessions — only for calls made with fk_* keys — so the
-- UI "Activity" tab on an API key can show exactly what it did.
CREATE TABLE IF NOT EXISTS api_request_log (
  id           BIGSERIAL PRIMARY KEY,
  api_key_id   UUID REFERENCES api_keys(id) ON DELETE CASCADE,
  org_id       UUID NOT NULL,
  method       TEXT NOT NULL,
  path         TEXT NOT NULL,
  status       INTEGER NOT NULL,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  ip_addr      INET,
  user_agent   TEXT,
  request_id   TEXT,
  bytes_in     INTEGER,
  bytes_out    INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_request_log_key_idx
  ON api_request_log (api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS api_request_log_org_idx
  ON api_request_log (org_id, created_at DESC);
