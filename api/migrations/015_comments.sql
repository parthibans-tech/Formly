-- Threaded comments anchored to a template. Optional `anchor` stores a
-- placeholder path (e.g. "customer.email") so comments can point at a
-- specific field; NULL means "template-level". Guest entries (`author_email`
-- + `author_name`) are used for external reviewer comments in C6.
CREATE TABLE IF NOT EXISTS comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,
  author_id UUID REFERENCES users(id) ON DELETE SET NULL,
  author_email TEXT,
  author_name TEXT,
  anchor TEXT,
  body TEXT NOT NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_template_idx
  ON comments(template_id, created_at ASC);
CREATE INDEX IF NOT EXISTS comments_parent_idx
  ON comments(parent_id);

-- Many-to-many: a comment can mention multiple users. Used for a per-user
-- "inbox" view and to fire `comment.mentioned` webhook events.
CREATE TABLE IF NOT EXISTS comment_mentions (
  comment_id UUID NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ,
  PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX IF NOT EXISTS comment_mentions_user_idx
  ON comment_mentions(user_id, read_at);
