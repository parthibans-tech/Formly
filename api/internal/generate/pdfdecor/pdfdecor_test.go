package pdfdecor

// Unit tests for the pure helpers (placeholder resolution, page
// selector parsing, color conversion). The end-to-end "stamp a real
// PDF" path is covered implicitly by the runner's integration tests —
// pulling pdfcpu into a unit test would mean fabricating a valid PDF
// in-memory, which is what the runner already does.

import (
	"reflect"
	"testing"
)

func TestResolvePlaceholders(t *testing.T) {
	data := map[string]interface{}{
		"customerName": "Acme Corp",
		"invoiceNum":   42,
	}
	cases := []struct {
		in           string
		page, total  int
		wantContains string // RFC3339 timestamps make full equality fragile
		wantExact    string
	}{
		{in: "Hello {{customerName}}", wantExact: "Hello Acme Corp"},
		{in: "Invoice #{{invoiceNum}}", wantExact: "Invoice #42"},
		{in: "Page {{page}} of {{pages}}", page: 3, total: 7, wantExact: "Page 3 of 7"},
		{in: "Missing {{nope}} here", wantExact: "Missing  here"},
		{in: "no placeholders", wantExact: "no placeholders"},
	}
	for _, c := range cases {
		got := resolvePlaceholders(c.in, data, c.page, c.total)
		if c.wantExact != "" && got != c.wantExact {
			t.Errorf("resolvePlaceholders(%q) = %q, want %q", c.in, got, c.wantExact)
		}
	}
}

func TestHasPagePlaceholder(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"Page {{page}} of {{pages}}", true},
		{"Page {{ page }} of {{ pages }}", true},
		{"Static title", false},
		{"{{customerName}} only", false},
	}
	for _, c := range cases {
		if got := hasPagePlaceholder(c.in); got != c.want {
			t.Errorf("hasPagePlaceholder(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestNormalizePageSelector(t *testing.T) {
	cases := []struct {
		in        string
		pageCount int
		want      []string
	}{
		{"", 5, nil},
		{"all", 5, nil},
		{"first", 5, []string{"1"}},
		{"last", 5, []string{"5"}},
		{"1,3-5", 10, []string{"1", "3-5"}},
	}
	for _, c := range cases {
		got, err := normalizePageSelector(c.in, c.pageCount)
		if err != nil {
			t.Errorf("normalizePageSelector(%q) error: %v", c.in, err)
			continue
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("normalizePageSelector(%q) = %#v, want %#v", c.in, got, c.want)
		}
	}
}

func TestExpandPageSelector(t *testing.T) {
	cases := []struct {
		sel       []string
		pageCount int
		want      []int
	}{
		{nil, 3, []int{1, 2, 3}},
		{[]string{"2"}, 5, []int{2}},
		{[]string{"1", "3-5"}, 10, []int{1, 3, 4, 5}},
		{[]string{"2-"}, 4, []int{2, 3, 4}},
		{[]string{"1", "1", "2"}, 5, []int{1, 2}}, // dedupe
		{[]string{"99"}, 3, nil},                  // out of range silently dropped
	}
	for _, c := range cases {
		got, err := expandPageSelector(c.sel, c.pageCount)
		if err != nil {
			t.Errorf("expandPageSelector(%v) error: %v", c.sel, err)
			continue
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("expandPageSelector(%v, %d) = %v, want %v", c.sel, c.pageCount, got, c.want)
		}
	}
}

func TestHexToPDFColor(t *testing.T) {
	cases := []struct {
		hex, fallback, want string
	}{
		{"#000000", "#888888", "0.000 0.000 0.000"},
		{"#FFFFFF", "#888888", "1.000 1.000 1.000"},
		{"#888888", "#000000", "0.533 0.533 0.533"},
		{"", "#888888", "0.533 0.533 0.533"},      // empty → fallback
		{"not-a-color", "#888888", "0.533 0.533 0.533"}, // garbage → fallback
	}
	for _, c := range cases {
		got := hexToPDFColor(c.hex, c.fallback)
		if got != c.want {
			t.Errorf("hexToPDFColor(%q, %q) = %q, want %q", c.hex, c.fallback, got, c.want)
		}
	}
}

func TestConfigIsEnabled(t *testing.T) {
	if (Config{}).IsEnabled() {
		t.Error("empty config should not be enabled")
	}
	if !(Config{Watermark: &Watermark{Text: "DRAFT"}}).IsEnabled() {
		t.Error("watermark with text should be enabled")
	}
	if (Config{Watermark: &Watermark{}}).IsEnabled() {
		t.Error("watermark without text or imageFileId should not be enabled")
	}
	if !(Config{Header: &HeaderFooter{Center: "Title"}}).IsEnabled() {
		t.Error("header with text should be enabled")
	}
	if (Config{Header: &HeaderFooter{}}).IsEnabled() {
		t.Error("empty header should not be enabled")
	}
}

func TestApplyNoOpWhenDisabled(t *testing.T) {
	in := []byte("not actually a PDF, but we should never look at this")
	out, err := Apply(in, Config{}, nil)
	if err != nil {
		t.Fatalf("Apply(disabled) error: %v", err)
	}
	if &out[0] != &in[0] {
		// We return the input slice header unchanged — same backing array.
		t.Error("Apply(disabled) should return the input slice unchanged")
	}
}

func TestApplyRejectsImageWatermark(t *testing.T) {
	// We intentionally surface a clear error rather than silently
	// ignoring imageFileId — see package doc on the v1/v2 split.
	in := []byte("%PDF-1.4\n%%EOF") // shape doesn't matter; we error before pdfcpu sees it
	cfg := Config{Watermark: &Watermark{ImageFileID: "drive:abc"}}
	_, err := Apply(in, cfg, nil)
	if err == nil {
		t.Fatal("expected error for image watermark, got nil")
	}
}
