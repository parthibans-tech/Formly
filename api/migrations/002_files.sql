CREATE TABLE IF NOT EXISTS files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    mime TEXT NOT NULL DEFAULT 'application/octet-stream',
    size BIGINT NOT NULL DEFAULT 0,
    storage_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    trashed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_files_org ON files(org_id) WHERE trashed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
