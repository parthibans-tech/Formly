CREATE TABLE IF NOT EXISTS templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('acroform','static','html')),
    name TEXT NOT NULL,
    config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (file_id)
);

CREATE INDEX IF NOT EXISTS idx_templates_org ON templates(org_id);

CREATE TABLE IF NOT EXISTS template_fields (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    page INTEGER,
    rect_json JSONB,
    options JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_template_fields_tpl ON template_fields(template_id);

CREATE TABLE IF NOT EXISTS template_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    config_snapshot JSONB NOT NULL,
    author_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (template_id, version)
);

ALTER TABLE files ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES templates(id) ON DELETE SET NULL;
