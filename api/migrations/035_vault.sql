-- Locked folders ("vault"). Folders flagged as locked require the caller
-- to re-authenticate (password + MFA when enabled) within the last
-- VAULT_TTL minutes before the API will list, read, or download anything
-- inside them. ACLs / sharing are unaffected — this is a *second* gate
-- layered on top of access, used for sensitive folders (contracts,
-- payroll, HR) where ambient session reuse isn't enough.

ALTER TABLE folders
    ADD COLUMN IF NOT EXISTS locked_at  timestamptz,
    ADD COLUMN IF NOT EXISTS locked_by  uuid REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_folders_locked
    ON folders(org_id) WHERE locked_at IS NOT NULL;

-- Global, per-user vault unlock. One row per user; refreshed on each
-- successful re-auth. Expired rows are ignored (and lazily deleted by
-- the unlock handler on next write).
CREATE TABLE IF NOT EXISTS vault_sessions (
    user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
