-- Phase-3 super-admin: org-level controls.
--
-- frozen_*    — soft suspension. Reads still work; non-GET requests
--               from within the org are rejected with 423 by the auth
--               middleware. Super-admin requests are exempted so an
--               operator can clean up before unfreezing.
-- deleted_at  — soft-delete tombstone. Sign-ins to a deleted org fail
--               at the login query; existing sessions are revoked when
--               the flag is flipped.
-- plan        — informational label ('free', 'pro', 'enterprise', ...).
--               Per-plan enforcement lives at the call sites that care.
-- max_users / max_storage_bytes — quotas. NULL means unlimited.
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS frozen_at        TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS frozen_by        UUID REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS frozen_reason    TEXT,
    ADD COLUMN IF NOT EXISTS deleted_at       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS plan             TEXT NOT NULL DEFAULT 'free',
    ADD COLUMN IF NOT EXISTS max_users        INT,
    ADD COLUMN IF NOT EXISTS max_storage_bytes BIGINT;

CREATE INDEX IF NOT EXISTS organizations_frozen_idx
    ON organizations(frozen_at) WHERE frozen_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS organizations_deleted_idx
    ON organizations(deleted_at) WHERE deleted_at IS NOT NULL;
