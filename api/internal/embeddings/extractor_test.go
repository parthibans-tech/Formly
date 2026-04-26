package embeddings

// Tests cover the dispatcher routing + DOCX extractor end-to-end. PDF
// extraction is exercised only at the dispatcher level (we don't ship
// a fixture PDF) — its routing logic is what's most likely to regress
// when adding new MIMEs, and the underlying ledongthuc/pdf has its own
// test suite upstream.

import (
	"archive/zip"
	"bytes"
	"context"
	"strings"
	"testing"
)

// makeDOCX builds a minimal valid Office Open XML wordprocessing
// package containing the supplied paragraphs. Real Word documents
// carry many more parts (styles, fonts, theme, _rels) but a parser
// that only walks `word/document.xml` doesn't care — keeping the
// fixture this small makes the test self-contained.
func makeDOCX(t *testing.T, paragraphs ...string) []byte {
	t.Helper()
	var b bytes.Buffer
	zw := zip.NewWriter(&b)
	w, err := zw.Create("word/document.xml")
	if err != nil {
		t.Fatalf("zip create: %v", err)
	}
	var doc strings.Builder
	doc.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	doc.WriteString(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`)
	doc.WriteString(`<w:body>`)
	for _, p := range paragraphs {
		doc.WriteString(`<w:p><w:r><w:t>`)
		doc.WriteString(p)
		doc.WriteString(`</w:t></w:r></w:p>`)
	}
	doc.WriteString(`</w:body></w:document>`)
	if _, err := w.Write([]byte(doc.String())); err != nil {
		t.Fatalf("zip write: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return b.Bytes()
}

func TestDOCXTextExtractor_HappyPath(t *testing.T) {
	body := makeDOCX(t, "Hello world.", "Second paragraph here.")
	got, err := DOCXTextExtractor(context.Background(),
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		body)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(got, "Hello world.") || !strings.Contains(got, "Second paragraph here.") {
		t.Fatalf("missing paragraph text in extracted output: %q", got)
	}
	// Paragraph end should produce a newline so the model sees the
	// boundary — bug-fence against a regression that runs paragraphs
	// together.
	if !strings.Contains(got, "Hello world.\n") {
		t.Errorf("expected newline after paragraph, got %q", got)
	}
}

func TestDOCXTextExtractor_WrongMIME(t *testing.T) {
	body := makeDOCX(t, "should not be read")
	got, err := DOCXTextExtractor(context.Background(), "text/plain", body)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "" {
		t.Errorf("expected empty string for non-DOCX mime, got %q", got)
	}
}

func TestDOCXTextExtractor_NotAZip(t *testing.T) {
	got, err := DOCXTextExtractor(context.Background(),
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		[]byte("not a zip"))
	// Garbage bytes fail the zip header check — we surface this as an
	// error, not a silent ""; the docchat handler will then 502 with a
	// useful message rather than 415.
	if err == nil {
		t.Fatalf("expected error for non-zip body, got %q", got)
	}
}

func TestDOCXTextExtractor_ZipWithoutDocumentXML(t *testing.T) {
	// A valid zip that isn't a DOCX (no word/document.xml part) should
	// fall through as not-textual rather than erroring.
	var b bytes.Buffer
	zw := zip.NewWriter(&b)
	w, _ := zw.Create("readme.txt")
	_, _ = w.Write([]byte("not a docx"))
	_ = zw.Close()

	got, err := DOCXTextExtractor(context.Background(),
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		b.Bytes())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "" {
		t.Errorf("expected empty for zip-without-document.xml, got %q", got)
	}
}

func TestDispatchExtractor_Routing(t *testing.T) {
	ctx := context.Background()
	docx := makeDOCX(t, "From DOCX")

	cases := []struct {
		name      string
		mime      string
		body      []byte
		wantSub   string // substring expected in result
		wantEmpty bool   // result should be ""
	}{
		{"text/plain → PlainText",
			"text/plain", []byte("hello text"), "hello text", false},
		{"application/json → PlainText",
			"application/json", []byte(`{"k":"v"}`), `"k":"v"`, false},
		{"DOCX MIME → DOCXText",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			docx, "From DOCX", false},
		{"image/png → empty (not textual)",
			"image/png", []byte{0x89, 0x50, 0x4e, 0x47}, "", true},
		{"application/msword (legacy .doc) → empty",
			// Important: .doc is binary CFB, not zip+xml. The dispatcher
			// must NOT route it to DOCXTextExtractor.
			"application/msword", []byte{0xd0, 0xcf, 0x11, 0xe0}, "", true},
		{"empty MIME → empty",
			"", []byte("anything"), "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := DispatchExtractor(ctx, tc.mime, tc.body)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantEmpty {
				if got != "" {
					t.Errorf("want empty, got %q", got)
				}
				return
			}
			if !strings.Contains(got, tc.wantSub) {
				t.Errorf("want substring %q in result, got %q", tc.wantSub, got)
			}
		})
	}
}

func TestLooksPDF(t *testing.T) {
	yes := []string{"application/pdf", "Application/PDF", "  application/pdf  ",
		"application/x-pdf", "text/pdf"}
	no := []string{"application/zip", "image/png", "",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
	for _, m := range yes {
		if !looksPDF(m) {
			t.Errorf("looksPDF(%q) = false, want true", m)
		}
	}
	for _, m := range no {
		if looksPDF(m) {
			t.Errorf("looksPDF(%q) = true, want false", m)
		}
	}
}

func TestLooksDOCX(t *testing.T) {
	yes := []string{
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"APPLICATION/VND.OPENXMLFORMATS-OFFICEDOCUMENT.WORDPROCESSINGML.DOCUMENT",
	}
	no := []string{
		"application/msword", // legacy .doc — binary, not OOXML
		"application/pdf",
		"text/plain",
		"",
	}
	for _, m := range yes {
		if !looksDOCX(m) {
			t.Errorf("looksDOCX(%q) = false, want true", m)
		}
	}
	for _, m := range no {
		if looksDOCX(m) {
			t.Errorf("looksDOCX(%q) = true, want false", m)
		}
	}
}
