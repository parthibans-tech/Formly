CREATE TABLE IF NOT EXISTS generation_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(id),
    kind TEXT NOT NULL DEFAULT 'single',          -- single | batch
    status TEXT NOT NULL DEFAULT 'queued',         -- queued | running | completed | failed
    priority TEXT NOT NULL DEFAULT 'standard',
    input_ref TEXT,                                -- MinIO key for large input data (batch CSV)
    output_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
    total INTEGER NOT NULL DEFAULT 1,
    done INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_org ON generation_jobs(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON generation_jobs(status);
