package aidetect

import (
	"testing"
)

// applySemantics enriches text Proposals based on label/key matches
// against the Indian-KYC-flavoured rule table in semantics.go. The
// tests below pin one canonical fixture per rule plus the cross-
// cutting invariants (no overwrite, non-text skipped, cellCount
// gating, datakey-as-fallback).

func textProposal(label string, props map[string]interface{}) *Proposal {
	return &Proposal{
		Type:  "text",
		Label: label,
		Props: props,
	}
}

func TestApplySemantics_NonTextSkipped(t *testing.T) {
	// Checkbox/radio/signature widgets never receive text-style props
	// even when their label happens to match — the rule table only
	// makes sense for free-text inputs.
	p := &Proposal{Type: "checkbox", Label: "PAN Number"}
	applySemantics(p)
	if p.Props != nil {
		t.Fatalf("non-text proposal should not be enriched, got Props=%v", p.Props)
	}
}

func TestApplySemantics_EmptyLabelAndKeyNoOp(t *testing.T) {
	// Without anything to match, applySemantics must not allocate
	// Props or panic. A Proposal with no label and no key is a synth
	// row that the upstream tier couldn't bind — semantic enrichment
	// has nothing to say about it.
	p := &Proposal{Type: "text"}
	applySemantics(p)
	if p.Props != nil {
		t.Fatalf("expected nil Props for label-less proposal, got %v", p.Props)
	}
}

func TestApplySemantics_PAN(t *testing.T) {
	// 10-cell grid + "PAN" label is the canonical Indian KYC trigger.
	// We expect the full PAN treatment: pattern, placeholder, uppercase,
	// maxLength preserved as 10 (already set by the grid pass).
	p := textProposal("PAN Number", map[string]interface{}{"maxLength": 10})
	applySemantics(p)

	if got := p.Props["pattern"]; got != "[A-Z]{5}[0-9]{4}[A-Z]" {
		t.Errorf("pattern = %v", got)
	}
	if got := p.Props["placeholder"]; got != "ABCDE1234F" {
		t.Errorf("placeholder = %v", got)
	}
	if got := p.Props["uppercase"]; got != true {
		t.Errorf("uppercase = %v", got)
	}
	if got := p.Props["maxLength"]; got != 10 {
		t.Errorf("maxLength = %v (grid value should be preserved)", got)
	}
}

func TestApplySemantics_PAN_FromDataKey(t *testing.T) {
	// When polishProposals hands us a slugged key but the label has
	// already been emptied (or never existed), the rule still fires
	// off the underscored datakey. Mirrors what happens when a tier
	// emits {DataKey: "pan_number", Label: ""}.
	p := &Proposal{Type: "text", DataKey: "pan_number"}
	applySemantics(p)
	if p.Props["pattern"] != "[A-Z]{5}[0-9]{4}[A-Z]" {
		t.Fatalf("expected PAN pattern from datakey, got %v", p.Props)
	}
}

func TestApplySemantics_PAN_GridCountMustMatch(t *testing.T) {
	// A field labeled "PAN" but with a 12-cell grid (genuinely
	// surprising — maybe a misclassified detection) shouldn't get
	// PAN-coerced to 10 chars; we'd be forcing the user into a
	// pattern that's measurably wrong. The cellCount gate exists
	// exactly for this safety case.
	p := textProposal("PAN Number", map[string]interface{}{"maxLength": 12})
	applySemantics(p)
	if _, has := p.Props["pattern"]; has {
		t.Fatalf("PAN rule should not fire when cellCount != 10; props=%v", p.Props)
	}
}

func TestApplySemantics_Aadhaar(t *testing.T) {
	p := textProposal("Aadhaar Number", map[string]interface{}{"maxLength": 12})
	applySemantics(p)
	if p.Props["pattern"] != "[0-9]{12}" {
		t.Errorf("pattern = %v", p.Props["pattern"])
	}
	if p.Props["inputMode"] != "numeric" {
		t.Errorf("inputMode = %v", p.Props["inputMode"])
	}
}

func TestApplySemantics_CKYC(t *testing.T) {
	p := textProposal("CKYC Number", map[string]interface{}{"maxLength": 14})
	applySemantics(p)
	if p.Props["pattern"] != "[0-9]{14}" {
		t.Fatalf("CKYC pattern not applied: %v", p.Props)
	}
}

func TestApplySemantics_LEI(t *testing.T) {
	p := textProposal("Legal Entity Identifier", map[string]interface{}{"maxLength": 20})
	applySemantics(p)
	if p.Props["pattern"] != "[A-Z0-9]{20}" {
		t.Fatalf("LEI pattern not applied: %v", p.Props)
	}
	if p.Props["uppercase"] != true {
		t.Errorf("LEI should set uppercase=true")
	}
}

func TestApplySemantics_GSTIN(t *testing.T) {
	p := textProposal("GSTIN", map[string]interface{}{"maxLength": 15})
	applySemantics(p)
	if p.Props["uppercase"] != true {
		t.Errorf("GSTIN should set uppercase=true; props=%v", p.Props)
	}
}

