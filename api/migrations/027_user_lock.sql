-- Phase-1 super-admin user management.
--
-- Why this migration exists
-- -------------------------
-- Until now there was no way for a platform operator to freeze a
-- compromised or abusive account without deleting it. Deletion is
-- destructive (cascades through audit, sessions, comments, etc.) and
-- often the wrong tool — support frequently needs to *pause* sign-in
-- pending an investigation, not erase the user.
--
-- We add three columns so the lock state is self-describing:
--   locked_at      — non-null means "blocked from signing in"; auth.Login
--                    short-circuits before bcrypt with 403 account_locked.
--   locked_by      — which super-admin pressed the button (FK to users)
--   locked_reason  — free-text justification (support ticket #, "MFA
--                    bypass attempt detected", "GDPR pending")
--
-- Unlocking just sets all three to NULL atomically. We keep the trio
-- co-located rather than splitting into a separate table because it's
-- per-user state with at most one active value, and queries that need
-- it (login!) get one column read instead of a join.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS locked_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS locked_by      UUID REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS locked_reason  TEXT;

-- Locked users are a small minority — partial index keeps it cheap.
CREATE INDEX IF NOT EXISTS users_locked_idx
    ON users(locked_at)
 WHERE locked_at IS NOT NULL;
