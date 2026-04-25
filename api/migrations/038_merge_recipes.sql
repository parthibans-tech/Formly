-- Merge Recipes — saved, callable PDF stitching configurations.
--
-- A recipe is the merge analog of a template: defined once in the
-- workspace UI, then invoked from any external app via API key (or
-- internally via JWT). Each recipe is an ordered list of components,
-- where a component is either a static file (PDF / DOCX / image —
-- included as-is or with a page subset) or a template (rendered from
-- the caller's data first, then merged).
--
-- Why two tables (recipes + components) instead of a single jsonb
-- column on recipes? Components have foreign keys into files /
-- templates whose lifecycles we want the database to enforce: if the
-- source file is trashed or the template deleted, ON DELETE SET NULL
-- on the FK leaves the recipe row but flags the broken component so
-- the run handler can return a precise 422 instead of a confusing
-- 500. A jsonb-of-IDs would silently dangle.
--
-- data_key is what makes "different data per file" work cleanly.
-- The caller sends one big payload `{ data: {...} }`, and each
-- template component reads only `data[<data_key>]`. So
-- `candidate.name` for component A and `company.name` for component
-- B never collide, even though both PDFs have a "name" field — they
-- live in different sub-objects of the request.
CREATE TABLE IF NOT EXISTS merge_recipes (
    id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                uuid        NOT NULL,
    owner_id              uuid        NOT NULL,
    name                  text        NOT NULL,
    description           text        NOT NULL DEFAULT '',
    -- Optional Mustache-flavored template for the output filename. Empty
    -- means "use the recipe name". Available variables: {{ name }},
    -- {{ date }} (today, YYYY-MM-DD), and any path inside the data
    -- object, e.g. {{ candidate.name }}.
    output_name_template  text        NOT NULL DEFAULT '',
    -- Reserved for future flags (default flatten, retention, etc.) so
    -- we don't have to add columns for every small toggle.
    config_json           jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- last_run_at lets the list view sort by recency without joining
    -- merge_jobs. Updated by the run handler in the same transaction
    -- as the output file insert.
    last_run_at           timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_merge_recipes_org_created
    ON merge_recipes(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS merge_recipe_components (
    id            uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id     uuid    NOT NULL REFERENCES merge_recipes(id) ON DELETE CASCADE,
    -- 0-based ordinal that drives the merge order. Updated atomically
    -- by the PATCH handler to keep gaps from forming after deletes.
    position      int     NOT NULL,
    kind          text    NOT NULL CHECK (kind IN ('file', 'template')),
    -- Exactly one of file_id / template_id is populated; the CHECK
    -- constraint enforces it. ON DELETE SET NULL keeps the recipe
    -- usable (with a missing-component error) when the underlying
    -- resource is removed — better than cascading the recipe death.
    file_id       uuid    REFERENCES files(id) ON DELETE SET NULL,
    template_id   uuid    REFERENCES templates(id) ON DELETE SET NULL,
    -- Page subset; "all" / "" means whole document. Same grammar as
    -- pdfmerge.validatePageRange: "1-3,5,7-9", "odd", "even".
    pages         text    NOT NULL DEFAULT 'all',
    -- Namespace for this component's slice of the request payload.
    -- Empty = the whole `data` object (one-template recipes). Most
    -- recipes set a non-empty key so multiple template components can
    -- coexist without field-name collisions.
    data_key      text    NOT NULL DEFAULT '',
    -- When false, a missing data_key in the request just skips this
    -- component instead of failing the merge. Useful for "add an
    -- annexure if the candidate has equity grants" style flows.
    required      boolean NOT NULL DEFAULT true,
    -- Per-component flatten flag for AcroForm templates. Defaults
    -- false because most recipes want fillable PDFs preserved.
    flatten       boolean NOT NULL DEFAULT false,
    -- Optional human label, shown in the recipe builder UI. When
    -- empty the UI falls back to the file/template name.
    label         text,
    CONSTRAINT merge_recipe_components_kind_target CHECK (
        (kind = 'file' AND file_id IS NOT NULL) OR
        (kind = 'template' AND template_id IS NOT NULL)
    )
);

-- The (recipe_id, position) ordering is the single hot read pattern
-- (the run handler scans components in order). Unique on the pair so
-- a misbehaving update can't accidentally produce two #3 components.
CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_recipe_components_order
    ON merge_recipe_components(recipe_id, position);

CREATE INDEX IF NOT EXISTS idx_merge_recipe_components_file
    ON merge_recipe_components(file_id) WHERE file_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_merge_recipe_components_template
    ON merge_recipe_components(template_id) WHERE template_id IS NOT NULL;
