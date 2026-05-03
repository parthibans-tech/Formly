-- 054_paddleocr_swap.sql
--
-- The OCR backend changed from tesseract (subprocess) to PaddleOCR
-- (HTTP sidecar). This migration brings the `ocr_profiles` table in
-- line with the new backend's vocabulary:
--
--   1. Translate `lang` values from tesseract three-letter ISO 639-2
--      codes (eng/hin/tam/...) to PaddleOCR two-letter codes
--      (en/hi/ta/...). The sidecar accepts both via an alias map, but
--      storing the canonical form makes the admin UI's lang dropdown
--      consistent and prevents drift if the alias map ever shrinks.
--
--   2. Reset `psm` to -1 ("no override"). PaddleOCR auto-detects
--      layout — there's no equivalent of tesseract's page-segmentation
--      mode — so any non-default value is dead data that the admin UI
--      would otherwise still surface in the editor. We deliberately
--      keep the column itself for source/DB compatibility (the Profile
--      struct still has the field; dropping the column would force a
--      cross-cutting rename).
--
-- Idempotent: re-running translates already-translated rows to
-- themselves and resets already-reset PSMs to -1. Safe to run twice.

-- ----- 1. Translate built-in Aadhaar lang -----------------------------
-- The Aadhaar profile was the only built-in that set Lang explicitly
-- (migration 048 set it to "eng+tam+hin" so tesseract loaded the right
-- script packs). PaddleOCR uses the two-letter codes, joined the same
-- way for backwards compat with the sidecar's alias path. The other
-- built-ins all have lang='' (inherit operator default) and stay that
-- way.
UPDATE ocr_profiles
SET lang = 'en+hi+ta'
WHERE slug = 'aadhaar'
  AND org_id IS NULL
  AND lang IN ('eng+tam+hin', 'eng+hin+tam', 'eng+tam', 'eng+hin');

-- ----- 2. Translate any org-authored profile that uses legacy codes ---
-- Generic find-and-replace: any "eng/hin/tam/ben/tel/kan/mal/fra/deu/
-- spa/jpn/kor/chi_sim/chi_tra" sequence inside a `lang` value becomes
-- the PaddleOCR equivalent. Multi-language strings ("eng+hin") get
-- both halves translated.
--
-- This uses regexp_replace 'g' flag so a single column value with two
-- legacy codes ("eng+hin") is fully translated in one pass.
UPDATE ocr_profiles
SET lang = regexp_replace(
        regexp_replace(
        regexp_replace(
        regexp_replace(
        regexp_replace(
        regexp_replace(
        regexp_replace(
        regexp_replace(
        regexp_replace(
        regexp_replace(
        regexp_replace(
        regexp_replace(
        regexp_replace(
        regexp_replace(lang,
            '\meng\M', 'en', 'g'),
            '\mhin\M', 'hi', 'g'),
            '\mtam\M', 'ta', 'g'),
            '\mben\M', 'bn', 'g'),
            '\mtel\M', 'te', 'g'),
            '\mkan\M', 'kn', 'g'),
            '\mmal\M', 'ml', 'g'),
            '\mfra\M', 'fr', 'g'),
            '\mdeu\M', 'german', 'g'),
            '\mspa\M', 'es', 'g'),
            '\mjpn\M', 'japan', 'g'),
            '\mkor\M', 'korean', 'g'),
            '\mchi_sim\M', 'ch', 'g'),
            '\mchi_tra\M', 'chinese_cht', 'g')
WHERE lang IS NOT NULL
  AND lang <> ''
  -- only touch rows that actually contain a legacy code, so the
  -- migration is observable in pg_stat_user_tables
  AND lang ~ '\m(eng|hin|tam|ben|tel|kan|mal|fra|deu|spa|jpn|kor|chi_sim|chi_tra)\M';

-- ----- 3. Drop dead PSM values ----------------------------------------
-- Reset every row where someone had picked a tesseract-specific PSM.
-- -1 is the sentinel for "no override" the Go side already understands.
UPDATE ocr_profiles
SET psm = -1
WHERE psm <> -1;