func TestApplySemantics_IFSC(t *testing.T) {
	p := textProposal("IFSC Code", map[string]interface{}{"maxLength": 11})
	applySemantics(p)
	if p.Props["pattern"] != "[A-Z]{4}0[A-Z0-9]{6}" {
		t.Fatalf("IFSC pattern not applied: %v", p.Props)
	}
}

func TestApplySemantics_Pincode(t *testing.T) {
	// Pincode is label-driven (cellCount unconstrained) because Indian
	// pincodes appear in both grid and underline form.
	p := textProposal("PIN Code", nil)
	applySemantics(p)
	if p.Props["pattern"] != "[0-9]{6}" {
		t.Fatalf("pincode pattern not applied: %v", p.Props)
	}
	if p.Props["maxLength"] != 6 {
		t.Errorf("pincode maxLength = %v", p.Props["maxLength"])
	}
}

func TestApplySemantics_DateExplicit(t *testing.T) {
	// Explicit "DDMMYYYY" hint in the label fires the date_explicit
	// rule even with no cell count.
	p := textProposal("Date of Issue (DDMMYYYY)", nil)
	applySemantics(p)
	if p.Props["placeholder"] != "DDMMYYYY" {
		t.Fatalf("date placeholder not applied: %v", p.Props)
	}
}

func TestApplySemantics_DateInferred(t *testing.T) {
	// 8-cell grid plus a date-ish word triggers the inferred branch.
	p := textProposal("Date of Birth", map[string]interface{}{"maxLength": 8})
	applySemantics(p)
	if p.Props["placeholder"] != "DDMMYYYY" {
		t.Fatalf("inferred date placeholder not applied: %v", p.Props)
	}
}

func TestApplySemantics_Mobile(t *testing.T) {
	p := textProposal("Mobile Number", nil)
	applySemantics(p)
	if p.Props["pattern"] != "[0-9]{10}" {
		t.Fatalf("mobile pattern not applied: %v", p.Props)
	}
	if p.Props["inputMode"] != "tel" {
		t.Errorf("mobile inputMode = %v", p.Props["inputMode"])
	}
}

func TestApplySemantics_Mobile_NoPanelFalsePositive(t *testing.T) {
	// hasWord must NOT match "panel" against the "pan" rule, nor
	// "telephone" against a non-existent "tel" rule trigger when "tel"
	// is actually a token. Use "Solar Panel Owner" — the substring
	// "pan" is there but only as part of "panel".
	p := textProposal("Solar Panel Owner", nil)
	applySemantics(p)
	// PAN pattern would be the wrong answer here; the mobile pattern
	// likewise shouldn't fire (no mobile/phone/tel/cell tokens).
	if _, has := p.Props["pattern"]; has {
		t.Fatalf("no rule should fire for 'Solar Panel Owner', got %v", p.Props)
	}
}

func TestApplySemantics_Email(t *testing.T) {
	p := textProposal("Email Address", nil)
	applySemantics(p)
	if p.Props["inputMode"] != "email" {
		t.Fatalf("email inputMode not applied: %v", p.Props)
	}
	if _, has := p.Props["pattern"]; !has {
		t.Errorf("email rule should set a pattern")
	}
}

func TestApplySemantics_Amount(t *testing.T) {
	p := textProposal("Amount (Rs.)", nil)
	applySemantics(p)
	if p.Props["inputMode"] != "decimal" {
		t.Fatalf("amount inputMode not applied: %v", p.Props)
	}
}

func TestApplySemantics_DoesNotOverwriteExistingProps(t *testing.T) {
	// If upstream (grid pass, AcroForm /T flags, designer override)
	// already set a placeholder or pattern, the semantic patch must
	// not stomp on it. Only `uppercase` is set unconditionally because
	// it's a behaviour flag, not a value the user authored.
	p := textProposal("PAN Number", map[string]interface{}{
		"maxLength":   10,
		"placeholder": "user override",
		"pattern":     "custom",
	})
	applySemantics(p)
	if p.Props["placeholder"] != "user override" {
		t.Errorf("placeholder was overwritten: %v", p.Props["placeholder"])
	}
	if p.Props["pattern"] != "custom" {
		t.Errorf("pattern was overwritten: %v", p.Props["pattern"])
	}
}

func TestApplySemantics_FirstMatchWins(t *testing.T) {
	// "PAN aadhaar" is contrived but proves the rule loop returns on
	// first hit — PAN comes first in semanticRules so it wins, even
	// though Aadhaar would also match if we kept iterating.
	p := textProposal("PAN aadhaar", map[string]interface{}{"maxLength": 10})
	applySemantics(p)
	if p.Props["placeholder"] != "ABCDE1234F" {
		t.Fatalf("first-match should be PAN; got %v", p.Props)
	}
}

func TestApplySemantics_GridMaxLengthFloat64(t *testing.T) {
	// JSON-decoded Props arrive with float64 for numeric values. The
	// cellCount switch must accept that shape without falling through
	// to the int-only branch and treating cellCount as 0.
	p := textProposal("PAN Number", map[string]interface{}{"maxLength": float64(10)})
	applySemantics(p)
	if p.Props["pattern"] != "[A-Z]{5}[0-9]{4}[A-Z]" {
		t.Fatalf("PAN rule should fire when maxLength is float64; props=%v", p.Props)
	}
}
