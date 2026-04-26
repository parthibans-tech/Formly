-- 047_ocr_profiles.sql
--
-- "Document type" presets for the Extract Text picker. Each profile
-- bundles tesseract knobs (PSM, language, preprocess), regex
-- extractors (field_key → pattern), and an optional LLM cleanup
-- prompt. Users pick one when extracting and the backend applies the
-- bundle: per-profile OCR config + structured field extraction +
-- optional LLM-cleaned summary.
--
-- # Why two scopes
--
-- A profile can be either:
--   * Platform-shipped (org_id IS NULL, is_builtin=true) — Aadhaar,
--     PAN, Receipt, etc. Editable only by super admins. Visible to
--     every org.
--   * Org-authored    (org_id = <org>, is_builtin=false) — created
--     by an org admin for their own workflow ("Vendor X invoice",
--     "Internal HR form"). Visible only inside that org.
--
-- The list endpoint UNION-merges both, so a user sees built-ins
-- followed by their org's profiles.
--
-- # Why no UNIQUE (org_id, slug)
--
-- Postgres treats NULL ≠ NULL in unique constraints, so a single
-- `UNIQUE (org_id, slug)` would let the platform have multiple rows
-- with the same slug + NULL org. We need two partial-unique indexes:
-- one for built-ins (slug unique among NULL-org rows) and one for
-- org-authored (slug unique within each org).
--
-- # JSONB columns
--
-- `fields` is a JSON array of field-key strings (display order).
-- `extractors` is a JSON object: {field_key: regex_string}. We store
-- the raw regex source — compilation happens at request time in the
-- Go package, so the validation error surface is "this regex didn't
-- compile" at PUT time rather than at every OCR call.

