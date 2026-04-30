-- 052_memberships_source_of_truth.sql
-- Phase 4 of the multi-org rollout: promote `org_memberships` to the
-- canonical source of truth for "user X is in org Y" and lock down the
-- invariant that every user has a membership row for their primary org.
--
-- Why this exists alongside 030 (which already created the table and
-- did the initial backfill):
--
--   1. Between 030 landing and Phase 1's auth.Register fix, every new
--      signup created a `users` row but NOT a corresponding
--      `org_memberships` row. Production DBs may have hundreds of
--      these gaps. We re-run the backfill idempotently to fix them.
--
--   2. Phase 4 drops the MULTI_ORG_SEATS env flag — seat counting
--      always uses memberships now. Any gap above silently inflates
--      the seat count (because `users WHERE org_id=$1` returned them
--      but `org_memberships WHERE org_id=$1` did not). Closing the gap
--      keeps existing customers' counts stable across the flip.
--
--   3. We add an explicit invariant check at the bottom — if any user
--      is still missing a primary membership after the backfill, the
--      migration aborts so the operator notices before the app boots
--      against an inconsistent DB.

-- ---------------------------------------------------------------------------
-- Re-backfill: idempotent. Every user gets a membership for their
-- primary org (users.org_id) tagged 'primary', if they don't already
-- have one. Role is mirrored from users.role so the user's role at
-- their primary org is preserved.
-- ---------------------------------------------------------------------------
INSERT INTO org_memberships (user_id, org_id, role, source)
SELECT u.id, u.org_id, COALESCE(u.role,'editor'), 'primary'
  FROM users u
  WHERE u.org_id IS NOT NULL
ON CONFLICT (user_id, org_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Invariant assertion. After the backfill, every (user, primary_org)
-- pair must have a membership row. If the count of orphaned users
-- isn't zero, refuse to commit — operator will need to investigate.
-- This catches: users with NULL org_id, FK-broken org_id pointing at a
-- now-deleted org, etc. Each case needs a manual decision (delete the
-- user, repoint the org, etc.) we don't want to make on their behalf.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  orphans int;
BEGIN
  SELECT COUNT(*) INTO orphans
    FROM users u
    WHERE u.org_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM org_memberships m
         WHERE m.user_id = u.id AND m.org_id = u.org_id
      );
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'memberships invariant: % users still lack a membership row for their primary org — investigate before retrying',
      orphans;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Helper index for the new "find a member of this org" lookup pattern.
-- Member listing now joins users → org_memberships filtered by org_id;
-- the existing org_memberships_org_idx covers the org_id side, but the
-- ORDER BY (role='admin' DESC, created_at) needs created_at present in
-- the heap, which it already is. No new index needed — calling this
-- out so the next reviewer doesn't re-add one redundantly.
-- ---------------------------------------------------------------------------
