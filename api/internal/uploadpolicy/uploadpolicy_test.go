package uploadpolicy

import (
	"strings"
	"testing"
)

// TestSanitizeFilename covers the cleanup the storage layer relies on:
// path-traversal stripping, control-char replacement, and the
// AbsMaxFilenameLen cap. The cap matters even when no per-org policy is
// wired — it's the last-line defense against a 4 KB filename punching
// through into the FS / Content-Disposition layers.
func TestSanitizeFilename(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"basic passthrough", "report.pdf", "report.pdf"},
		{"path components stripped", "../../etc/passwd", "passwd"},
		// On Linux filepath.Base treats `\` as a literal byte, so the
		// backslashes survive as underscores rather than being parsed
		// as separators. That's still safe for storage keys (no `/`).
		{"backslash path neutralised", `C:\Windows\System32\cmd.exe`, "C:_Windows_System32_cmd.exe"},
		{"control chars replaced", "evil\x00file\x01.pdf", "evil_file_.pdf"},
		{"empty falls back to untitled", "   ", "untitled"},
		{"single dot falls back", ".", "untitled"},
		{"length cap preserves extension",
			strings.Repeat("a", 300) + ".pdf",
			strings.Repeat("a", 251) + ".pdf"},
		{"length cap on extensionless",
			strings.Repeat("b", 300),
			strings.Repeat("b", 255)},
		{"unicode preserved (display field)",
			"résumé — 2024.pdf", "résumé — 2024.pdf"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := SanitizeFilename(tc.in)
			if got != tc.want {
				t.Fatalf("SanitizeFilename(%q) = %q, want %q", tc.in, got, tc.want)
			}
			if len(got) > AbsMaxFilenameLen {
				t.Fatalf("output exceeds AbsMaxFilenameLen: %d > %d",
					len(got), AbsMaxFilenameLen)
			}
		})
	}
}

// TestSafeStorageSlug locks down the slug invariants the storage layer
// depends on: ASCII-only output, no path separators, length cap,
// extension preservation, deterministic collapse of weirdness. If any
// of these break, presigned URLs and replay-safety go with them.
func TestSafeStorageSlug(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"ascii passthrough", "report.pdf", "report.pdf"},
		{"spaces collapse", "weekly report draft.pdf", "weekly-report-draft.pdf"},
		{"uppercase lowercased", "RESUME.PDF", "resume.pdf"},
		{"unicode replaced", "résumé.pdf", "r-sum.pdf"},
		{"path traversal stripped", "../../etc/passwd", "passwd"},
		{"quotes and crlf gone",
			"evil\"\r\nname.pdf", "evil-name.pdf"},
		{"all-bad becomes file",
			"!!!@@@", "file"},
		{"empty becomes file", "", "file"},
		{"dot only becomes file", ".", "file"},
		{"runs collapse to single dash",
			"a    b___c", "a-b___c"},
		{"leading/trailing dashes trimmed",
			"---weird---", "weird"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := SafeStorageSlug(tc.in)
			if got != tc.want {
				t.Fatalf("SafeStorageSlug(%q) = %q, want %q", tc.in, got, tc.want)
			}
			// Charset invariant — every byte must be in [a-z0-9._-].
			for _, r := range got {
				ok := (r >= 'a' && r <= 'z') ||
					(r >= '0' && r <= '9') ||
					r == '.' || r == '_' || r == '-'
				if !ok {
					t.Fatalf("non-ascii-safe rune %q in %q", r, got)
				}
			}
			if got == "" {
				t.Fatal("slug must never be empty")
			}
			if len(got) > SafeStorageSlugMaxLen {
				t.Fatalf("slug exceeds cap: %d > %d", len(got), SafeStorageSlugMaxLen)
			}
		})
	}
}

// TestSafeStorageSlugCap confirms a giant filename gets capped at
// SafeStorageSlugMaxLen with the extension preserved — so a 5 KB key
// can't blow past S3's 1024-byte limit when concatenated with the
// `orgs/<uuid>/files/<uuid>/` prefix.
func TestSafeStorageSlugCap(t *testing.T) {
	long := strings.Repeat("a", 4096) + ".pdf"
	got := SafeStorageSlug(long)
	if len(got) > SafeStorageSlugMaxLen {
		t.Fatalf("len = %d, max = %d", len(got), SafeStorageSlugMaxLen)
	}
	if !strings.HasSuffix(got, ".pdf") {
		t.Fatalf("extension not preserved: %q", got)
	}
}

