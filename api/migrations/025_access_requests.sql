-- Access-request inbox.
--
-- Previously sharing was owner-push only: the owner had to know a
-- teammate needed access and go grant it via the share dialog. If a
-- viewer landed on a file they didn't have edit rights to, the only
-- recovery was "message the owner out-of-band" — not discoverable, and
-- friction enough that most users just gave up and asked IT.
--
-- This table lets a viewer *pull* a request instead. The viewer hits
-- POST /v1/files/:id/request-access with an optional message; the owner
-- sees pending rows in their inbox and can approve (creates the matching
-- resource_shares row) or deny.
--
-- A partial unique index keeps at most one "pending" row per
-- (file, requester) — re-requesting after a denial is allowed (previous
-- row moved to status='denied'), but spamming the same request isn't.

CREATE TABLE IF NOT EXISTS access_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- What the requester is asking for. Defaults to 'editor' because
    -- viewers who already have view access are the usual askers — they
    -- click "request access" because view isn't enough. A 'viewer' row
    -- is still legal for the "I have no access at all" path (e.g. a
    -- direct-link share preview).
    requested_role TEXT NOT NULL DEFAULT 'editor'
        CHECK (requested_role IN ('viewer','editor')),
    message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','denied','cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ,
    decided_by UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_access_requests_file
    ON access_requests(file_id);
CREATE INDEX IF NOT EXISTS idx_access_requests_requester
    ON access_requests(requester_id);
-- At most one open request per (file, requester). Once the owner decides
-- (approve / deny / cancel) the row drops out of this partial index, so
-- the requester can file a fresh one later.
CREATE UNIQUE INDEX IF NOT EXISTS uq_access_requests_pending
    ON access_requests(file_id, requester_id)
    WHERE status = 'pending';
