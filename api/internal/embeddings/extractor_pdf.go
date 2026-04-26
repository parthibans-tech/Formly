package embeddings

// PDF → text extraction.
//
// Lives next to PlainTextExtractor so any caller wanting "give me the
// readable text of this blob, regardless of MIME" has a single seam to
// import. The actual byte-pushing is delegated to ledongthuc/pdf
// (already on go.mod for downstream uses); we wrap it with the
// ergonomics the rest of the codebase expects:
//
//   - bytes-in / string-out (the embedder + docchat already hold the
//     blob in memory; round-tripping to a temp file is unnecessary I/O)
//   - panic-safe (a malformed PDF can panic deep inside the parser —
//     we recover and surface an error rather than killing the handler)
//   - empty-string-on-MIME-mismatch (so a dispatcher can treat an
//     unhandled MIME identically whether it's PDF, DOCX, or unknown)
//
// We do NOT try to OCR scanned PDFs here. A PDF whose content streams
// are pure raster images will return an empty string + nil error, and
// the docchat handler then maps that to 415 not_textual. Adding
// tesseract/OCR is a separate, much larger scope.

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	pdfreader "github.com/ledongthuc/pdf"
)

// PDFTextExtractor pulls the textual content out of a PDF. Returns ""
// + nil for non-PDF mimes so it can be cleanly composed with other
// extractors in DispatchExtractor.
//
// The function honours ctx.Err() between pages — a malicious 10K-page
// PDF can take seconds to extract, and we don't want it pinning a
// request after the HTTP timeout has fired.
func PDFTextExtractor(ctx context.Context, mime string, body []byte) (out string, err error) {
	if !looksPDF(mime) {
		return "", nil
	}
	if len(body) == 0 {
		return "", nil
	}
	// ledongthuc/pdf parses lazily; some malformed inputs trip a panic
	// inside the lexer. The library is tested but not battle-hardened
	// against adversarial PDFs, so we wrap every call in a recover.
	defer func() {
		if r := recover(); r != nil {
			out = ""
			err = fmt.Errorf("pdf extract: panic: %v", r)
		}
	}()

	r, e := pdfreader.NewReader(bytes.NewReader(body), int64(len(body)))
	if e != nil {
		return "", fmt.Errorf("pdf open: %w", e)
	}

	// GetPlainText returns an io.Reader streaming page text concatenated
	// in document order. We Copy it through a builder rather than
	// preallocating a []byte sized to len(body) — extracted text is
	// usually 5–20% of the PDF's wire size, so a fixed cap blows
	// memory on very small docs.
	rd, e := r.GetPlainText()
	if e != nil {
		return "", fmt.Errorf("pdf extract: %w", e)
	}
	var buf bytes.Buffer
	if _, e := io.Copy(&buf, rd); e != nil {
		return "", fmt.Errorf("pdf read: %w", e)
	}
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	text := buf.String()
	// PDF text often contains hard-wrapped lines, ligature runs, and
	// stray control chars from font remapping. We don't try to fix
	// that here (an LLM tolerates it just fine); we only enforce UTF-8
	// validity so downstream truncation on rune boundary stays safe.
	if !utf8.ValidString(text) {
		text = strings.ToValidUTF8(text, "")
	}
	if strings.TrimSpace(text) == "" {
		// Likely a scanned/image-only PDF — caller handles this as
		// "not textual" the same way as a non-PDF mime.
		return "", nil
	}
	return text, nil
}

// looksPDF matches the small set of MIMEs that browsers / our upload
// sniffer assign to PDFs. We're permissive on the legacy
// "application/x-pdf" because some old MIME tables still emit it.
func looksPDF(mime string) bool {
	mime = strings.ToLower(strings.TrimSpace(mime))
	switch mime {
	case "application/pdf", "application/x-pdf",
		"application/acrobat", "applications/vnd.pdf",
		"text/pdf", "text/x-pdf":
		return true
	}
	return false
}

// DispatchExtractor returns an Extractor that picks the right concrete
// extractor by MIME — currently:
//
//	PDF (application/pdf, …)                       → PDFTextExtractor
//	DOCX (Office Open XML wordprocessing)          → DOCXTextExtractor
//	text/* + json/xml/yaml/script-ish              → PlainTextExtractor
//	everything else                                → "" (not textual)
//
// This is the extractor docchat uses (and the one new embeddings
// deployments should consider). The default Embedder still uses
// PlainTextExtractor — flipping that on globally would silently start
// indexing every PDF/DOCX in every drive on next worker run, which is
// a separate scope decision.
func DispatchExtractor(ctx context.Context, mime string, body []byte) (string, error) {
	switch {
	case looksPDF(mime):
		return PDFTextExtractor(ctx, mime, body)
	case looksDOCX(mime):
		return DOCXTextExtractor(ctx, mime, body)
	case looksTextual(mime):
		return PlainTextExtractor(ctx, mime, body)
	}
	// Neither — preserve the empty-string-on-unknown-mime contract so
	// the orchestrator can mark embed_status='skipped' instead of
	// 'failed'. docchat then maps the empty result to 415 not_textual.
	return "", nil
}
