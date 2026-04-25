// Package pdfsec implements PDF-specific threat detection that runs on
// every uploaded PDF when the org's upload policy enables hardening.
//
// What this catches:
//
//   - /JavaScript and /JS — Acrobat-style scripting hooks. Every PDF
//     reader executes these by default; the audit's marquee concern.
//   - /Launch actions    — the "open this file when the user clicks" hook,
//     historically used to drop and run external binaries.
//   - /EmbeddedFile(s)   — file attachments. PDFs can carry payloads
//     (executables, archives, more PDFs) hidden as named attachments.
//   - External XObject / Filespec references — /F (http://...) entries
//     that pull resources from an attacker-controlled host on render.
//   - /OpenAction        — the action that fires on document open.
//     Almost always paired with /JavaScript or /Launch in attacks.
//   - /AA                — additional actions on annots / fields. Same
//     attack surface as OpenAction but per-element.
//   - /URI actions       — clickable hyperlinks. Reported but not blocked
//     by default; an org can opt in via PdfBlockedFeatures.
//   - /SubmitForm        — form submission to an external URL.
//   - /RichMedia         — Flash / 3D content; deprecated, mostly used
//     by exploit kits at this point.
//   - /XFA               — XFA forms (Adobe-specific, JS-bearing).
//   - /Encrypt           — password-protected PDF. Not a threat per se,
//     but our scanner can't introspect encrypted bodies, so we report it
//     so policy can refuse encrypted uploads if the org wants.
//
// What it deliberately does NOT do:
//
//   - Decompress object streams (PDF 1.5 ObjStm). Threats hidden inside
//     a compressed object stream pass through this scanner. We accept
//     that gap because (a) most PDF malware uses plain dictionaries —
//     ObjStm is a writer optimisation, not an attacker tool — and (b)
//     a full xref walker (pdfcpu) doubles the binary size and adds
//     latency. The AV layer (ClamAV) is the catch-net for novel
//     obfuscation; pdfsec is the structural-features layer.
//
//   - Render or execute the PDF. Detection is purely lexical over the
//     bytes outside `stream...endstream` blocks.
//
// PDF name escapes (`/J#61vaScript` → `/JavaScript`) ARE decoded, so
// trivial keyword obfuscation doesn't slip the scanner.
package pdfsec

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"strings"
)

// Threat enumerates the canonical signature names emitted in a Verdict's
// Signature field as `pdf:<threat>`. Stable strings — the values are
// stored in scan_signature and surfaced in audit logs, so renaming them
// is a breaking change for downstream consumers.
const (
	ThreatJavaScript      = "javascript"
	ThreatLaunch          = "launch"
	ThreatEmbeddedFile    = "embedded_file"
	ThreatExternalXObject = "external_xobject"
	ThreatOpenAction      = "open_action"
	ThreatAdditionalActs  = "additional_actions"
	ThreatURIAction       = "uri_action"
	ThreatSubmitForm      = "submit_form"
	ThreatRichMedia       = "rich_media"
	ThreatXFA             = "xfa"
	ThreatEncrypted       = "encrypted"
)

// DefaultBlockedFeatures is the curated set of threats blocked when an
// org hasn't customised PdfBlockedFeatures. Picked from the audit:
// JavaScript, Launch, EmbeddedFile, and external XObject references are
// the four classic "PDF as malware container" patterns. The other
// detections (URI, submit, XFA, RichMedia, Encrypted) are reported but
// not blocked by default — they have legitimate uses in business PDFs
// (a contract with a "click here to e-sign" link, for example).
var DefaultBlockedFeatures = []string{
	ThreatJavaScript,
	ThreatLaunch,
	ThreatEmbeddedFile,
	ThreatExternalXObject,
}

// Report is the output of Inspect. Each boolean records whether the
// matching feature was found anywhere in the PDF; Findings is the
// human-readable list (one entry per detection, suitable for audit
// logs) in the order they were detected.
type Report struct {
	IsPDF                bool
	HasJavaScript        bool
	HasLaunchAction      bool
	HasEmbeddedFile      bool
	HasExternalXObject   bool
	HasOpenAction        bool
	HasAdditionalActions bool
	HasURIAction         bool
	HasSubmitForm        bool
	HasRichMedia         bool
	HasXFA               bool
	IsEncrypted          bool
	Findings             []string
}

// ErrNotPDF is returned by Inspect when the magic bytes don't match.
// Callers should treat this as "not a PDF, skip the check" rather than
// "blocked" — non-PDF MIMEs go through other paths.
var ErrNotPDF = errors.New("not a pdf (magic bytes missing)")

