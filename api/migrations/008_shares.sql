CREATE TABLE IF NOT EXISTS share_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',   -- viewer | downloader
    expires_at TIMESTAMPTZ,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_shares_file ON share_links(file_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shares_token ON share_links(token) WHERE revoked_at IS NULL;
