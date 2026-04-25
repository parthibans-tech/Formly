-- 040_upload_policy.sql
--
-- Layered upload-policy configuration.
--
-- Two tables, two levels:
--
--   product_config       — singleton row, edited by super-admins only.
--                          Holds platform-wide defaults: every org inherits
--                          these unless it sets its own override.
--
--   org_upload_config    — per-org overrides. Every policy column is
--                          nullable; NULL means "inherit from product_config".
--                          Org admins can tighten or loosen on top of
--                          platform defaults (within whatever ceiling the
--                          super-admin marks as a hard cap, future work).
--
-- The runtime resolves the effective policy as
--   COALESCE(org.field, product.field)
-- per field. Cached in-process for a short TTL — see internal/uploadpolicy.
--
-- Why two tables, not a JSONB blob: each control gets its own column so
-- migrations are explicit, downgrades are scriptable, and the super-admin
-- UI can be generated from the schema rather than a hand-typed form.

-- ---------- product_config (singleton) ----------------------------------
CREATE TABLE IF NOT EXISTS product_config (
    id text PRIMARY KEY DEFAULT 'default',

    -- Hard ceiling on a single upload. Enforced both at presign time
    -- (server validates declaredSize) AND at storage time (MinIO POST
    -- policy with content-length-range refuses oversize blobs at the edge).
    max_upload_bytes bigint NOT NULL DEFAULT 104857600, -- 100 MiB

    -- MIME allowlist. Empty array = allow any. Stored as canonical
    -- "type/subtype" lowercased. Wildcards supported as "image/*".
    allowed_mime_types text[] NOT NULL DEFAULT '{}',

    -- Extension blocklist (always denied regardless of allowlist).
    -- Lowercase, dot-prefixed. The defaults cover the common script /
    -- executable / installer extensions that have no business in a
    -- doc-handling product.
    blocked_extensions text[] NOT NULL DEFAULT
        '{".exe",".bat",".cmd",".com",".scr",".vbs",".ps1",".js",".jse",".jar",".msi",".dll",".sh",".app",".dmg"}',

    -- When true, post-upload Complete handler reads the first 512 bytes,
    -- runs http.DetectContentType, and rejects (or quarantines) when the
    -- detected type contradicts the claimed MIME. Cheap, catches forged
    -- uploads (e.g. .exe renamed to .pdf).
    mime_sniff_enabled boolean NOT NULL DEFAULT true,

    -- Toggle for the AV worker. When true, Complete enqueues a scan and
    -- leaves the file in status='scanning' until the worker stamps it
    -- 'active' or 'quarantined'. Off by default until ClamAV is wired
    -- in; the flag exists so the policy schema is forward-compatible.
    scan_enabled boolean NOT NULL DEFAULT false,

    -- Filename hardening. Names longer than this are rejected; we don't
    -- silently truncate because that can cause collisions and surprise
    -- downstream consumers.
    max_filename_len int NOT NULL DEFAULT 255,

    -- When true, downloads of risky-render types (text/html, image/svg+xml,
    -- application/xhtml+xml, etc.) get Content-Disposition: attachment
    -- forced on the presigned GET response, blocking the stored-XSS
    -- vector. Inline previews use a different presign that opts out.
    force_attachment_for_risky boolean NOT NULL DEFAULT true,

    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,

    -- Lock the table to one row. The 'default' literal is the only
    -- allowed primary key, which makes UPSERT trivial and prevents
    -- accidental multi-row drift.
    CHECK (id = 'default')
);

INSERT INTO product_config (id) VALUES ('default') ON CONFLICT DO NOTHING;

-- ---------- org_upload_config (per-org overrides) -----------------------
CREATE TABLE IF NOT EXISTS org_upload_config (
    org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,

    -- Each column NULL = "inherit from product_config".
    max_upload_bytes           bigint,
    allowed_mime_types         text[],
    blocked_extensions         text[],
    mime_sniff_enabled         boolean,
    scan_enabled               boolean,
    max_filename_len           int,
    force_attachment_for_risky boolean,

    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

-- Audit-friendly: the policy resolver runs on the hot path of every
-- upload presign, so we want the row read to be a single PK lookup.
-- (No additional indexes needed — PRIMARY KEY covers the only access
-- pattern.)
