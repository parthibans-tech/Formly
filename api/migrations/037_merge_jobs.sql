-- PDF merge / page-ops job tracking.
--
-- Synchronous merges (≤5 small native PDFs) skip this table entirely
-- and return the new file ID directly. Async merges — heterogeneous
-- inputs that need LibreOffice conversion, or large input sets — are
-- queued via asynq, which inserts a row here so the UI can poll status
-- and pick up the resulting fileId once the worker finishes.
--
-- status lifecycle:
--   'queued'  → worker hasn't picked it up yet
--   'running' → worker is processing
--   'done'    → file_id is populated; client can navigate to it
--   'failed'  → error column has a user-facing message
--
-- payload is the original request body so the worker is stateless and
-- a row can be re-driven by an asynq retry without the HTTP handler
-- re-executing.
CREATE TABLE IF NOT EXISTS merge_jobs (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid        NOT NULL,
    user_id     uuid        NOT NULL,
    status      text        NOT NULL DEFAULT 'queued',
    payload     jsonb       NOT NULL,
    file_id     uuid        REFERENCES files(id) ON DELETE SET NULL,
    error       text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_merge_jobs_org_user_created
    ON merge_jobs(org_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_merge_jobs_status
    ON merge_jobs(status) WHERE status IN ('queued', 'running');
