-- Webhooks: outgoing HTTP notifications when events occur.
-- Each subscription is scoped to an organization; secret is the HMAC key
-- used to sign outgoing request bodies (stored as-is because signing needs
-- the plaintext — callers treat it as a "secret" of equal sensitivity to
-- an API key).

CREATE TABLE IF NOT EXISTS webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhooks_org_idx ON webhooks(org_id);
CREATE INDEX IF NOT EXISTS webhooks_active_idx ON webhooks(org_id) WHERE active = true;

-- Delivery attempts (one row per attempt). We keep a bounded history by
-- periodically pruning old rows in the worker.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  status TEXT NOT NULL,                    -- pending | success | failed
  attempt INT NOT NULL DEFAULT 1,
  request_body JSONB NOT NULL,
  response_code INT,
  response_body TEXT,
  error TEXT,
  duration_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook_idx
  ON webhook_deliveries(webhook_id, created_at DESC);
