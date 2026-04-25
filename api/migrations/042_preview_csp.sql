-- 042_preview_csp.sql
--
-- CSP + iframe-sandbox knobs for the inline-preview path.
--
-- Background: an attacker who lands a stored XSS through the preview iframe
-- (HTML/SVG/anything renderable) historically had a clean shot at the
-- designer's same-origin context — there was no Content-Security-Policy on
-- the bytes the iframe loaded, and the frontend wasn't told to set a
-- `sandbox` attribute on the <iframe>. The download path is locked down
-- (always-attachment Content-Disposition + risky-mime override in
-- PresignGetInline), but a deliberate inline render bypasses both layers.
--
-- This adds two configurable knobs at the same product/org layered shape
-- as the rest of upload policy:
--
--   preview_csp             — the Content-Security-Policy header the API
--                              attaches when streaming inline previews.
--                              Default is maximally restrictive (no JS,
--                              no third-party fetches, sandboxed) so an
--                              attacker who slips an HTML/SVG past the
--                              MIME sniff still can't fire.
--
--   preview_iframe_sandbox  — the literal value the API tells the frontend
--                              to set on the <iframe sandbox="..."> for
--                              this org's previews. "" = full lockdown
--                              (no scripts, no forms, no same-origin),
--                              which is the default. Loosen by listing
--                              tokens like "allow-scripts allow-forms"
--                              only when an org explicitly accepts the
--                              risk (e.g. they upload trusted internal
--                              HTML mocks).
--
-- Both columns NULL on the org table = inherit from product, matching the
-- rest of the policy stack.

ALTER TABLE product_config
    ADD COLUMN IF NOT EXISTS preview_csp text NOT NULL DEFAULT
        'default-src ''none''; img-src ''self'' data: blob:; style-src ''unsafe-inline''; font-src ''self'' data:; sandbox',
    ADD COLUMN IF NOT EXISTS preview_iframe_sandbox text NOT NULL DEFAULT '';

ALTER TABLE org_upload_config
    ADD COLUMN IF NOT EXISTS preview_csp text,
    ADD COLUMN IF NOT EXISTS preview_iframe_sandbox text;
