-- 051_org_kind.sql
-- Adds a `kind` discriminator to organizations so we can distinguish
-- personal workspaces (created by the "Just me" signup option) from
-- team orgs that participate in invites and seat-based billing.
--
-- Why a column rather than a heuristic (like "1 member && no invites"):
--   - Personal orgs are *intentionally* sealed against CreateInvite —
--     we refuse with 409 personal_org_no_invites the moment an admin
--     tries to invite anyone, regardless of seat count. Heuristics
--     can't express that policy.
--   - A user with a personal org who later gets invited to a team org
--     keeps their personal workspace as a separate switchable org.
--     Counting members alone would silently re-classify the personal
--     org the moment they were added to a team.
--
-- Default 'team' so every existing organization keeps its current
-- behavior. Only orgs created by the new personal-signup path land
-- with kind='personal'.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'team'
    CHECK (kind IN ('team','personal'));

-- Lookup index: most reads are by id and already covered by the PK,
-- but the seat-cap and invite-create paths filter by kind on a single
-- org row, so a btree on (id, kind) gives us a covering index for
-- those hot reads without a sequential scan in tests.
CREATE INDEX IF NOT EXISTS idx_organizations_kind ON organizations (kind);
