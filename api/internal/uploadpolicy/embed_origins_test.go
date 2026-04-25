package uploadpolicy

import (
	"strings"
	"testing"
)

// TestValidateEmbedOriginAccepts locks the shapes the validator MUST
// permit. If a refactor later tightens the rules accidentally, an admin
// API that has been writing these values for months would start
// rejecting them — surfacing here at build time is much cheaper than
// surfacing at runtime when an org hits "save".
func TestValidateEmbedOriginAccepts(t *testing.T) {
	cases := []string{
		"https://customer.com",
		"http://localhost:3000",
		"https://app.customer.example",
		"https://customer.example:8443",
		"https://customer.com/", // trailing slash equivalent to path "/"
	}
	for _, in := range cases {
		t.Run(in, func(t *testing.T) {
			if err := ValidateEmbedOrigin(in); err != nil {
				t.Fatalf("ValidateEmbedOrigin(%q) = %v, want nil", in, err)
			}
		})
	}
}

// TestValidateEmbedOriginRejects covers the failure shapes that would
// otherwise silently break a frame-ancestors directive in production.
// Browsers parse CSP strictly: one bogus token invalidates the whole
// directive in some engines, so rejecting at write time matters.
func TestValidateEmbedOriginRejects(t *testing.T) {
	cases := map[string]string{
		"empty":          "",
		"whitespace":     "   ",
		"missing scheme": "customer.com",
		"ftp scheme":     "ftp://customer.com",
		"with path":      "https://customer.com/embed",
		"with query":     "https://customer.com?x=1",
		"with fragment":  "https://customer.com#frag",
		"with userinfo":  "https://user:pass@customer.com",
		"wildcard host":  "https://*.customer.com",
		"bare wildcard":  "*",
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			if err := ValidateEmbedOrigin(in); err == nil {
				t.Fatalf("ValidateEmbedOrigin(%q) = nil, want error", in)
			}
		})
	}
}

// TestNormalizeEmbedOrigin canonicalises case so duplicate entries
// collapse on save. The DB column is text[] without UNIQUE; relying on
// the API normaliser is the only thing keeping
// "Https://Customer.com" and "https://customer.com" from coexisting.
func TestNormalizeEmbedOrigin(t *testing.T) {
	cases := map[string]string{
		"https://Customer.com":      "https://customer.com",
		"HTTPS://APP.EXAMPLE":       "https://app.example",
		"  https://x.test  ":        "https://x.test",
		"https://x.test:8443":       "https://x.test:8443",
		"https://Customer.com/":     "https://customer.com",
		"http://LOCALHOST:3000":     "http://localhost:3000",
	}
	for in, want := range cases {
		got := NormalizeEmbedOrigin(in)
		if got != want {
			t.Errorf("NormalizeEmbedOrigin(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestBuildFrameAncestorsEmpty: empty / nil list collapses to 'self',
// matching the X-Frame-Options: SAMEORIGIN posture this directive
// replaces. A regression here would either lock everyone out (no
// 'self') or open it up (no directive at all).
func TestBuildFrameAncestorsEmpty(t *testing.T) {
	cases := [][]string{nil, {}, {""}}
	for _, in := range cases {
		got := BuildFrameAncestors(in)
		if got != "frame-ancestors 'self'" {
			t.Errorf("BuildFrameAncestors(%v) = %q, want %q", in, got, "frame-ancestors 'self'")
		}
	}
}

// TestBuildFrameAncestorsDedupe: case-folded duplicates must collapse
// so a sloppy admin entering "https://Customer.com" and
// "https://customer.com" doesn't bloat the directive (and doesn't tip
// off the customer that we're case-insensitive — keeps the surface
// minimal).
func TestBuildFrameAncestorsDedupe(t *testing.T) {
	got := BuildFrameAncestors([]string{
		"https://Customer.com",
		"https://customer.com",
		"https://other.example",
	})
	want := "frame-ancestors 'self' https://customer.com https://other.example"
	if got != want {
		t.Errorf("BuildFrameAncestors dedupe:\n  got:  %q\n  want: %q", got, want)
	}
}

// TestBuildFrameAncestorsAlwaysIncludesSelf: 'self' is non-negotiable.
// The SPA designer previews a form on its own origin, so dropping
// 'self' would break that path even when the org has populated the
// allowlist. Browsers don't auto-include 'self'.
func TestBuildFrameAncestorsAlwaysIncludesSelf(t *testing.T) {
	got := BuildFrameAncestors([]string{"https://customer.example"})
	if !strings.HasPrefix(got, "frame-ancestors 'self' ") {
		t.Errorf("BuildFrameAncestors must keep 'self' first: %q", got)
	}
}

// TestDefaultPolicyEmbedOriginsLocked: the package-level default MUST
// be nil (= no allowlist). Shipping any cross-tenant default would let
// one customer iframe another customer's branded form. This test fires
// on any change to the default, forcing a deliberate review.
func TestDefaultPolicyEmbedOriginsLocked(t *testing.T) {
	p := defaultPolicy()
	if p.EmbedAllowedOrigins != nil {
		t.Errorf("defaultPolicy().EmbedAllowedOrigins = %v, want nil (cross-tenant default would be unsafe)",
			p.EmbedAllowedOrigins)
	}
}

// TestMergeProductOrgEmbedOrigins documents the tri-state semantics for
// org-level overrides:
//
//	nil       → inherit product (test 1)
//	[]string  → explicit empty / lock-down, replaces product (test 2)
//	populated → replace product (test 3)
//
// All three are user-facing knobs an admin can hit through the API, so
// regressions here translate directly to wrong CSP headers.
func TestMergeProductOrgEmbedOrigins(t *testing.T) {
	prod := defaultPolicy()
	prod.EmbedAllowedOrigins = []string{"https://product-default.example"}

	// Case 1: nil override inherits the product list.
	got := mergeProductOrg(prod, Overrides{EmbedAllowedOrigins: nil})
	if len(got.EmbedAllowedOrigins) != 1 || got.EmbedAllowedOrigins[0] != "https://product-default.example" {
		t.Errorf("nil override should inherit product list, got %v", got.EmbedAllowedOrigins)
	}

	// Case 2: empty slice locks down (replaces, doesn't inherit).
	got = mergeProductOrg(prod, Overrides{EmbedAllowedOrigins: []string{}})
	if len(got.EmbedAllowedOrigins) != 0 {
		t.Errorf("empty override should lock down, got %v", got.EmbedAllowedOrigins)
	}

	// Case 3: populated override replaces wholesale.
	got = mergeProductOrg(prod, Overrides{EmbedAllowedOrigins: []string{"https://org-only.example"}})
	if len(got.EmbedAllowedOrigins) != 1 || got.EmbedAllowedOrigins[0] != "https://org-only.example" {
		t.Errorf("populated override should replace, got %v", got.EmbedAllowedOrigins)
	}
}
