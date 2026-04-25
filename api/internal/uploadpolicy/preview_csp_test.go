package uploadpolicy

import (
	"strings"
	"testing"
)

// TestDefaultPolicyHasPreviewKnobs locks the package-level defaults for
// the new CSP + iframe-sandbox controls. defaultPolicy() backs the
// "migration hasn't seeded" fallback path in loadProduct, so an
// accidental empty CSP here would silently open up every preview
// rendered before the DB catches up.
func TestDefaultPolicyHasPreviewKnobs(t *testing.T) {
	p := defaultPolicy()
	if p.PreviewCSP == "" {
		t.Fatal("defaultPolicy().PreviewCSP is empty — fallback would serve previews with no CSP")
	}
	if p.PreviewCSP != DefaultPreviewCSP {
		t.Fatalf("defaultPolicy().PreviewCSP = %q, want package constant %q", p.PreviewCSP, DefaultPreviewCSP)
	}
	if p.PreviewIframeSandbox != DefaultPreviewIframeSandbox {
		t.Fatalf("defaultPolicy().PreviewIframeSandbox = %q, want package constant %q",
			p.PreviewIframeSandbox, DefaultPreviewIframeSandbox)
	}
	// Sanity: the default CSP MUST forbid scripts. If anyone ever loosens
	// this, we want the test to fire.
	for _, want := range []string{"default-src 'none'", "sandbox"} {
		if !strings.Contains(p.PreviewCSP, want) {
			t.Errorf("default CSP missing required directive %q: %q", want, p.PreviewCSP)
		}
	}
	if strings.Contains(p.PreviewCSP, "script-src") {
		t.Errorf("default CSP must not declare a script-src — default-src 'none' should leave scripts unset (and therefore denied): %q", p.PreviewCSP)
	}
}

// TestMergePreviewCSPOverrides confirms the layered-policy resolver
// honours the org's override of the new knobs and falls back to product
// defaults when the override is nil.
func TestMergePreviewCSPOverrides(t *testing.T) {
	prod := Policy{
		PreviewCSP:           "default-src 'none'",
		PreviewIframeSandbox: "",
	}
	// nil overrides → inherit
	got := mergeProductOrg(prod, Overrides{})
	if got.PreviewCSP != prod.PreviewCSP {
		t.Errorf("nil PreviewCSP override: got %q, want inherit %q", got.PreviewCSP, prod.PreviewCSP)
	}
	if got.PreviewIframeSandbox != prod.PreviewIframeSandbox {
		t.Errorf("nil PreviewIframeSandbox override: got %q, want inherit %q",
			got.PreviewIframeSandbox, prod.PreviewIframeSandbox)
	}

	// Explicit override wins.
	csp := "default-src 'self'"
	sb := "allow-scripts allow-forms"
	got = mergeProductOrg(prod, Overrides{
		PreviewCSP:           &csp,
		PreviewIframeSandbox: &sb,
	})
	if got.PreviewCSP != csp {
		t.Errorf("explicit PreviewCSP override: got %q, want %q", got.PreviewCSP, csp)
	}
	if got.PreviewIframeSandbox != sb {
		t.Errorf("explicit PreviewIframeSandbox override: got %q, want %q", got.PreviewIframeSandbox, sb)
	}

	// Empty-string override is a meaningful value (means "max-isolation
	// sandbox" for the iframe attribute) — must be honoured, not treated
	// as nil.
	empty := ""
	got = mergeProductOrg(Policy{PreviewIframeSandbox: "allow-scripts"}, Overrides{
		PreviewIframeSandbox: &empty,
	})
	if got.PreviewIframeSandbox != "" {
		t.Errorf("empty-string override must override product value: got %q", got.PreviewIframeSandbox)
	}
}

// TestDefaultPolicyHasPDFHardening locks the secure-by-default posture
// for the new PDF structural scanner. If anyone toggles the default
// off, every deploy that hasn't run the migration loses protection
// until an admin opts back in — the test fires before that lands.
func TestDefaultPolicyHasPDFHardening(t *testing.T) {
	p := defaultPolicy()
	if !p.PdfHardenEnabled {
		t.Fatal("defaultPolicy().PdfHardenEnabled is false — uploads ship without structural scanning")
	}
	if len(p.PdfBlockedFeatures) == 0 {
		t.Fatal("defaultPolicy().PdfBlockedFeatures is empty — hardening enabled but report-only")
	}
	// Audit's marquee threats MUST be blocked by default.
	want := map[string]bool{
		"javascript":       false,
		"launch":           false,
		"embedded_file":    false,
		"external_xobject": false,
	}
	for _, f := range p.PdfBlockedFeatures {
		if _, ok := want[f]; ok {
			want[f] = true
		}
	}
	for k, present := range want {
		if !present {
			t.Errorf("default PdfBlockedFeatures missing %q — audit-listed threat unblocked", k)
		}
	}
}

// TestMergePDFHardeningOverrides covers the inherit / explicit-override
// distinction at the Overrides layer. The PdfBlockedFeatures field has
// a tri-state semantic: nil = inherit, empty = report-only, populated =
// replace; the merge logic must honour all three.
func TestMergePDFHardeningOverrides(t *testing.T) {
	prod := Policy{
		PdfHardenEnabled:   true,
		PdfBlockedFeatures: []string{"javascript", "launch"},
	}

	// nil overrides → inherit
	got := mergeProductOrg(prod, Overrides{})
	if !got.PdfHardenEnabled {
		t.Error("nil PdfHardenEnabled should inherit (true) from product")
	}
	if len(got.PdfBlockedFeatures) != 2 {
		t.Errorf("nil PdfBlockedFeatures should inherit, got %v", got.PdfBlockedFeatures)
	}

	// Explicit false override turns hardening off.
	off := false
	got = mergeProductOrg(prod, Overrides{PdfHardenEnabled: &off})
	if got.PdfHardenEnabled {
		t.Error("explicit PdfHardenEnabled=false override ignored")
	}

	// Explicit empty slice = report-only; must NOT collapse back to
	// inherit (that would silently re-enable blocking).
	got = mergeProductOrg(prod, Overrides{PdfBlockedFeatures: []string{}})
	if len(got.PdfBlockedFeatures) != 0 {
		t.Errorf("explicit empty PdfBlockedFeatures must produce report-only mode, got %v",
			got.PdfBlockedFeatures)
	}

	// Replacement list wholesale-replaces the product value.
	got = mergeProductOrg(prod, Overrides{PdfBlockedFeatures: []string{"embedded_file"}})
	if len(got.PdfBlockedFeatures) != 1 || got.PdfBlockedFeatures[0] != "embedded_file" {
		t.Errorf("explicit PdfBlockedFeatures override should replace, got %v",
			got.PdfBlockedFeatures)
	}
}