// MaxScanBytes caps the bytes Inspect will read from a single PDF.
// Threats concentrate at the catalog/annotations layer near the end
// (xref) and beginning (header + first dicts) of the file. We cap at
// 50 MiB so a multi-GB attacker upload can't pin a worker on parsing.
const MaxScanBytes = 50 * 1024 * 1024

// Inspect token-scans the PDF bytes from r and returns a Report. The
// scan skips compressed `stream...endstream` blocks (those don't
// represent dictionary-level features) but does decode PDF name
// escapes (#XX hex) so /J#61vaScript still trips the JS detector.
//
// The reader is consumed in full, up to MaxScanBytes. Callers that
// already hold the full byte buffer can wrap it in bytes.NewReader.
func Inspect(r io.Reader) (Report, error) {
	// Cap at MaxScanBytes — the +1 lets us notice oversize input
	// without doing a separate Stat call. We still process whatever
	// portion fit; structural threats almost always appear in the
	// first few MB.
	limited := io.LimitReader(r, MaxScanBytes+1)
	buf, err := io.ReadAll(limited)
	if err != nil {
		return Report{}, err
	}

	rep := Report{}
	if !bytes.HasPrefix(bytes.TrimLeft(buf, " \t\r\n"), []byte("%PDF-")) {
		return rep, ErrNotPDF
	}
	rep.IsPDF = true

	// Strip stream contents so we don't false-positive on threat
	// keywords appearing inside compressed page content. We don't try
	// to decompress — those hits would be content, not actions.
	cleaned := stripStreams(buf)

	// Walk every PDF name token (`/foo`) in the cleaned buffer. A name
	// is `/` followed by the run of regular characters until whitespace
	// or a delimiter (<<>>()<>[]{}/%). We decode #XX escapes per the
	// PDF spec so obfuscation doesn't help.
	addFinding := func(s string) {
		rep.Findings = append(rep.Findings, s)
	}
	scanNames(cleaned, func(name string, ctx []byte) {
		switch name {
		case "JavaScript", "JS":
			if !rep.HasJavaScript {
				rep.HasJavaScript = true
				addFinding("javascript action")
			}
		case "Launch":
			if !rep.HasLaunchAction {
				rep.HasLaunchAction = true
				addFinding("launch action")
			}
		case "EmbeddedFile", "EmbeddedFiles":
			if !rep.HasEmbeddedFile {
				rep.HasEmbeddedFile = true
				addFinding("embedded file attachment")
			}
		case "OpenAction":
			if !rep.HasOpenAction {
				rep.HasOpenAction = true
				addFinding("open action")
			}
		case "AA":
			if !rep.HasAdditionalActions {
				rep.HasAdditionalActions = true
				addFinding("additional actions (/AA)")
			}
		case "URI":
			// Only count /URI when followed by a network-scheme value.
			// Many PDFs use /URI as a name elsewhere (form field URI
			// validators, etc.); we only care about clickable links to
			// http(s)/ftp/file targets.
			if uriHasExternalScheme(ctx) && !rep.HasURIAction {
				rep.HasURIAction = true
				addFinding("uri action")
			}
		case "SubmitForm":
			if !rep.HasSubmitForm {
				rep.HasSubmitForm = true
				addFinding("submit form action")
			}
		case "RichMedia":
			if !rep.HasRichMedia {
				rep.HasRichMedia = true
				addFinding("rich media (flash/3d)")
			}
		case "XFA":
			if !rep.HasXFA {
				rep.HasXFA = true
				addFinding("xfa form")
			}
		case "Encrypt":
			if !rep.IsEncrypted {
				rep.IsEncrypted = true
				addFinding("encrypted document")
			}
		case "Filespec", "F":
			// External XObject / file reference. We flag a /Filespec
			// AND a /F whose value starts with a network scheme; either
			// is suspicious on its own (a /Filespec with an external /F
			// is the canonical pattern, but bare /F (http://...) shows
			// up in older / hand-crafted PDFs too).
			if name == "Filespec" || filespecHasExternalScheme(ctx) {
				if !rep.HasExternalXObject {
					rep.HasExternalXObject = true
					addFinding("external file reference")
				}
			}
		}
	})

	return rep, nil
}

