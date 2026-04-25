-- 043_pdf_hardening.sql
--
-- PDF-specific structural threat detection. The AV layer (ClamAV) is a
-- generic binary scanner; it doesn't know that /JavaScript, /Launch,
-- /EmbeddedFile, and external /Filespec entries inside a PDF are
-- "active content" the org may want to refuse outright. internal/pdfsec
-- handles that — these knobs gate it.
--
--   pdf_harden_enabled    — master toggle. When false, uploaded PDFs
--                            are passed through without structural
--                            inspection (existing behaviour).
--   pdf_blocked_features  — list of pdfsec.Threat constants the policy
--                            blocks on detection. Default mirrors
--                            pdfsec.DefaultBlockedFeatures: javascript,
--                            launch, embedded_file, external_xobject.
--                            Empty array = "scan but block nothing"
--                            (report-only mode); NULL on the org row =
--                            inherit from product.
--
-- Setting pdf_harden_enabled=true doesn't require ScanEnabled to be on —
-- the structural check runs synchronously inside files.Complete, so it
-- works in deployments without a ClamAV daemon wired up.

ALTER TABLE product_config
    ADD COLUMN IF NOT EXISTS pdf_harden_enabled boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS pdf_blocked_features text[] NOT NULL DEFAULT
        '{"javascript","launch","embedded_file","external_xobject"}';

ALTER TABLE org_upload_config
    ADD COLUMN IF NOT EXISTS pdf_harden_enabled boolean,
    ADD COLUMN IF NOT EXISTS pdf_blocked_features text[];
