package storage

import (
	"strings"
	"testing"
)

// TestAttachmentDispositionAlwaysSet locks down the audit's marquee
// invariant: every download presign emits an attachment disposition,
// regardless of MIME or filename. A regression here re-opens the
// stored-XSS hole.
func TestAttachmentDispositionAlwaysSet(t *testing.T) {
	cases := []struct {
		name string
		fn   string
		want string
	}{
		{"basic filename",
			"report.pdf",
			`attachment; filename="report.pdf"`},
		{"empty falls back to download",
			"",
			`attachment; filename="download"`},
		{"quote injection sanitised",
			`evil".pdf`,
			`attachment; filename="evil_.pdf"`},
		{"crlf injection sanitised",
			"a\r\nSet-Cookie: x=y\r\n.pdf",
			`attachment; filename="a__Set-Cookie: x=y__.pdf"`},
		{"backslash sanitised",
			`a\b.pdf`,
			`attachment; filename="a_b.pdf"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := attachmentDisposition(tc.fn)
			if got != tc.want {
				t.Fatalf("attachmentDisposition(%q) = %q, want %q",
					tc.fn, got, tc.want)
			}
			if !strings.HasPrefix(got, "attachment;") {
				t.Fatalf("disposition must start with attachment;, got %q", got)
			}
		})
	}
}

// TestIsRiskyMime mirrors uploadpolicy.TestIsRiskyMime — these two
// have to stay in lockstep because the storage layer can't import
// uploadpolicy without a cycle. If you add a renderable JS-bearing
// MIME to one, add it to the other.
func TestIsRiskyMime(t *testing.T) {
	risky := []string{
		"text/html",
		"text/html; charset=utf-8",
		"TEXT/HTML",
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
		if !isRiskyMime(m) {
			t.Errorf("isRiskyMime(%q) = false, want true", m)
		}
	}
	for _, m := range safe {
		if isRiskyMime(m) {
			t.Errorf("isRiskyMime(%q) = true, want false", m)
		}
	}
}

// TestSanitizeDispFilename guards header-injection — quote/backslash/CR/LF
// must be neutralised before the filename hits a presign URL param,
// because S3 reflects the param verbatim into the response header.
func TestSanitizeDispFilename(t *testing.T) {
	cases := map[string]string{
		"plain.pdf":              "plain.pdf",
		`"`:                      "_",
		"\r\n":                   "__",
		`a"b\c` + "\r\n" + "d.x": "a_b_c__d.x",
		// Unicode passes through untouched — RFC 6266 explicitly allows
		// raw bytes; quoting is only required for the listed offenders.
		"résumé.pdf": "résumé.pdf",
	}
	for in, want := range cases {
		if got := sanitizeDispFilename(in); got != want {
			t.Errorf("sanitizeDispFilename(%q) = %q, want %q", in, got, want)
		}
	}
}