// Threats returns the list of threat constants that fired in this
// report, in stable order (matching the constant declarations above).
// Useful for serializing the verdict signature or building audit lines.
func (r Report) Threats() []string {
	out := []string{}
	if r.HasJavaScript {
		out = append(out, ThreatJavaScript)
	}
	if r.HasLaunchAction {
		out = append(out, ThreatLaunch)
	}
	if r.HasEmbeddedFile {
		out = append(out, ThreatEmbeddedFile)
	}
	if r.HasExternalXObject {
		out = append(out, ThreatExternalXObject)
	}
	if r.HasOpenAction {
		out = append(out, ThreatOpenAction)
	}
	if r.HasAdditionalActions {
		out = append(out, ThreatAdditionalActs)
	}
	if r.HasURIAction {
		out = append(out, ThreatURIAction)
	}
	if r.HasSubmitForm {
		out = append(out, ThreatSubmitForm)
	}
	if r.HasRichMedia {
		out = append(out, ThreatRichMedia)
	}
	if r.HasXFA {
		out = append(out, ThreatXFA)
	}
	if r.IsEncrypted {
		out = append(out, ThreatEncrypted)
	}
	return out
}

// FirstBlocked returns the first threat in `report` that's also in
// `blocked`, or "" when the report is clean of blocked threats. The
// search order matches Threats() so behaviour is deterministic
// regardless of how the org wrote their config.
func FirstBlocked(report Report, blocked []string) string {
	if len(blocked) == 0 {
		return ""
	}
	bset := map[string]struct{}{}
	for _, b := range blocked {
		bset[normalizeFeature(b)] = struct{}{}
	}
	for _, t := range report.Threats() {
		if _, ok := bset[t]; ok {
			return t
		}
	}
	return ""
}

// normalizeFeature collapses a free-form blocked-feature string from
// org config to the canonical constants. Trims, lowercases, and maps
// common aliases so an admin who wrote "JavaScript" or "embeddedFile"
// still gets the right behaviour.
func normalizeFeature(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.ReplaceAll(s, "-", "_")
	switch s {
	case "javascript", "js":
		return ThreatJavaScript
	case "launch", "launch_action":
		return ThreatLaunch
	case "embedded_file", "embedded", "embeddedfile", "embeddedfiles", "attachment", "attachments":
		return ThreatEmbeddedFile
	case "external_xobject", "external", "externalref", "external_ref", "external_reference", "filespec":
		return ThreatExternalXObject
	case "open_action", "openaction":
		return ThreatOpenAction
	case "additional_actions", "aa", "additionalactions":
		return ThreatAdditionalActs
	case "uri", "uri_action", "uriaction":
		return ThreatURIAction
	case "submit_form", "submitform", "submit":
		return ThreatSubmitForm
	case "rich_media", "richmedia":
		return ThreatRichMedia
	case "xfa":
		return ThreatXFA
	case "encrypted", "encrypt":
		return ThreatEncrypted
	}
	return s
}

// stripStreams removes the bytes between `stream` and `endstream`
// markers so threat-name matching only fires on dictionary syntax.
// We replace stream bodies with whitespace so byte offsets don't
// shift dramatically (preserves line context for any later debug).
func stripStreams(b []byte) []byte {
	out := make([]byte, 0, len(b))
	rest := b
	for {
		// Find next "stream" marker. PDF spec requires it preceded by
		// CR, LF, or CRLF and followed by EOL — but we're permissive
		// here; a literal "stream" inside a string is a non-issue
		// because we'd hit it during name-token scanning where it's
		// just letters.
		i := bytes.Index(rest, []byte("stream"))
		if i < 0 {
			out = append(out, rest...)
			break
		}
		// Validate the boundary: previous char (or start) must not be
		// part of a longer keyword like "endstream". Look backward one
		// byte; if it's a letter/digit, this is a substring, skip.
		ok := i == 0
		if !ok {
			c := rest[i-1]
			ok = !isPDFNameChar(c)
		}
		if !ok {
			// Append up to and including the false hit, continue.
			out = append(out, rest[:i+len("stream")]...)
			rest = rest[i+len("stream"):]
			continue
		}
		// Append everything up to and including "stream".
		out = append(out, rest[:i+len("stream")]...)
		rest = rest[i+len("stream"):]
		// Find matching "endstream".
		j := bytes.Index(rest, []byte("endstream"))
		if j < 0 {
			// Unterminated stream — drop the rest (truncated/malformed
			// PDFs land here). Don't emit content; we have no way to
			// know where it ended.
			break
		}
		// Replace the body with a single newline so name-scan offsets
		// don't go pathological for very large streams.
		out = append(out, '\n')
		rest = rest[j:]
	}
	return out
}

