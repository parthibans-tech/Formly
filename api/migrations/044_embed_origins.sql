-- 044_embed_origins.sql
--
-- Per-org embed-origin allowlist.
--
-- Background: the SPA hardening pass added a strict default
-- Content-Security-Policy on the entire web app, including
-- `frame-ancestors 'self'` on the public embed surfaces (form-fill /
-- share / review pages). That matches the pre-existing
-- `X-Frame-Options: SAMEORIGIN` and stops a malicious site from
-- iframe-embedding a customer's branded form to phish the customer's
-- own users.
--
-- BUT the product is a white-label form/document-generation API —
-- legitimate customers WILL want to embed `/form/<token>` on their
-- own marketing site, and `/share/<token>` inside their own portal.
-- A blanket SAMEORIGIN block makes that impossible.
--
-- The fix is a per-org allowlist of origins (scheme + host + optional
-- port; one entry per allowed embedder). At request time the API and
-- the Next.js middleware merge this list into the response's
-- frame-ancestors directive. Empty = locked down (today's behaviour);
-- populated = those origins, plus 'self', may iframe the embed
-- routes.
--
-- Layered like the rest of upload-policy:
--   product_config.embed_allowed_origins   — platform-level default
--                                             (almost always '{}'; we
--                                             don't want to ship a
--                                             cross-tenant default).
--   org_upload_config.embed_allowed_origins — per-org override.
--                                              NULL = inherit; '{}' =
--                                              explicit lock-down;
--                                              populated = replace.
--
-- Stored as text[] of canonical origin strings ("https://customer.com"
-- — no path, no trailing slash). The API normalises and validates on
-- write so a typo'd "customer.com" (no scheme) doesn't slip into a
-- live frame-ancestors directive and silently fail.

ALTER TABLE product_config
    ADD COLUMN IF NOT EXISTS embed_allowed_origins text[] NOT NULL DEFAULT '{}';

ALTER TABLE org_upload_config
    ADD COLUMN IF NOT EXISTS embed_allowed_origins text[];
