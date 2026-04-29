-- Super-admin flag + platform-operator seed.
--
-- Until now, super-admin status was inferred from PLATFORM_ROOT_ORG_ID
-- (an env var) — admin of THAT org = platform operator. That worked for
-- a single-tenant install but broke in multi-tenant: the env had to be
-- backfilled AFTER the first signup, and any admin signup before that
-- accidentally became super-admin.
--
-- The new model: a dedicated `is_super_admin` column on users. The
-- platform-operator account is seeded here so a fresh database boots
-- with a usable login (parthiban@drive360.com). Every subsequent
-- signup defaults to is_super_admin=false.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_users_super_admin
    ON users(is_super_admin) WHERE is_super_admin;

-- Idempotent seed: insert the platform org + operator user only if no
-- super-admin already exists. Re-running this migration on a database
-- where a super-admin has been promoted manually is a no-op.
DO $$
DECLARE
    v_org_id UUID;
    v_user_email TEXT := 'parthiban@drive360.com';
    v_user_name  TEXT := 'Parthiban';
    -- bcrypt(cost=12) of 'Parthi@05'. Regenerate with:
    --   go run ./scripts/genhash.go 'newpass'
    v_pw_hash    TEXT := '$2a$12$II63S4HA3sz/IvW96dbJPeyUgqbmvodihfI0VeH6lKpizuMezImQq';
BEGIN
    IF EXISTS (SELECT 1 FROM users WHERE is_super_admin) THEN
        RAISE NOTICE 'super-admin already exists, skipping seed';
        RETURN;
    END IF;

    -- If an account with this email already exists (manual signup),
    -- just promote it instead of failing on the unique-email constraint.
    IF EXISTS (SELECT 1 FROM users WHERE email = v_user_email) THEN
        UPDATE users SET is_super_admin = TRUE, role = 'admin'
         WHERE email = v_user_email;
        RAISE NOTICE 'promoted existing user % to super-admin', v_user_email;
        RETURN;
    END IF;

    -- Fresh seed: create the platform org and the operator user inside it.
    INSERT INTO organizations (name) VALUES ('Drive360 Platform') RETURNING id INTO v_org_id;
    INSERT INTO users (org_id, email, password_hash, name, role, is_super_admin)
        VALUES (v_org_id, v_user_email, v_pw_hash, v_user_name, 'admin', TRUE);
    RAISE NOTICE 'seeded super-admin %', v_user_email;
END $$;
