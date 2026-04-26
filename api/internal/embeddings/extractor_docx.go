package embeddings

// DOCX → text extraction.
//
// Implementation strategy: a .docx file is a ZIP archive whose
// `word/document.xml` part holds the visible text inside <w:t>
// elements. We don't need a third-party library — stdlib `archive/zip`
// + `encoding/xml` is sufficient and avoids adding a CGO/large-vendor
// dependency for what is, structurally, a glorified XML parse.
//
// What this extractor does NOT do:
//   - render headers/footers (they live in `word/header*.xml` /
//     `word/footer*.xml`); for summary purposes the body is enough
//   - preserve table layout (we concat cell text with newlines so the
//     LLM sees rows but not the grid)
//   - extract embedded images / shape text
//   - parse legacy .doc (binary CFB format — different beast; the
//     dispatcher skips that MIME entirely)
//
// These limitations are deliberate: an LLM tolerates plain-text-ish
// input fine, and the cost of a richer parser (vendoring 100KLOC of
// Office XML schema) isn't worth it for a "summarize the document"
// use case.

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"
)

// DOCXTextExtractor returns the plain text of a Word document. Returns
// "" + nil for non-DOCX mimes so it composes cleanly with the other
// extractors in DispatchExtractor.
//
// The function honours ctx.Err() between zip entries — DOCX files can
// be ~100MB and contain thousands of parts, so we don't want to pin a
// request after the HTTP timeout has fired.
func DOCXTextExtractor(ctx context.Context, mime string, body []byte) (string, error) {
	if !looksDOCX(mime) {
		return "", nil
	}
	if len(body) == 0 {
		return "", nil
	}

	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		return "", fmt.Errorf("docx open: %w", err)
	}

	// We concatenate body + table parts in document order. document.xml
	// is mandatory; everything else is best-effort. Returning early on
	// the first hit means a malformed package with extra `word/document
	// .xml` siblings still produces text rather than a 502.
	var doc *zip.File
	for _, f := range zr.File {
		if f.Name == "word/document.xml" {
			doc = f
			break
		}
	}
	if doc == nil {
		// Not actually a Word doc package (could be a renamed zip).
		// Treat as not-textual rather than failing — the handler maps
		// the empty string to 415 not_textual, which is a clearer UX
		// than a generic 500.
		return "", nil
	}

	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	rc, err := doc.Open()
	if err != nil {
		return "", fmt.Errorf("docx entry: %w", err)
	}
	defer rc.Close()

	// Cap the XML we'll parse. Even an 8MB DOCX can decompress to
	// >100MB of XML; we prefer to clip and let docchat's MaxPromptChars
	// truncate the result over OOM-ing the API process.
	const maxXML = 32 * 1024 * 1024 // 32MB decompressed
	limited := io.LimitReader(rc, maxXML)
	raw, err := io.ReadAll(limited)
	if err != nil {
		return "", fmt.Errorf("docx read: %w", err)
	}

	text, err := extractDOCXBody(raw)
	if err != nil {
		return "", fmt.Errorf("docx parse: %w", err)
	}
	if !utf8.ValidString(text) {
		text = strings.ToValidUTF8(text, "")
	}
	if strings.TrimSpace(text) == "" {
		return "", nil
	}
	return text, nil
}

// extractDOCXBody pulls the text of every <w:t> element, inserting a
// newline at <w:p> boundaries (paragraph) and a tab at <w:tab> /
// table-cell boundaries (so an LLM sees the document's gross structure
// without us having to model the full schema).
//
// Token-level streaming via xml.Decoder rather than xml.Unmarshal
// because Office XML is deeply nested (a real-world doc nests 20+
// levels: body→p→r→t plus inline drawings) and Unmarshal's reflection
// cost on that shape is substantial. The streaming approach is also
// resilient to schema drift — we only care about a handful of element
// names.
func extractDOCXBody(raw []byte) (string, error) {
	dec := xml.NewDecoder(bytes.NewReader(raw))
	// DOCX namespaces aren't always declared on the root in odd-but-
	// valid documents; instructing the decoder to be lenient about
	// unknown charsets/entities keeps us from rejecting otherwise-fine
	// files.
	dec.Strict = false

	var b strings.Builder
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			// Partial documents: return what we got rather than 502.
			// The model can still summarise a partial — and a strict
			// reject for a single malformed run would be surprising.
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			// Match by local name only — DOCX uses a `w:` prefix in
			// practice, but other tools emit unprefixed or different
			// prefixes for the same namespace.
			switch t.Name.Local {
			case "t":
				// <w:t> wraps the actual visible glyphs.
				var s string
				if err := dec.DecodeElement(&s, &t); err == nil {
					b.WriteString(s)
				}
			case "tab":
				b.WriteByte('\t')
			case "br":
				b.WriteByte('\n')
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "p":
				// Paragraph end → newline.
				b.WriteByte('\n')
			case "tc":
				// Table cell end → tab so successive cells don't run
				// together. Trailing tab on the last cell is harmless.
				b.WriteByte('\t')
			case "tr":
				// Table row end → newline.
				b.WriteByte('\n')
			}
		}
	}
	return b.String(), nil
}

// looksDOCX matches the modern Office Open XML wordprocessing MIME and
// the few legacy/aliased forms we've seen in the wild. We deliberately
// do NOT match `application/msword` here — that's the binary .doc
// format, which needs a different parser (libreoffice headless or
// dedicated CFB library). Falling through to "" + nil means the
// dispatcher returns 415 not_textual for .doc, with a clear error
// message rather than a parser crash.
func looksDOCX(mime string) bool {
	mime = strings.ToLower(strings.TrimSpace(mime))
	switch mime {
	case "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.ms-word.document.macroenabled.12",
		"application/vnd.ms-word.document.macroenabled":
		return true
	}
	return false
}
