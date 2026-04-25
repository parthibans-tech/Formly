-- 041_scanner.sql
--
-- Antivirus / malware scan pipeline.
--
-- The flow:
--
--   1. Complete handler decides (per org policy) whether to scan. If yes,
--      it marks the file row scan_status='pending' and enqueues an asynq
--      TaskScanFile job. Otherwise scan_status='skipped' and the file
--      goes straight to active.
--
--   2. The worker (cmd/worker) picks up TaskScanFile, fetches the blob
--      from object storage, streams it to the configured Scanner
--      (ClamAV INSTREAM in prod, Noop in dev/CI), and stamps the verdict
--      back onto the row: scan_status in ('clean', 'infected', 'error').
--
--   3. Every download/share-resolve handler refuses to issue a presigned
--      URL when scan_status is anything other than 'clean' or 'skipped'.
--      That is the chokepoint: a malicious upload never becomes
--      reachable to a downloader, even with a public share link.
--
-- Why a column on files instead of a sidecar table: the gate is on every
-- download presign (hot path). A two-table join doubles the read; a
-- single column keeps the lookup a primary-key scan. The scan_jobs
-- table below is the audit trail / retry log, not the gate.

ALTER TABLE files
    ADD COLUMN IF NOT EXISTS scan_status text NOT NULL DEFAULT 'skipped',
    ADD COLUMN IF NOT EXISTS scan_signature text,
    ADD COLUMN IF NOT EXISTS scan_engine text,
    ADD COLUMN IF NOT EXISTS scanned_at timestamptz;

-- Hash-based partial index: most rows will be 'clean' or 'skipped' (the
-- happy path) and we never query for those by status alone — we always
-- have a file_id. The index targets operator queries: "show me every
-- pending / infected / error file across the workspace."
CREATE INDEX IF NOT EXISTS files_scan_status_idx
    ON files (org_id, scan_status)
    WHERE scan_status IN ('pending', 'scanning', 'infected', 'error');

-- ---------- scan_jobs (audit trail) -------------------------------------
--
-- One row per scan attempt. Holds the worker's bookkeeping so we can
-- diagnose stuck scans, replay them, and surface verdict history in the
-- UI. The actual queueing is done via asynq + Redis (TaskScanFile);
-- this table is the durable log, not the message bus.
CREATE TABLE IF NOT EXISTS scan_jobs (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id     uuid        NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    org_id      uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    storage_key text        NOT NULL,

    -- queued | running | done | error
    status      text        NOT NULL DEFAULT 'queued',
    attempts    int         NOT NULL DEFAULT 0,

    -- Verdict mirrors files.scan_status when status='done'. Kept here
    -- separately so re-scans don't lose history.
    verdict     text,
    signature   text,
    engine      text,
    last_error  text,

    created_at  timestamptz NOT NULL DEFAULT now(),
    started_at  timestamptz,
    finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS scan_jobs_file_idx ON scan_jobs (file_id, created_at DESC);
CREATE INDEX IF NOT EXISTS scan_jobs_org_status_idx ON scan_jobs (org_id, status, created_at DESC);
