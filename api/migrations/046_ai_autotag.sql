-- 046_ai_autotag.sql
--
-- Auto-tag + auto-rename pipeline. Adds the columns the post-upload
-- worker writes back to, plus a GIN index so the future "filter files
-- by tag" query stays fast.
--
-- # Why a separate column for the rename suggestion
--
-- We do NOT always overwrite files.name with the model's suggestion.
-- The user's filename is sacred when it looks intentional
-- ("Q3-2026-Renewal-Agreement.docx") — clobbering it would be a
-- terrible surprise. The orchestrator only auto-applies the rename
-- when the original looks generic (IMG_1234.pdf, scan.pdf,
-- document.docx, untitled.txt — see internal/autotag.LooksGeneric).
-- For everything else we record the suggestion in
-- `auto_rename_suggestion` and let the UI offer it as a one-click
-- "Apply suggestion?" banner. That keeps the AI helpful without
-- making it feel like it's in charge.
--
-- # original_name
--
-- Populated only when we DID auto-apply the rename, so the user has
-- a one-click "revert to original" path. NULL means files.name has
-- never been touched by the auto-rename pipeline.
--
-- # auto_tag_status mirrors embed_status
--
-- Same five-state machine as embed_status (pending/running/ready/
-- failed/skipped) so operators dashboarding "AI work-in-progress"
-- can union the two columns without remembering which feature uses
-- which states. NULL means AI was off when the file was uploaded.

ALTER TABLE files
    ADD COLUMN IF NOT EXISTS tags                   TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS auto_tag_status        TEXT,
    ADD COLUMN IF NOT EXISTS auto_tag_error         TEXT,
    ADD COLUMN IF NOT EXISTS tagged_at              TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS auto_rename_suggestion TEXT,
    ADD COLUMN IF NOT EXISTS original_name          TEXT;

-- GIN over the tags array — supports `WHERE tags && ARRAY['invoice']`
-- (overlap) and `WHERE tags @> ARRAY['invoice','2026']` (contains-all)
-- with index assistance, so the future tag-filter UI stays cheap on
-- orgs with hundreds of thousands of files.
CREATE INDEX IF NOT EXISTS files_tags_gin_idx
    ON files USING gin (tags);

-- Operator query: "which files are still pending auto-tag?"
-- Same partial-index pattern as files_embed_status_idx — most rows
-- end up `ready` or NULL, so a partial index keeps the bytes minimal.
CREATE INDEX IF NOT EXISTS files_auto_tag_status_idx
    ON files (org_id, auto_tag_status)
    WHERE auto_tag_status IN ('pending', 'running', 'failed');