CREATE TABLE IF NOT EXISTS ocr_profiles (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL for platform built-ins. FK to organizations so an org
    -- delete cascades the profiles it authored — no orphan rows.
    org_id       uuid        REFERENCES organizations(id) ON DELETE CASCADE,
    -- Stable identifier (URL/cache key). The frontend persists the
    -- last-picked slug in localStorage; mutating an existing slug
    -- would silently change what users get.
    slug         text        NOT NULL,
    name         text        NOT NULL,
    description  text        NOT NULL DEFAULT '',
    -- Lucide icon name, used by the picker UI. Falls back to a
    -- generic document icon when the frontend doesn't recognize it.
    icon         text        NOT NULL DEFAULT 'file-text',
    -- Tesseract -l value. Empty = inherit operator's OCR_LANG.
    lang         text        NOT NULL DEFAULT '',
    -- Tesseract --psm. -1 = inherit operator default. We deliberately
    -- store the sentinel rather than NULL so the Go side doesn't
    -- need a tri-state (zero/null/value).
    psm          int         NOT NULL DEFAULT -1,
    -- Override imagemagick preprocessing pass. NULL = inherit. Most
    -- profiles want the default; we expose this for the rare case
    -- where deskew is wrong (already-rectified scans).
    preprocess   boolean,
    -- Display order for the result table. ["aadhaar_number","name","dob"]
    fields       jsonb       NOT NULL DEFAULT '[]'::jsonb,
    -- Regex extractors. Each value is a Go regex; the first capture
    -- group is the value the UI shows.
    extractors   jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- System prompt sent to the chat model for cleanup. Empty = no
    -- LLM cleanup pass. Keep this short — the frontend renders it
    -- in a textarea and overly long prompts blow context budget.
    llm_prompt   text        NOT NULL DEFAULT '',
    -- Built-in marker. Only super admins can flip / mutate these
    -- rows; org admins cannot delete a built-in (they'd be removing
    -- a profile every other org also sees).
    is_builtin   boolean     NOT NULL DEFAULT false,
    created_by   uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Built-in slugs are unique platform-wide.
CREATE UNIQUE INDEX IF NOT EXISTS ocr_profiles_builtin_slug_idx
    ON ocr_profiles (slug) WHERE org_id IS NULL;

-- Org-authored slugs are unique within each org. Two different orgs
-- can both have a "vendor-x" slug and they don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS ocr_profiles_org_slug_idx
    ON ocr_profiles (org_id, slug) WHERE org_id IS NOT NULL;

-- Index for the list endpoint's "WHERE org_id IS NULL OR org_id = $1"
-- query. The partial UNIQUE indexes above don't cover this query
-- shape (they index slug, not org_id alone) so we add an explicit
-- non-unique one.
CREATE INDEX IF NOT EXISTS ocr_profiles_org_idx
    ON ocr_profiles (org_id);

-- ----------------------------------------------------------------------
-- Seed the 6 built-in profiles. These mirror the hardcoded specs that
-- shipped in the previous MVP — keeping behaviour identical for users
-- already relying on them. Each one is INSERTed only if the slug
-- doesn't exist yet, so re-running this migration is a no-op.
-- ----------------------------------------------------------------------

INSERT INTO ocr_profiles (slug, name, description, icon, psm, fields, extractors, llm_prompt, is_builtin)
VALUES (
    'generic',
    'Generic Document',
    'Default OCR. Use for arbitrary scans, screenshots, and any document type not listed below.',
    'file-text',
    -1,
    '[]'::jsonb,
    '{}'::jsonb,
    '',
    true
) ON CONFLICT DO NOTHING;

INSERT INTO ocr_profiles (slug, name, description, icon, psm, preprocess, fields, extractors, llm_prompt, is_builtin)
VALUES (
    'aadhaar',
    'Aadhaar Card',
    'Indian Aadhaar — front or back. Tuned for the 12-digit number, name, DOB, gender.',
    'id-card',
    6,
    true,
    '["aadhaar_number","name","dob","gender"]'::jsonb,
    jsonb_build_object(
        'aadhaar_number', '(?i)(\d{4}\s*\d{4}\s*\d{4})',
        'dob',            '(?i)(?:DOB|D\.?O\.?B\.?|Date of Birth|Year of Birth)\s*[:\-]?\s*([\d/\-\.]{4,10})',
        'gender',         '(?i)\b(MALE|FEMALE|TRANSGENDER)\b',
        'name',           '(?m)^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){1,3})\s*$'
    ),
    'You are extracting fields from raw OCR text of an Indian Aadhaar card.
Return ONLY a JSON object (no prose, no code fences) with these keys:
  aadhaar_number  — 12-digit number, formatted as "XXXX XXXX XXXX"
  name            — full name as printed
  dob             — date of birth in DD/MM/YYYY format
  gender          — "Male", "Female", or "Transgender"
If a field is missing or unreadable, set its value to null.
Common OCR mistakes to fix: O↔0, I↔1, B↔8, S↔5 inside digit fields. Names should keep their original capitalisation.',
    true
) ON CONFLICT DO NOTHING;

INSERT INTO ocr_profiles (slug, name, description, icon, psm, preprocess, fields, extractors, llm_prompt, is_builtin)
VALUES (
    'pan',
    'PAN Card',
    'Indian PAN card. Tuned for the 10-character PAN, name, father''s name, DOB.',
    'credit-card',
    6,
    true,
    '["pan","name","father_name","dob"]'::jsonb,
    jsonb_build_object(
        'pan',         '(?i)\b([A-Z]{5}\s*[0-9]{4}\s*[A-Z])\b',
        'dob',         '(?i)(?:DOB|D\.?O\.?B\.?|Date of Birth)\s*[:\-]?\s*([\d/\-\.]{4,10})',
        'father_name', '(?im)Father''?s?\s*Name\s*[:\-]?\s*([A-Z][A-Za-z\s]+)',
        'name',        '(?im)^Name\s*[:\-]?\s*([A-Z][A-Za-z\s]+)'
    ),
    'You are extracting fields from raw OCR text of an Indian PAN card.
Return ONLY a JSON object (no prose, no code fences) with these keys:
  pan         — 10-character PAN, all uppercase, no spaces (e.g. "ABCDE1234F")
  name        — cardholder''s full name as printed
  father_name — father''s name as printed
  dob         — date of birth in DD/MM/YYYY format
If a field is missing or unreadable, set its value to null.
The PAN format is exactly 5 letters + 4 digits + 1 letter — fix obvious OCR mistakes (O↔0, I↔1, B↔8) inside the PAN to make it match this pattern.',
    true
) ON CONFLICT DO NOTHING;

INSERT INTO ocr_profiles (slug, name, description, icon, psm, preprocess, fields, extractors, llm_prompt, is_builtin)
VALUES (
    'dl',
    'Driving License',
    'Indian driving license. Tuned for DL number, name, DOB, validity.',
    'car',
    6,
    true,
    '["dl_number","name","dob","valid_till"]'::jsonb,
    jsonb_build_object(
        'dl_number',  '(?i)\b([A-Z]{2}[\s\-]?\d{2}[\s\-]?\d{4}[\s\-]?\d{6,7})\b',
        'dob',        '(?i)(?:DOB|D\.?O\.?B\.?|Date of Birth)\s*[:\-]?\s*([\d/\-\.]{4,10})',
        'valid_till', '(?i)(?:Valid\s*(?:Till|Upto|Until)|Expir[ye]\s*Date)\s*[:\-]?\s*([\d/\-\.]{4,10})',
        'name',       '(?im)^Name\s*[:\-]?\s*([A-Z][A-Za-z\s]+)'
    ),
    'You are extracting fields from raw OCR text of an Indian driving license.
Return ONLY a JSON object (no prose, no code fences) with these keys:
  dl_number   — driving license number
  name        — full name as printed
  dob         — date of birth in DD/MM/YYYY format
  valid_till  — expiry date in DD/MM/YYYY format
If a field is missing or unreadable, set its value to null.
Fix obvious OCR mistakes (O↔0, I↔1, B↔8) inside the DL number.',
    true
) ON CONFLICT DO NOTHING;

INSERT INTO ocr_profiles (slug, name, description, icon, psm, preprocess, fields, extractors, llm_prompt, is_builtin)
VALUES (
    'passport',
    'Passport',
    'Passport bio page. Tuned for passport number, name, nationality, DOB, expiry.',
    'book-marked',
    6,
    true,
    '["passport_number","surname","given_names","nationality","dob","expiry"]'::jsonb,
    jsonb_build_object(
        'passport_number', '(?i)\b([A-Z][0-9]{7,8})\b',
        'dob',             '(?i)(?:DOB|Date of Birth)\s*[:\-]?\s*([\d/\-\.]{4,10})',
        'expiry',          '(?i)(?:Date of Expir[ye]|Valid\s*Until)\s*[:\-]?\s*([\d/\-\.]{4,10})',
        'surname',         '(?im)^Surname\s*[:\-]?\s*([A-Z][A-Za-z\s]+)',
        'given_names',     '(?im)Given\s*Names?\s*[:\-]?\s*([A-Z][A-Za-z\s]+)',
        'nationality',     '(?im)Nationality\s*[:\-]?\s*([A-Z][A-Za-z\s]+)'
    ),
    'You are extracting fields from raw OCR text of a passport bio page.
Return ONLY a JSON object (no prose, no code fences) with these keys:
  passport_number — passport number, all uppercase, no spaces
  surname         — surname as printed
  given_names     — given names as printed
  nationality     — nationality as printed
  dob             — date of birth in DD/MM/YYYY format
  expiry          — date of expiry in DD/MM/YYYY format
If a field is missing or unreadable, set its value to null.
Fix obvious OCR mistakes (O↔0, I↔1, B↔8, Z↔2) inside the passport number.',
    true
) ON CONFLICT DO NOTHING;

INSERT INTO ocr_profiles (slug, name, description, icon, psm, preprocess, fields, extractors, llm_prompt, is_builtin)
VALUES (
    'receipt',
    'Receipt / Invoice',
    'Printed receipts and invoices. Tuned for vendor, total, date, GST/tax amounts.',
    'receipt',
    6,
    true,
    '["vendor","date","total","tax","invoice_number"]'::jsonb,
    jsonb_build_object(
        'total',          '(?i)(?:Grand\s*Total|TOTAL|Amount\s*Due|Net\s*Payable)\s*[:\-]?\s*[₹$€£]?\s*([\d,]+\.?\d*)',
        'tax',            '(?i)(?:GST|Tax|VAT|CGST|SGST|IGST)\s*[:\-]?\s*[₹$€£]?\s*([\d,]+\.?\d*)',
        'date',           '(?i)(?:Date|Invoice\s*Date|Bill\s*Date)\s*[:\-]?\s*([\d/\-\.]{4,10})',
        'invoice_number', '(?i)(?:Invoice\s*(?:No|Number|#)|Bill\s*No)\s*[:\-]?\s*([A-Z0-9\-/]+)',
        'vendor',         '(?m)^([A-Z][A-Za-z0-9&''.\s]{3,})$'
    ),
    'You are extracting fields from raw OCR text of a printed receipt or invoice.
Return ONLY a JSON object (no prose, no code fences) with these keys:
  vendor         — merchant or vendor name
  date           — invoice or bill date in DD/MM/YYYY format
  total          — total / grand total / amount due as a numeric string with two decimals (no currency symbol)
  tax            — total tax amount (GST/VAT/sales tax) as a numeric string with two decimals
  invoice_number — invoice or bill number as printed
If a field is missing or unreadable, set its value to null.
Numbers must use a period for decimals and no thousands separators.',
    true
) ON CONFLICT DO NOTHING;
