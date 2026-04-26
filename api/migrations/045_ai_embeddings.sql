-- 045_ai_embeddings.sql
--
-- AI smart-search foundation. Adds the pgvector extension and a
-- file_chunks table to hold per-file embedding rows.
--
-- Why a separate chunks table (and not a vector column on `files`):
--
--   1. A single PDF embeds into N chunks (one per ~512 tokens of
--      content). One vector per file would either truncate at the
--      first chunk or average them (which destroys the signal).
--   2. Search ranks by cosine distance against any chunk and lets
--      us return the matching snippet for highlighting — which
--      a per-file row can't do.
--   3. Re-embedding a file (model upgrade, OCR backfill) is a
--      DELETE + INSERT on this table only; we never touch `files`.
--
-- Why the migration is wrapped in a DO/EXCEPTION block:
--
-- Pgvector ships as a Postgres extension that has to be present in
-- the cluster's binary distribution. Most stock postgres images
-- don't include it; infra/docker-compose.yml uses
-- `pgvector/pgvector:pg16` for that reason. To keep this migration
-- non-fatal for older or self-hosted deploys that haven't switched
-- images yet, we attempt CREATE EXTENSION inside an exception
-- handler. On success, we create the table + index; on failure we
-- emit a NOTICE and bail. The boot will continue and AI features
-- stay off (the smart-search endpoint will 503 with a clear
-- message). Once the operator switches images, re-running this
-- migration via the standard schema_migrations replay will succeed
-- — but since we record the filename either way, we'd skip it.
-- That's fine: if AI gets turned on, the embedding worker tries
-- INSERTs against a missing table, surfaces a clear pg error in
-- the worker log, and the operator runs the manual fix-up
-- (see docs/ops/ai.md when written).

DO $$
BEGIN
    -- Try to install pgvector. If it succeeds (or is already
    -- installed) we proceed to create the chunks table. If the
    -- binary isn't shipped with this Postgres install, raise NOTICE
    -- and exit the block — the migration is recorded as applied
    -- and the rest of the app boots normally.
    BEGIN
        CREATE EXTENSION IF NOT EXISTS vector;
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'pgvector extension not available — AI smart search disabled. Switch postgres image to pgvector/pgvector:pg16 and re-create the volume to enable. (%)', SQLERRM;
        RETURN;
    END;

    -- file_chunks: one row per content slice. The embedding is a
    -- 768-dim vector (matches `nomic-embed-text`, the default
    -- Ollama embedding model). Operators on a different model with
    -- a different dim will hit a column-type mismatch on INSERT —
    -- which is the loud failure mode we want.
    CREATE TABLE IF NOT EXISTS file_chunks (
        id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        file_id      uuid        NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        org_id       uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        chunk_index  int         NOT NULL,
        content      text        NOT NULL,
        embedding    vector(768) NOT NULL,
        model        text        NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now(),
        UNIQUE (file_id, chunk_index)
    );

    -- Org-scoped lookup: the search endpoint always filters on
    -- org_id before doing the vector distance scan, so the planner
    -- needs a quick way to narrow to the org. The `embedding`
    -- column gets its own HNSW index below for ANN scoring.
    CREATE INDEX IF NOT EXISTS file_chunks_org_idx
        ON file_chunks (org_id);

    CREATE INDEX IF NOT EXISTS file_chunks_file_idx
        ON file_chunks (file_id);

    -- HNSW = Hierarchical Navigable Small World. Pgvector's best
    -- ANN index for read-heavy workloads. Cosine distance because
    -- nomic-embed-text returns normalised vectors and cosine is
    -- the metric Ollama's docs recommend pairing with it. Build
    -- params (m=16, ef_construction=64) are pgvector defaults —
    -- safe baseline; tune if recall < 95% on a real corpus.
    CREATE INDEX IF NOT EXISTS file_chunks_embedding_idx
        ON file_chunks USING hnsw (embedding vector_cosine_ops);

    -- Per-file embedding status. Mirrors the convert_status pattern:
    --   pending  - enqueued, worker hasn't started
    --   running  - worker pulled the job
    --   ready    - all chunks embedded
    --   failed   - error during embedding (see embed_error)
    --   skipped  - file isn't textual / extraction returned empty
    -- A NULL value means the file pre-dates AI being enabled.
    ALTER TABLE files
        ADD COLUMN IF NOT EXISTS embed_status text,
        ADD COLUMN IF NOT EXISTS embed_error  text,
        ADD COLUMN IF NOT EXISTS embedded_at  timestamptz;

    -- Operator query: "which files are still pending embedding?"
    -- Partial index keeps it tiny — most rows will end up `ready`
    -- or NULL.
    CREATE INDEX IF NOT EXISTS files_embed_status_idx
        ON files (org_id, embed_status)
        WHERE embed_status IN ('pending', 'running', 'failed');
END $$;
