-- Phase-2 super-admin user management.
--
-- Why this migration exists
-- -------------------------
-- Sometimes the right response to a compromised account isn't to
-- *lock* it (which blocks the user entirely) — it's to invalidate
-- the existing password and force a fresh one on the next sign-in.
-- This is the standard playbook when:
--   - a user reuses a password that's been leaked elsewhere,
--   - support resets a password over the phone (the temp value
--     handed out should be one-time),
--   - org policy requires periodic rotation.
--
-- We add a single boolean. When true, auth.Login still succeeds
-- (returns a token), but the response carries a `forcePasswordReset`
-- flag that the web app honors by redirecting to /set-password
-- before allowing any other navigation. The new password endpoint
-- clears the flag atomically.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS force_pw_reset BOOLEAN NOT NULL DEFAULT false;
