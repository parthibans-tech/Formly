package files

import "testing"

// TestInlinePreviewAllowedMime locks down the curated allowlist of MIMEs
// the InlinePreview proxy is willing to render. The CSP header is the
// primary XSS defence, but the allowlist is the second line — keeps
// random binaries (executables, archives) from being served inline at
// all, even if a forged MIME slips into files.mime.
func TestInlinePreviewAllowedMime(t *testing.T) {
	allowed := []string{
		"application/pdf",
		"text/html",
		"text/html; charset=utf-8",
		"application/xhtml+xml",
		"text/plain",
		"text/csv",
		"text/markdown",
		"application/json",
		"image/png",
		"image/jpeg",
		"image/svg+xml",
		"image/webp",
	}
	denied := []string{
		"",                                // unknown MIME — never serve inline
		"application/octet-stream",        // explicit "I don't know"
		"application/javascript",          // executable script
		"text/javascript",
		"application/ecmascript",
		"application/zip",                 // archives
		"application/x-msdownload",        // exe / dll
		"application/vnd.ms-excel",        // opaque office doc
		"application/x-shockwave-flash",   // legacy plugin content
		"video/mp4",                       // not a preview type
		"audio/mpeg",
	}
	for _, m := range allowed {
		if !inlinePreviewAllowedMime(m) {
			t.Errorf("inlinePreviewAllowedMime(%q) = false, want true", m)
		}
	}
	for _, m := range denied {
		if inlinePreviewAllowedMime(m) {
			t.Errorf("inlinePreviewAllowedMime(%q) = true, want false", m)
		}
	}
}

// TestSanitizeHeaderFilename guards the four header-injection vectors
// (CR, LF, ", \) before the filename hits Content-Disposition. Mirrors
// the storage-layer sanitiser; if these two diverge a malicious filename
// could land cleanly in the proxy response while still being escaped at
// the presign layer (or vice versa).
func TestSanitizeHeaderFilename(t *testing.T) {
	cases := map[string]string{
		"plain.pdf":              "plain.pdf",
		`evil".pdf`:              "evil_.pdf",
		"a\r\nSet-Cookie: x=y":   "a__Set-Cookie: x=y",
		`a\b.pdf`:                "a_b.pdf",
		"":                       "",
		"résumé.pdf":             "résumé.pdf",
	}
	for in, want := range cases {
		if got := sanitizeHeaderFilename(in); got != want {
			t.Errorf("sanitizeHeaderFilename(%q) = %q, want %q", in, got, want)
		}
	}
}
