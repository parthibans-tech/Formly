-- 050_org_logo.sql
-- Adds logo storage fields to organizations so each tenant can upload a brand logo
-- that is rendered in the app shell header and on billing artefacts.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS logo_object_key TEXT,
  ADD COLUMN IF NOT EXISTS logo_mime       TEXT,
  ADD COLUMN IF NOT EXISTS logo_updated_at TIMESTAMPTZ;
