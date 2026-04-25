-- Office-document preview pipeline. When a user uploads a Word/RTF/ODT
-- file, the worker converts it to PDF (via LibreOffice headless) and
-- stores the result as a new row. The original keeps the user's
-- bytes; `preview_pdf_id` points at the converted child so previews,
-- searches, and AcroForm-style designers can use the PDF without
-- re-converting on every request.
--
-- convert_status drives the chip in the UI:
--   'pending'      — job queued or in-flight, show a spinner
--   'ready'        — preview_pdf_id is set, link to PDF
--   'failed'       — conversion errored, show "preview unavailable"
--   'unsupported'  — soffice can't read this format (e.g. .pages)
--   'macro_warning'— DOCM/DOTM converted with macros stripped
--
-- Files for which conversion is N/A (PDF, image, etc.) leave the
-- column NULL — that's the "no preview needed" signal.
ALTER TABLE files
    ADD COLUMN IF NOT EXISTS preview_pdf_id   uuid REFERENCES files(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS convert_status   text,
    ADD COLUMN IF NOT EXISTS convert_warning  text;

CREATE INDEX IF NOT EXISTS idx_files_convert_pending
    ON files(org_id) WHERE convert_status = 'pending';
