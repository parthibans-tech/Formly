package aidetect

import (
	"regexp"
	"strings"
)

// Label-semantic enrichment.
//
// The CV-grid pass gives us a correctly-sized text widget with a
// known cell count, but a 10-cell box labeled "PAN Number" deserves
// more than a generic text field — it should carry an HTML pattern
// hint, a placeholder, and uppercase coercion so the user filling
// the form can't fat-finger it. Same for date strips ("DDMMYYYY"),
// pincodes (6 digits in India), Aadhaar (12 digits), CKYC (14),
// LEI (20 alphanumeric), IFSC, GSTIN, mobile/email/etc.
//
// We deliberately keep the widget Type as "text" — the static
// designer's vocabulary is text/checkbox/radio/signature, and adding
// new types would ripple through frontend rendering. Instead we
// enrich the Props map: maxLength, placeholder, pattern, uppercase,
// inputMode. The frontend can render an <input> with these
// attributes and get HTML-level validation for free.
//
// Patterns are specifically calibrated for Indian KYC / bank-account
// forms (the user's primary use case) — the largest single source of
// fillable-PDF traffic globally and the form class with the strictest
// per-field formats. The matchers are case-insensitive and look for
// substring tokens so "PAN Number", "PAN Card", "PAN Card #",
// "Permanent Account Number (PAN)" all hit the same rule.
//
// Adding a new rule:
//   1. Pick the lowest-overlap label tokens that uniquely identify it.
//   2. Decide whether the rule needs cellCount (grid-only) or fires
//      for any text field with that label (label-driven).
//   3. Append to semanticRules. Order matters — first match wins, so
//      put more-specific rules above more-general ones.

// fieldSemantic is the patch applied to a Proposal's Props when its
// label matches a semantic rule. Zero/empty fields are skipped
// (won't overwrite existing props with empty values).
type fieldSemantic struct {
	MaxLength   int
	Placeholder string
	Pattern     string
	Uppercase   bool
	InputMode   string // "numeric" / "tel" / "email" / "decimal"
}

type semanticRule struct {
	// Name is for telemetry / debugging only — not exposed.
	name string
	// match returns true when this rule applies to the given lowercased
	// label and grid cell count. cellCount is 0 for non-grid fields.
	match func(label string, cellCount int) bool
	// patch is the props delta to apply when match returns true.
	patch fieldSemantic
}

// containsAny returns true when any of the provided substrings appears
// in s. s is assumed already-lowercased.
func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

// hasWord returns true when s contains any of the words as a whole-
// word match (delimited by space, punctuation, or string ends). This
// avoids "panel" matching the "pan" rule and "telephone" matching
// "tel" when tel was meant to be a separate token. s must be
// lowercase.
var wordSplit = regexp.MustCompile(`[^a-z0-9]+`)

func hasWord(s string, words ...string) bool {
	tokens := wordSplit.Split(s, -1)
	wantSet := make(map[string]struct{}, len(words))
	for _, w := range words {
		wantSet[w] = struct{}{}
	}
	for _, t := range tokens {
		if _, ok := wantSet[t]; ok {
			return true
		}
	}
	return false
}

