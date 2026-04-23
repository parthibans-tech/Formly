-- Template lifecycle status. `draft` is the default; `in_review` when a
-- review request is open; `approved` once signed off.
ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';

-- Review requests. One review per (template_id, reviewer_id, requested_at)
-- with a status flag. Reviewer can approve / request changes; the decision
-- is recorded alongside an optional comment.
CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  version INT NOT NULL,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reviewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | approved | changes_requested | cancelled
  comment TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reviews_template_idx
  ON reviews(template_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reviews_reviewer_idx
  ON reviews(reviewer_id, status);

-- Presence: a rolling "who's here" log with 60s TTL (deleted via periodic
-- sweep in the worker, or on stale heartbeat read).
CREATE TABLE IF NOT EXISTS template_presence (
  template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, user_id)
);
CREATE INDEX IF NOT EXISTS template_presence_seen_idx
  ON template_presence(last_seen_at);
