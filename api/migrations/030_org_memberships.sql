-- Phase-3 super-admin: multi-org memberships.
--
-- Today users.org_id is the user's "home" org and the only one their
-- JWT can address. This table lets a single user belong to several
-- orgs — Drive360 staff, an accountant who works for two clients, etc.
--
-- The active org continues to live on the JWT (claim "oid"). The web
-- app calls /v1/me/switch-org to mint a fresh JWT for a different
-- membership. users.org_id stays as the default landing org so old
-- code paths keep working.
--
-- source explains how the row got created:
--   "primary"  — backfilled from users.org_id at migration time
--   "invite"   — accepted a team invite
--   "admin"    — super-admin added the user manually
CREATE TABLE IF NOT EXISTS org_memberships (
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role       TEXT NOT NULL DEFAULT 'editor',
    source     TEXT NOT NULL DEFAULT 'invite',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, org_id)
);

CREATE INDEX IF NOT EXISTS org_memberships_org_idx ON org_memberships(org_id);

-- Backfill: every existing user becomes a member of their primary org.
INSERT INTO org_memberships (user_id, org_id, role, source)
SELECT id, org_id, COALESCE(role,'editor'), 'primary'
  FROM users
ON CONFLICT (user_id, org_id) DO NOTHING;
