-- External reviewer links: tokenized URLs that let a non-Drive360 user view a
-- rendered preview of a template, leave comments, and approve or reject —
-- without creating an account. Their decisions + comments land in the same
-- tables as internal reviewers (comments.author_id NULL, reviews with
-- reviewer_id=NULL).

CREATE TABLE IF NOT EXISTS review_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  guest_email TEXT,
  guest_name TEXT,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | changes_requested | revoked
  decision_comment TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS review_links_template_idx
  ON review_links(template_id, created_at DESC);

-- Allow NULL reviewer in the reviews table so external decisions can be
-- recorded alongside internal ones.
ALTER TABLE reviews ALTER COLUMN reviewer_id DROP NOT NULL;

-- Widen comments so guest authors store their guest identity. Already
-- nullable columns (author_id, author_email, author_name) are in migration
-- 015_comments.sql — nothing to add.