// scanNames walks PDF name tokens (`/Foo`) in `b`, calling cb with the
// decoded name (#XX escapes resolved) and a small post-context window
// (next 64 bytes) so callers can do simple value-side checks like
// "/URI followed by a network scheme".
func scanNames(b []byte, cb func(name string, context []byte)) {
	for i := 0; i < len(b); i++ {
		if b[i] != '/' {
			continue
		}
		j := i + 1
		for j < len(b) && isPDFNameChar(b[j]) {
			j++
		}
		if j == i+1 {
			continue // bare slash, skip
		}
		raw := b[i+1 : j]
		name := decodeNameEscapes(raw)
		// Provide a 64-byte context window so callers can disambiguate
		// /URI (action) from /URI (just a name in some other dict).
		end := j + 64
		if end > len(b) {
			end = len(b)
		}
		cb(name, b[j:end])
		i = j - 1
	}
}

// isPDFNameChar reports whether c is a valid byte inside a PDF name
// token. The spec excludes whitespace and the delimiter set
// `()<>[]{}/%`. Everything else is in (including #XX escape bytes).
func isPDFNameChar(c byte) bool {
	switch c {
	case 0x00, 0x09, 0x0A, 0x0C, 0x0D, 0x20: // whitespace
		return false
	case '(', ')', '<', '>', '[', ']', '{', '}', '/', '%':
		return false
	}
	return true
}

// decodeNameEscapes turns "J#61vaScript" into "JavaScript". PDF
// names may encode any byte as `#XX` (two hex digits). Used to
// catch trivial obfuscation.
func decodeNameEscapes(b []byte) string {
	if !bytes.ContainsRune(b, '#') {
		return string(b)
	}
	out := make([]byte, 0, len(b))
	for i := 0; i < len(b); i++ {
		if b[i] == '#' && i+2 < len(b) {
			hi, ok1 := hexDigit(b[i+1])
			lo, ok2 := hexDigit(b[i+2])
			if ok1 && ok2 {
				out = append(out, byte(hi*16+lo))
				i += 2
				continue
			}
		}
		out = append(out, b[i])
	}
	return string(out)
}

func hexDigit(c byte) (int, bool) {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0'), true
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10, true
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10, true
	}
	return 0, false
}

// uriHasExternalScheme reports whether the bytes following a /URI name
// open with a literal-string PDF value whose content starts with a
// network scheme. /URI is sometimes used as a property name; the
// dangerous form is `/URI (https://attacker/...)`. We scan past
// whitespace, find the opening `(`, and check the first few bytes.
func uriHasExternalScheme(ctx []byte) bool {
	return valueHasExternalScheme(ctx)
}

// filespecHasExternalScheme is the same check applied to /F values.
// /F is overloaded — it's a key in many dicts — so we only flag the
// case where its value is a literal string starting with a network
// scheme.
func filespecHasExternalScheme(ctx []byte) bool {
	return valueHasExternalScheme(ctx)
}

func valueHasExternalScheme(ctx []byte) bool {
	// Skip whitespace.
	i := 0
	for i < len(ctx) && isPDFWhitespace(ctx[i]) {
		i++
	}
	if i >= len(ctx) || ctx[i] != '(' {
		return false
	}
	// Read up to the closing paren or 32 bytes, whichever first.
	end := i + 1 + 32
	if end > len(ctx) {
		end = len(ctx)
	}
	val := bytes.ToLower(ctx[i+1 : end])
	// Strip leading whitespace inside the literal.
	for len(val) > 0 && isPDFWhitespace(val[0]) {
		val = val[1:]
	}
	for _, scheme := range [...]string{"http://", "https://", "ftp://", "ftps://", "file://"} {
		if bytes.HasPrefix(val, []byte(scheme)) {
			return true
		}
	}
	return false
}

func isPDFWhitespace(c byte) bool {
	switch c {
	case 0x00, 0x09, 0x0A, 0x0C, 0x0D, 0x20:
		return true
	}
	return false
}

// LookForMagic reports whether the first non-whitespace bytes of r
// match the PDF magic. Cheap pre-flight for callers that want to
// short-circuit before pulling the whole body.
func LookForMagic(r io.Reader) (bool, error) {
	br := bufio.NewReaderSize(r, 16)
	head, err := br.Peek(16)
	if err != nil && !errors.Is(err, io.EOF) {
		return false, err
	}
	return bytes.HasPrefix(bytes.TrimLeft(head, " \t\r\n"), []byte("%PDF-")), nil
}
