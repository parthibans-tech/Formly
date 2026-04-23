-- API keys for programmatic access to the v1 REST API.
-- The full key is never stored — only a SHA-256 hash plus a short `prefix`
-- (first chars of the full key) for indexed lookup.

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL UNIQUE,
  hash BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys(org_id);
CREATE INDEX IF NOT EXISTS api_keys_active_idx ON api_keys(org_id)
  WHERE revoked_at IS NULL;