// TestSniffMime locks down the cases the audit raised: a forged
// declaration meets real bytes, and the sniffer must call out the
// mismatch (or correctly tolerate the noisy ones).
func TestSniffMime(t *testing.T) {
	pdfHead := []byte("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
	htmlHead := []byte("<!DOCTYPE html><html><head>")
	jsHead := []byte("function pwn(){window.location='evil';}")
	pngHead := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}
	// DOCX = ZIP magic. http.DetectContentType returns application/zip.
	zipHead := []byte{'P', 'K', 0x03, 0x04, 0, 0, 0, 0}

	cases := []struct {
		name         string
		head         []byte
		declared     string
		wantMismatch bool
	}{
		// — the audit's marquee scenarios —
		{"html bytes claiming pdf", htmlHead, "application/pdf", true},
		{"png-claimed JS payload", jsHead, "image/png", true},
		{"docx claiming pdf rejects (zip vs pdf families)", zipHead, "application/pdf", true},

		// — legitimate uploads must NOT trip —
		{"pdf as pdf", pdfHead, "application/pdf", false},
		{"png as png", pngHead, "image/png", false},
		// DOCX / XLSX / PPTX / ODT / EPUB are physically ZIP, so
		// http.DetectContentType returns application/zip. The
		// ZIP-container exemption recognises the declared OOXML/ODF/EPUB
		// MIMEs and passes them through — otherwise every legitimate
		// office upload trips the strict reject path.
		{"docx declared with full office mime allowed via zip-container exemption",
			zipHead,
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			false},
		{"xlsx declared with full office mime allowed",
			zipHead,
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			false},
		{"odt declared allowed",
			zipHead,
			"application/vnd.oasis.opendocument.text",
			false},
		{"epub allowed",
			zipHead,
			"application/epub+zip",
			false},
		// But the exemption is narrow — a forged "application/pdf"
		// declaration with ZIP bytes still rejects, because PDF isn't
		// in the ZIP-container allowlist.
		{"zip bytes claiming an unrelated MIME still rejects",
			zipHead,
			"application/vnd.unknown.format",
			true},

		// — declared MIMEs we deliberately don't second-guess —
		{"unknown declaration is trusted", pdfHead, "application/octet-stream", false},
		{"empty declaration is trusted", pdfHead, "", false},
		{"text/* vs text/* is too noisy to flag", htmlHead, "text/plain", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, mismatch := SniffMime(tc.head, tc.declared)
			if mismatch != tc.wantMismatch {
				t.Fatalf("SniffMime(%q, %q): got mismatch=%v, want %v",
					tc.head, tc.declared, mismatch, tc.wantMismatch)
			}
		})
	}
}

// TestCanonicalMime ensures the merge logic preserves the more specific
// declaration when bytes agree at the family level (DOCX-as-zip
// problem) but flips to detected truth when they don't.
func TestCanonicalMime(t *testing.T) {
	cases := []struct {
		name           string
		declared       string
		detected       string
		want           string
	}{
		// Specific declaration, agreeing detection — keep specific.
		{"png declared, png detected", "image/png", "image/png", "image/png"},
		// DOCX / XLSX / PPTX / ODT / EPUB are physically ZIP archives — the
		// detected family will always be application/zip. Persisting the
		// "bytes-truth" would clobber the precise office MIME and break
		// every downstream branch (convert pipeline, preview renderer,
		// extractor selection), so the ZIP-container exemption keeps the
		// declaration.
		{"docx declared, zip detected — keep docx via ZIP-container exemption",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			"application/zip",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
		{"xlsx declared, zip detected — keep xlsx",
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			"application/zip",
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
		{"epub declared, zip detected — keep epub",
			"application/epub+zip",
			"application/zip",
			"application/epub+zip"},
		// But the exemption is narrow — an unknown declaration with ZIP
		// bytes still gets clobbered to bytes-truth (forgery defense).
		{"unknown declared, zip detected — bytes win",
			"application/vnd.unknown.format",
			"application/zip",
			"application/zip"},

		// Generic declaration, specific detection — upgrade to detection.
		{"octet-stream declared, pdf detected", "application/octet-stream", "application/pdf", "application/pdf"},
		{"empty declared, pdf detected", "", "application/pdf", "application/pdf"},

		// Specific declaration, generic detection — keep declaration.
		{"pdf declared, octet-stream detected", "application/pdf", "application/octet-stream", "application/pdf"},

		// Both empty/unknown — fall back to octet-stream.
		{"both empty", "", "", "application/octet-stream"},

		// Family mismatch — bytes win (closes the trust gap).
		{"png declared, html detected", "image/png", "text/html; charset=utf-8", "text/html"},
		{"pdf declared, html detected (forgery)", "application/pdf", "text/html; charset=utf-8", "text/html"},

		// text/* vs text/* — keep declaration (matches SniffMime's noise exemption).
		{"text/csv declared, text/plain detected", "text/csv", "text/plain; charset=utf-8", "text/csv"},

		// Same family, +xml suffix — keep declaration (more specific).
		{"image/svg+xml declared, image/svg detected", "image/svg+xml", "image/svg", "image/svg+xml"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := CanonicalMime(tc.declared, tc.detected)
			// CanonicalMime strips parameters/suffixes via family() in
			// some branches; compare with that normalization in mind.
			if got != tc.want {
				t.Fatalf("CanonicalMime(%q, %q) = %q, want %q",
					tc.declared, tc.detected, got, tc.want)
			}
		})
	}
}

// TestIsRiskyMime locks the set of types that get forced-attachment on
// download. Adding a new browser-renderable JS-bearing type? Add it here
// and to IsRiskyMime in lockstep.
func TestIsRiskyMime(t *testing.T) {
	risky := []string{
		"text/html",
		"text/html; charset=utf-8",
		"application/xhtml+xml",
		"image/svg",
		"image/svg+xml",
		"application/javascript",
		"text/javascript",
		"application/ecmascript",
	}
	safe := []string{
		"application/pdf",
		"image/png",
		"image/jpeg",
		"text/plain",
		"text/csv",
		"application/json",
		"application/zip",
		"",
	}
	for _, m := range risky {
		if !IsRiskyMime(m) {
			t.Errorf("IsRiskyMime(%q) = false, want true", m)
		}
	}
	for _, m := range safe {
		if IsRiskyMime(m) {
			t.Errorf("IsRiskyMime(%q) = true, want false", m)
		}
	}
}
