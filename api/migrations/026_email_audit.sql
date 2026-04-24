-- Email overhaul — pluggable provider widening + richer audit trail.
--
-- Why this migration exists
-- -------------------------
-- The original email_settings.provider column was free-text, but the
-- mail handler hard-codes the set of providers it can build. We're now
-- adding AWS SES as a first-class option, so the constraint check in the
-- application layer would silently reject existing rows pointed at any
-- new provider unless we widen things up here too. There's no
-- application-side CHECK to drop — we keep this migration lean.
--
-- The audit table (`email_sends`) historically only knew about
-- "user generated a PDF and emailed it." With the new reusable Mailer,
-- ANY subsystem can send mail (access-request notifications, team
-- invites, MFA codes, system alerts). We need three new columns to
-- attribute each row:
--
--   kind          — what business event this email represents
--                   (test, template, invitation, access_request,
--                    notification, system). Free-text but conventional.
--   source        — which Go package emitted the row (e.g. "mail.test",
--                   "sharing.access_request_approved", "team.invite").
--                   Used by the super-admin viewer to filter by
--                   subsystem.
--   metadata      — opaque JSONB for whatever the calling subsystem
--                   wants to remember. The access-request flow stuffs
--                   request IDs here; the invite flow stores the invite
--                   token. Inspectable in the audit UI.
--   from_email/   — record what envelope was actually used. Without
--   from_name       these, the "Recent sends" list can't show which
--                   sender address was active when the row was written
--                   (which matters once orgs change providers or when
--                   the env-fallback config kicks in).
--
-- Existing rows get sensible defaults so the application doesn't need
-- to special-case "is this a legacy row?" anywhere.

ALTER TABLE email_sends
    ADD COLUMN IF NOT EXISTS kind        TEXT NOT NULL DEFAULT 'template',
    ADD COLUMN IF NOT EXISTS source      TEXT NOT NULL DEFAULT 'mail.send_template',
    ADD COLUMN IF NOT EXISTS metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS from_email  TEXT,
    ADD COLUMN IF NOT EXISTS from_name   TEXT;

-- Existing rows that were sends-with-attachment from the template flow
-- already carry the right `kind`/`source` defaults. New rows from other
-- subsystems will set these explicitly.

CREATE INDEX IF NOT EXISTS email_sends_kind_idx
    ON email_sends(org_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS email_sends_status_idx
    ON email_sends(org_id, status, created_at DESC);

-- Recipients live in TEXT[] which postgres can already GIN-index, but
-- the realistic super-admin search is "show me sends to this address"
-- across the whole platform — single index helps that lookup.
CREATE INDEX IF NOT EXISTS email_sends_recipients_gin_idx
    ON email_sends USING GIN (recipients);
