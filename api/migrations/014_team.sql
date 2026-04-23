-- Team + roles. Roles are simple strings: 'admin' | 'editor' | 'viewer'.
-- First user in every org becomes admin; everyone else defaults to editor.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'editor';

-- Upgrade the earliest user of each org to admin so existing single-seat
-- workspaces keep their owner's capabilities.
WITH first_users AS (
  SELECT DISTINCT ON (org_id) id
    FROM users
    ORDER BY org_id, created_at ASC
)
UPDATE users u
   SET role = 'admin'
  FROM first_users f
 WHERE u.id = f.id
   AND u.role <> 'admin';

-- Invitations: a tokenized pending membership. A row is consumed on accept
-- (accepted_at set) and kept for audit. Tokens are random base64url.
CREATE TABLE IF NOT EXISTS invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',
  token TEXT NOT NULL UNIQUE,
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS invitations_org_idx ON invitations(org_id);
CREATE INDEX IF NOT EXISTS invitations_email_idx ON invitations(org_id, email);
