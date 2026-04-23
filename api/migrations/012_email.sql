-- Per-org email settings. One row per org (UNIQUE on org_id). Secret fields
-- are stored as-is (same sensitivity class as API keys); a future pass can
-- encrypt-at-rest with a KMS.
CREATE TABLE IF NOT EXISTS email_settings (
  org_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,              -- console | smtp | resend
  from_name TEXT,
  from_email TEXT NOT NULL,
  reply_to TEXT,
  config JSONB NOT NULL DEFAULT '{}',  -- provider-specific fields (host/port/user/password, api_key…)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Audit log of every generate-and-email call.
CREATE TABLE IF NOT EXISTS email_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  template_id UUID REFERENCES templates(id) ON DELETE SET NULL,
  output_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  recipients TEXT[] NOT NULL DEFAULT '{}',
  cc TEXT[] NOT NULL DEFAULT '{}',
  bcc TEXT[] NOT NULL DEFAULT '{}',
  subject TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,                -- queued | sent | failed
  provider_id TEXT,                    -- message id returned by provider (if any)
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_sends_org_idx
  ON email_sends(org_id, created_at DESC);