// semanticRules — first-match-wins. Most-specific patterns first.
var semanticRules = []semanticRule{
	// ── Indian KYC identifiers ─────────────────────────────────────

	// PAN: 10 chars, format AAAAA9999A. The grid is almost always
	// labeled "PAN" so cellCount==10 + label="pan" is a high-precision
	// match. We also accept "permanent account number".
	{
		name: "pan",
		match: func(l string, n int) bool {
			if n != 10 && n != 0 {
				return false
			}
			return hasWord(l, "pan") || strings.Contains(l, "permanent account number")
		},
		patch: fieldSemantic{
			MaxLength:   10,
			Placeholder: "ABCDE1234F",
			Pattern:     "[A-Z]{5}[0-9]{4}[A-Z]",
			Uppercase:   true,
		},
	},

	// Aadhaar: 12-digit UID. "aadhaar" / "aadhar" / "uid".
	{
		name: "aadhaar",
		match: func(l string, n int) bool {
			if n != 12 && n != 0 {
				return false
			}
			return hasWord(l, "aadhaar", "aadhar", "uid")
		},
		patch: fieldSemantic{
			MaxLength:   12,
			Placeholder: "1234 5678 9012",
			Pattern:     "[0-9]{12}",
			InputMode:   "numeric",
		},
	},

	// CKYC: 14-digit Central KYC Registry number.
	{
		name: "ckyc",
		match: func(l string, n int) bool {
			if n != 14 && n != 0 {
				return false
			}
			return hasWord(l, "ckyc")
		},
		patch: fieldSemantic{
			MaxLength:   14,
			Placeholder: "14-digit CKYC",
			Pattern:     "[0-9]{14}",
			InputMode:   "numeric",
		},
	},

	// LEI: 20-char Legal Entity Identifier (ISO 17442).
	{
		name: "lei",
		match: func(l string, n int) bool {
			if n != 20 && n != 0 {
				return false
			}
			return hasWord(l, "lei") || strings.Contains(l, "legal entity")
		},
		patch: fieldSemantic{
			MaxLength: 20,
			Pattern:   "[A-Z0-9]{20}",
			Uppercase: true,
		},
	},

	// GSTIN: 15 chars, mostly numeric with some alpha.
	{
		name: "gstin",
		match: func(l string, n int) bool {
			if n != 15 && n != 0 {
				return false
			}
			return hasWord(l, "gstin", "gst")
		},
		patch: fieldSemantic{
			MaxLength: 15,
			Uppercase: true,
		},
	},

	// IFSC: 11-char bank branch code, AAAA0NNNNNN.
	{
		name: "ifsc",
		match: func(l string, n int) bool {
			if n != 11 && n != 0 {
				return false
			}
			return hasWord(l, "ifsc")
		},
		patch: fieldSemantic{
			MaxLength: 11,
			Pattern:   "[A-Z]{4}0[A-Z0-9]{6}",
			Uppercase: true,
		},
	},

	// ── Addresses ──────────────────────────────────────────────────

	// Indian Pincode = 6 digits.
	{
		name: "pincode",
		match: func(l string, _ int) bool {
			return containsAny(l, "pin code", "pincode", "postal code", "postcode", "zip code")
		},
		patch: fieldSemantic{
			MaxLength: 6,
			Pattern:   "[0-9]{6}",
			InputMode: "numeric",
		},
	},

	// ── Dates ──────────────────────────────────────────────────────

	// Date strips. Two firing patterns:
	//   - Label includes "ddmmyy" / "dd/mm/yyyy" / "mm/dd/yyyy"
	//   - cellCount is 6 (DDMMYY) or 8 (DDMMYYYY) AND label hints at a
	//     date concept (date, dob, birth, expiry, valid, issued).
	{
		name: "date_explicit_format",
		match: func(l string, _ int) bool {
			return containsAny(l, "ddmmyy", "dd/mm/yy", "dd-mm-yy", "mm/dd/yy")
		},
		patch: fieldSemantic{
			Placeholder: "DDMMYYYY",
			Pattern:     "[0-9]{6,8}",
			InputMode:   "numeric",
		},
	},
	{
		name: "date_inferred",
		match: func(l string, n int) bool {
			if n != 6 && n != 8 {
				return false
			}
			return containsAny(l, "date", "dob", "birth", "expiry", "valid", "issued", "issue")
		},
		patch: fieldSemantic{
			Placeholder: "DDMMYYYY",
			Pattern:     "[0-9]{6,8}",
			InputMode:   "numeric",
		},
	},

	// ── Contact ────────────────────────────────────────────────────

	// Mobile: typically 10 digits in India. Accept also "phone", "tel",
	// "telephone", "cell".
	{
		name: "mobile",
		match: func(l string, _ int) bool {
			return hasWord(l, "mobile", "phone", "tel", "telephone", "cell") ||
				containsAny(l, "mobile no", "phone no", "contact no")
		},
		patch: fieldSemantic{
			MaxLength: 10,
			Pattern:   "[0-9]{10}",
			InputMode: "tel",
		},
	},

	// Email.
	{
		name: "email",
		match: func(l string, _ int) bool {
			return containsAny(l, "email", "e-mail", "e mail")
		},
		patch: fieldSemantic{
			Placeholder: "name@example.com",
			Pattern:     "[^@]+@[^@]+\\.[a-zA-Z]{2,}",
			InputMode:   "email",
		},
	},

	// ── Money ──────────────────────────────────────────────────────

	{
		name: "amount",
		match: func(l string, _ int) bool {
			return containsAny(l, "amount", "rs.", "rs ", "inr ", "rupees")
		},
		patch: fieldSemantic{
			InputMode: "decimal",
		},
	},
}

// applySemantics mutates p.Props in place with hints inferred from
// p.Label and (when grid-derived) the existing maxLength prop. Safe
// to call on any text Proposal — non-text widgets (checkbox/radio/
// signature) are skipped. Existing props are NOT overwritten unless
// the rule explicitly provides a stronger value.
//
// This runs once at proposal-build time after polishProposals has
// produced final labels, so the rules see the same text the user will
// see in the modal — including any section prefix the heuristic added
// (e.g. "MAILING ADDRESS - PIN Code" still matches the pincode rule
// because the matcher uses substring search).
func applySemantics(p *Proposal) {
	if p.Type != "text" {
		return
	}
	if p.Label == "" && p.DataKey == "" {
		return
	}
	// Use both Label and DataKey as match input — the polish pass may
	// have produced a snake_case key from a label that's now empty,
	// and we want the rule to still fire ("pan_number" matches pan).
	hay := strings.ToLower(p.Label + " " + strings.ReplaceAll(p.DataKey, "_", " "))

	// Read the existing maxLength (set by grid detection) so date /
	// PAN / CKYC matchers can use it as their cellCount signal.
	cellCount := 0
	if p.Props != nil {
		if v, ok := p.Props["maxLength"]; ok {
			switch n := v.(type) {
			case int:
				cellCount = n
			case float64:
				cellCount = int(n)
			}
		}
	}

	for _, rule := range semanticRules {
		if !rule.match(hay, cellCount) {
			continue
		}
		if p.Props == nil {
			p.Props = map[string]interface{}{}
		}
		patch := rule.patch
		// MaxLength: only set when not already present from the grid
		// detection (don't override the measured cell count with a
		// rule-derived guess).
		if patch.MaxLength > 0 {
			if _, exists := p.Props["maxLength"]; !exists {
				p.Props["maxLength"] = patch.MaxLength
			}
		}
		if patch.Placeholder != "" {
			if _, exists := p.Props["placeholder"]; !exists {
				p.Props["placeholder"] = patch.Placeholder
			}
		}
		if patch.Pattern != "" {
			if _, exists := p.Props["pattern"]; !exists {
				p.Props["pattern"] = patch.Pattern
			}
		}
		if patch.Uppercase {
			p.Props["uppercase"] = true
		}
		if patch.InputMode != "" {
			if _, exists := p.Props["inputMode"]; !exists {
				p.Props["inputMode"] = patch.InputMode
			}
		}
		// First match wins — semantic rules are mutually exclusive in
		// practice (a field is either a PAN or an Aadhaar, never both)
		// so stopping on first hit avoids props churn.
		return
	}
}
