CREATE TABLE IF NOT EXISTS template_widgets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    type TEXT NOT NULL,                 -- text|multiline|date|number|currency|checkbox|image|qr
    page INTEGER NOT NULL DEFAULT 1,
    -- Stored in PDF space: origin bottom-left, units = points.
    x DOUBLE PRECISION NOT NULL,
    y DOUBLE PRECISION NOT NULL,
    w DOUBLE PRECISION NOT NULL,
    h DOUBLE PRECISION NOT NULL,
    data_key TEXT NOT NULL,
    z_index INTEGER NOT NULL DEFAULT 0,
    props_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_widgets_tpl ON template_widgets(template_id, page);
