// Package pathtpl resolves Mustache-flavored {{key}} placeholders in
// output filename and folder-path templates that integrators set on a
// template's config.
//
// Why this exists in its own package:
//
//   - Both runner.Run (per-template default folder/filename) and the HTTP
//     handler (per-call overrides) call into this. Keeping the resolver
//     in one place means the substitution + sanitisation rules can't
//     drift between the two paths.
//
//   - Path templates run BEFORE storage upload, so any value coming from
//     the request `data` payload reaches a filesystem-shaped string.
//     That makes sanitisation a security concern, not a polish step:
//     a value like "../../etc/passwd" must never escape the orgs/<id>/
//     scope, and a NUL byte must never reach the storage backend.
//
// The substitution rules:
//
//   - "{{key}}" with optional surrounding whitespace inside the braces
//     is replaced with `data[key]` formatted as a string. Missing keys
//     resolve to "" (intentional: "Invoice-{{number}}.pdf" with no
//     number gracefully degrades to "Invoice-.pdf" rather than failing
//     the whole generate request).
//
//   - Replacement values are sanitised per-segment: control bytes (incl.
//     NUL), path separators, and ".." are stripped. Trimmed whitespace.
//     A long substitution is hard-capped so a 1MB string in `data` can't
//     blow up the storage key.
//
//   - The resolved path is then split on "/" and each segment is
//     re-sanitised (catches static dirty input authored directly in the
//     template config — not just substituted values). Empty segments are
//     dropped, "." and ".." are dropped.
package pathtpl

import (
	"fmt"
	"regexp"
	"strings"
)

// MaxSubstLen caps a single placeholder substitution. 96 chars is enough
// for human names, IDs, dates, etc. — anything longer is almost certainly
// pasted-in noise and would only bloat the storage key.
const MaxSubstLen = 96

// MaxResolvedLen caps the final resolved string. The storage key carries
// a UUID + orgs prefix on top, and S3 keys max at 1024 bytes — leave
// headroom by capping our piece at 256.
const MaxResolvedLen = 256

var placeholderRe = regexp.MustCompile(`\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}`)

// Resolve substitutes {{key}} placeholders in tmpl with values from data,
// then sanitises the result. Returns the resolved string. An empty tmpl
// returns "" without error so callers can use this as the default-aware
// path: `pathtpl.Resolve("", data)` is a no-op.
func Resolve(tmpl string, data map[string]interface{}) string {
	if tmpl == "" {
		return ""
	}
	out := placeholderRe.ReplaceAllStringFunc(tmpl, func(match string) string {
		m := placeholderRe.FindStringSubmatch(match)
		if len(m) < 2 {
			return ""
		}
		key := m[1]
		v, ok := data[key]
		if !ok || v == nil {
			return ""
		}
		s := stringify(v)
		return sanitiseValue(s)
	})
	if len(out) > MaxResolvedLen {
		out = out[:MaxResolvedLen]
	}
	return out
}

// ResolvePath resolves tmpl, then splits the result on "/" and rebuilds
// it from cleaned segments only. Use this for folderPath. Returns "" for
// an empty/all-empty result so callers can detect "no folder" without
// extra checks.
func ResolvePath(tmpl string, data map[string]interface{}) string {
	resolved := Resolve(tmpl, data)
	if resolved == "" {
		return ""
	}
	parts := strings.Split(resolved, "/")
	clean := make([]string, 0, len(parts))
	for _, p := range parts {
		p = sanitiseSegment(p)
		if p == "" {
			continue
		}
		clean = append(clean, p)
	}
	return strings.Join(clean, "/")
}

// ResolveFilename resolves tmpl as a single filename segment — no slashes
// allowed, control chars stripped, and a fallback applied when the result
// would be empty or extension-less. Pass the desired fallback (e.g.
// "<templateName>-filled-<timestamp>.pdf") so the caller's policy on
// "what name do we use when the template said nothing useful" stays in
// the caller.
func ResolveFilename(tmpl string, data map[string]interface{}, fallback string) string {
	resolved := Resolve(tmpl, data)
	// Filenames must not contain path separators — collapse / and \ into
	// spaces to preserve the user's intent without letting them write
	// across directories.
	resolved = strings.ReplaceAll(resolved, "/", " ")
	resolved = strings.ReplaceAll(resolved, "\\", " ")
	resolved = sanitiseSegment(resolved)
	if resolved == "" {
		return fallback
	}
	// Default to .pdf when the template didn't include an extension. We
	// only render PDFs from this pipeline so this is a safe default.
	if !strings.Contains(resolved, ".") {
		resolved += ".pdf"
	}
	return resolved
}

// sanitiseValue cleans a single placeholder substitution. Strips NULs,
// other control bytes, ASCII path separators, and trims length. Slashes
// are kept here because a caller might legitimately want
// "{{customer.region}}" to expand to "us/west" — ResolvePath then
// splits on "/" and re-sanitises each segment.
func sanitiseValue(s string) string {
	s = strings.TrimSpace(s)
	if s == ".." || s == "." {
		return ""
	}
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r == 0x00:
			continue
		case r < 0x20:
			continue
		case r == 0x7F:
			continue
		case r == '\\':
			continue
		}
		b.WriteRune(r)
		if b.Len() >= MaxSubstLen {
			break
		}
	}
	return b.String()
}

// sanitiseSegment applies the per-segment rules: drop ".", "..", and
// any segment that's empty after trimming. Used by ResolvePath after the
// split, and by ResolveFilename to normalise the whole name.
func sanitiseSegment(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, ".") // also nukes a leading/trailing dot run
	if s == "" || s == "." || s == ".." {
		return ""
	}
	// At this point slashes shouldn't be present (ResolvePath already
	// split on them), but defence-in-depth: drop them anyway so a
	// double-resolved string can't smuggle one in.
	s = strings.ReplaceAll(s, "/", "")
	s = strings.ReplaceAll(s, "\\", "")
	return s
}

func stringify(v interface{}) string {
	switch x := v.(type) {
	case string:
		return x
	case fmt.Stringer:
		return x.String()
	default:
		return fmt.Sprintf("%v", v)
	}
}
