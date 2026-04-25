-- Recipe-aware merge jobs.
--
-- Recipes reuse the existing merge_jobs row shape (queued/running/done
-- /failed lifecycle, file_id pointer to the output, error column with a
-- user-facing message) so the UI's existing polling code works
-- unchanged. We just add a nullable recipe_id link so recipe runs are
-- distinguishable from ad-hoc /v1/files/merge jobs in the UI's
-- "history" view, and so a deleted recipe doesn't orphan the job row
-- (ON DELETE SET NULL — the job's bytes still exist as a file, the
-- caller just can't trace which recipe produced them).
ALTER TABLE merge_jobs
    ADD COLUMN IF NOT EXISTS recipe_id uuid
        REFERENCES merge_recipes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_merge_jobs_recipe
    ON merge_jobs(recipe_id) WHERE recipe_id IS NOT NULL;
