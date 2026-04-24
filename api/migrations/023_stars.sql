-- 023_stars.sql — per-user starred files.
--
-- "Starred" is user-scoped, not org-scoped: two users in the same org star
-- files independently. Files are the only resource that can be starred
-- today — folders deliberately skipped because our "views" (recent,
-- shared, starred) are file-oriented and nobody has asked for starred
-- folders yet. If/when they do, add a resource_type column and broaden
-- this table rather than spinning up a second one.
--
-- The (user_id, file_id) pair is the natural key, so we use it as the
-- primary key directly — no surrogate id needed. org_id is denormalised
-- onto the row so we can cheaply constrain queries and hard-delete
-- starred rows when a file is purged, without a files-table join.

CREATE TABLE IF NOT EXISTS starred_files (
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_id    UUID        NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    org_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, file_id)
);

-- Most queries look up "all stars for this user in this org" (the Starred
-- view). Composite index matches that access pattern.
CREATE INDEX IF NOT EXISTS idx_starred_files_user_org
    ON starred_files (user_id, org_id, created_at DESC);

-- Secondary lookup: "is this file starred by this user?" — already served
-- by the PRIMARY KEY, no extra index needed.
