-- Per-user/per-group sharing for files and folders.
--
-- Until now everything in Drive was visible org-wide: the list queries
-- filtered by `org_id` and nothing else, so any teammate could see any
-- file. This migration adds the plumbing for private-by-default Drive
-- with explicit user + group shares.
--
-- Schema:
--   groups          — named collections of org members the owner can share
--                     with. Unique name per org, case-insensitive.
--   group_members   — many-to-many; a user can be in any number of groups.
--   resource_shares — ACL rows for files AND folders. A row is keyed
--                     by (resource_type, resource_id) and grants access
--                     to exactly one principal (user_id XOR group_id).
--                     Role is `viewer` (can see + download) or `editor`
--                     (can see + modify). Ownership stays with
--                     files.owner_id / folders.owner_id — shares are
--                     purely read/modify grants.
--
-- Visibility rules enforced at the handler layer:
--   - Owner of the resource always sees it.
--   - A resource_shares row with user_id=me grants access.
--   - A resource_shares row with group_id=g where I'm a member of g
--     grants access.
--   - For files: if the file's folder_id (or any ancestor folder) has
--     a resource_shares row that grants me access, the file is
--     visible too. (Folder shares cascade to their contents.)
--
-- Migration is additive; no data changes needed. Existing files keep
-- their owner_id — the visibility change takes effect once the new
-- list query ships. Admins can still see everything via an explicit
-- `?view=org` escape hatch on list endpoints.

CREATE TABLE IF NOT EXISTS groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness per org so "Finance" and "finance" collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_groups_org_name
    ON groups (org_id, lower(name));

CREATE TABLE IF NOT EXISTS group_members (
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_by UUID REFERENCES users(id),
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_user
    ON group_members(user_id);

CREATE TABLE IF NOT EXISTS resource_shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('file','folder')),
    resource_id UUID NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'viewer'
        CHECK (role IN ('viewer','editor')),
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- exactly one of user_id / group_id must be set.
    CHECK ((user_id IS NOT NULL)::int + (group_id IS NOT NULL)::int = 1)
);

-- Lookup by resource (for "who is this shared with?" and ACL eval).
CREATE INDEX IF NOT EXISTS idx_resource_shares_resource
    ON resource_shares(resource_type, resource_id);
-- Lookup by principal (for "shared with me" queries).
CREATE INDEX IF NOT EXISTS idx_resource_shares_user
    ON resource_shares(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_resource_shares_group
    ON resource_shares(group_id) WHERE group_id IS NOT NULL;

-- At most one row per (resource, principal) — re-sharing should update
-- the existing row's role, not stack duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_resource_shares_user
    ON resource_shares(resource_type, resource_id, user_id)
    WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_resource_shares_group
    ON resource_shares(resource_type, resource_id, group_id)
    WHERE group_id IS NOT NULL;
