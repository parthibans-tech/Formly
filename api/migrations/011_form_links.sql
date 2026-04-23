-- Form links: a public URL per template that renders a web form derived from
-- the template's placeholders. Filling the form generates a PDF without the
-- submitter needing a Formly account.
CREATE TABLE IF NOT EXISTS form_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  title TEXT,
  description TEXT,
  submit_label TEXT,
  success_message TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS form_links_org_idx ON form_links(org_id);
CREATE INDEX IF NOT EXISTS form_links_template_idx ON form_links(template_id);

CREATE TABLE IF NOT EXISTS form_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_link_id UUID NOT NULL REFERENCES form_links(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  data JSONB NOT NULL,
  output_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS form_submissions_link_idx
  ON form_submissions(form_link_id, created_at DESC);
