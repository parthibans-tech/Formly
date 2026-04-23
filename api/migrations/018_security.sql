-- Security & compliance

-- Immutable activity log. Every sensitive action (auth, files, shares,
-- generation, team changes) should insert a row here.
CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_email TEXT,
    action TEXT NOT NULL,               -- e.g. "file.share.create"
    resource_type TEXT,                 -- "file" | "template" | "share" | "user" | ...
    resource_id TEXT,                   -- stringified ID (not FK; resource may be gone)
    ip_addr INET,
    user_agent TEXT,
    meta JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_org_created
    ON audit_log(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor
    ON audit_log(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action
    ON audit_log(org_id, action, created_at DESC);

-- Session tracking. A row is inserted at login; it's updated on each request
-- (last_active) and deleted on explicit sign-out. JWT exp still governs
-- validity, but users can revoke individual sessions early.
CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    token_hash TEXT UNIQUE NOT NULL,    -- sha256 of the issued JWT
    ip_addr INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_user
    ON user_sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_hash
    ON user_sessions(token_hash) WHERE revoked_at IS NULL;

-- TOTP secret per user. One row when enrolled; dropped on disable.
CREATE TABLE IF NOT EXISTS two_factor_secrets (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret TEXT NOT NULL,               -- base32 shared secret
    verified_at TIMESTAMPTZ,            -- null until user confirms with a code
    recovery_codes TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Share-link security: add password, one-time use, and download cap.
ALTER TABLE share_links
    ADD COLUMN IF NOT EXISTS password_hash TEXT,
    ADD COLUMN IF NOT EXISTS one_time BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS download_limit INT,
    ADD COLUMN IF NOT EXISTS download_count INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;

-- Per-download event log (fed by the download handler; also surfaced in the
-- audit page).
CREATE TABLE IF NOT EXISTS share_access_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    share_id UUID NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
    file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    ip_addr INET,
    user_agent TEXT,
    action TEXT NOT NULL,               -- "view" | "download"
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_share_access_share
    ON share_access_log(share_id, created_at DESC);

-- File classification and legal hold.
ALTER TABLE files
    ADD COLUMN IF NOT EXISTS classification TEXT NOT NULL DEFAULT 'internal',
    -- public | internal | confidential | restricted
    ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS legal_hold_reason TEXT,
    ADD COLUMN IF NOT EXISTS legal_hold_by UUID REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS legal_hold_at TIMESTAMPTZ;

-- Workspace security settings (per org).
CREATE TABLE IF NOT EXISTS org_security_settings (
    org_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    require_mfa BOOLEAN NOT NULL DEFAULT FALSE,
    session_ttl_hours INT NOT NULL DEFAULT 24,
    min_password_length INT NOT NULL DEFAULT 8,
    require_password_complexity BOOLEAN NOT NULL DEFAULT TRUE,
    retention_days INT,                    -- null = unlimited
    ip_allowlist CIDR[] NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID REFERENCES users(id)
);

-- Rate-limit counters (token bucket replacement via row TTL).
CREATE TABLE IF NOT EXISTS rate_limit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket TEXT NOT NULL,       -- e.g. "login:ip:1.2.3.4"
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_bucket
    ON rate_limit_events(bucket, created_at DESC);
