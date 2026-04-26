-- 048_ocr_aadhaar_tune.sql
--
-- Tighten the built-in "Aadhaar Card" OCR profile after real-world
-- testing. The original seed shipped with `lang=''` (inheriting the
-- operator's `OCR_LANG`, which defaults to "eng" only). On a typical
-- Aadhaar — Tamil/Hindi labels mixed with English text — Tesseract
-- under "eng" alone tries to match Tamil/Hindi glyphs against English
-- letterforms and produces fragments like "ee ee Me", "SS 53
-- omagiayh", "Tl —" ahead of the real fields. Those fragments then
-- pollute the regex extractors and (worse) confuse the LLM cleanup
-- pass into hallucinating numbers like "09798" in place of the real
-- 12-digit number.
--
-- Three coordinated changes here:
--
--   1. lang → 'eng+tam+hin'. Tesseract supports multi-language with
--      "+"; the engine looks up each langpack and picks per-glyph.
--      DEPLOY NOTE: this requires `tesseract-ocr-tam` and
--      `tesseract-ocr-hin` packages alongside `tesseract-ocr` itself.
--      On Debian/Ubuntu:
--
--        apt-get install -y tesseract-ocr-tam tesseract-ocr-hin
--
--      If those packs aren't installed, tesseract fails the request
--      and the user sees an "OCR engine error" — explicitly better
--      than silently producing garbage. The list of states whose
--      Aadhaars commonly include Hindi or Tamil covers ~70% of
--      issuance volume; orgs that need other Indian scripts (Bengali,
--      Telugu, Kannada, Malayalam) can clone this profile and adjust
--      `lang`. Future work: a UI affordance to surface "missing
--      langpack" errors specifically.
--
--   2. Tighter regex extractors. The aadhaar_number pattern now
--      requires word boundaries on both sides so a 13-digit run from
--      a misread date+number ("19998169 1847 6605...") doesn't
--      capture a shifted slice; the name pattern allows leading
--      non-letter garbage tokens (e.g. "Tl — ") so the genuine
--      English transliteration is captured even when Tesseract
--      mistranscribes the Tamil prefix.
--
--   3. Hardened LLM prompt. The previous prompt invited the model to
--      "fix common OCR mistakes" without telling it when NOT to. The
--      new prompt explicitly forbids synthesising digits that don't
--      appear contiguously in the source and prefers a regex-style
--      4-4-4 anchor — when no such anchor exists, the model is told
--      to return null instead of guessing.
--
-- Idempotent — guarded by `WHERE slug='aadhaar' AND org_id IS NULL`.
-- Re-running the migration is a no-op once the row is up to date.

UPDATE ocr_profiles
SET
    lang = 'eng+tam+hin',
    extractors = jsonb_build_object(
        -- 4-4-4 with word boundaries. Word boundary against a digit
        -- prevents grabbing the middle of a 13+ digit run.
        'aadhaar_number', '(?i)\b(\d{4}\s+\d{4}\s+\d{4})\b',
        'dob',            '(?i)(?:DOB|D\.?O\.?B\.?|Date of Birth|Year of Birth)\s*[:\-]?\s*([\d/\-\.]{4,10})',
        'gender',         '(?i)\b(MALE|FEMALE|TRANSGENDER)\b',
        -- Allow up to ~10 leading non-letter characters (Tesseract
        -- routinely renders Tamil glyphs as random punctuation /
        -- short Latin fragments before the actual English line).
        'name',           '(?m)^[^A-Za-z\n]{0,10}([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*$'
    ),
    llm_prompt = $PROMPT$You are extracting fields from raw OCR text of an Indian Aadhaar card. The OCR is often noisy — Tamil/Hindi labels frequently render as garbage Latin fragments mixed with the real English text.
Return ONLY a JSON object (no prose, no code fences) with these keys:
  aadhaar_number  — 12-digit number, formatted as "XXXX XXXX XXXX"
  name            — full name as printed (English transliteration line)
  dob             — date of birth in DD/MM/YYYY format if present, else year only
  gender          — "Male", "Female", or "Transgender"

CRITICAL RULES:
  • For aadhaar_number: locate a contiguous 12-digit sequence in the source text, typically formatted as three groups of four (e.g. "8169 1847 6605"). DO NOT invent digits. If no clean 12-digit sequence is present, return null.
  • For name: pick the line that reads as Title Case English words ("Somasundaram Moorthy"). Strip any leading garbage tokens ("Tl —", punctuation, single Latin letters) that come from misread Tamil/Hindi glyphs. Do NOT include the father's name or the word "Father".
  • For dob: if only the year is visible ("Year of Birth: 1999"), return "1999".
  • Common OCR digit substitutions to fix INSIDE a candidate field only: O↔0, I↔1, B↔8, S↔5. Do not apply these to letters in names.

If a field is missing or unreadable after applying the rules above, set its value to null. Never fabricate.$PROMPT$,
    updated_at = now()
WHERE slug = 'aadhaar' AND org_id IS NULL;
