package aidetect

import (
	"testing"

	"github.com/docforge/api/internal/aidetect/heuristic"
)

func TestParseStrategy(t *testing.T) {
	cases := map[string]Strategy{
		"":                StrategyAuto,
		"auto":            StrategyAuto,
		"AUTO":            StrategyAuto,
		"  auto  ":        StrategyAuto,
		"acroform":        StrategyAcroForm,
		"AcroForm":        StrategyAcroForm,
		"heuristic":       StrategyHeuristic,
		"vision":          StrategyVision,
		"VISION":          StrategyVision,
		"merge":           StrategyMerge,
		"MERGE":           StrategyMerge,
		"  merge  ":       StrategyMerge,
		"random-garbage":  StrategyAuto,
	}
	for raw, want := range cases {
		t.Run(raw, func(t *testing.T) {
			if got := parseStrategy(raw); got != want {
				t.Errorf("parseStrategy(%q) = %q, want %q", raw, got, want)
			}
		})
	}
}

func TestProposalsFromHeuristic_CoordinateConversion(t *testing.T) {
	// At 200 dpi a US Letter page is 1700x2200 px → 612x792 pt.
	// A box at (170, 220, 100, 30) in pixel-space, top-left origin,
	// becomes (61.2, 783-9-..., 36, 10.8) in PDF user-space,
	// bottom-left origin.
	field := heuristic.Field{
		Type:       "text",
		Page:       1,
		X:          170,
		Y:          220,
		W:          100,
		H:          30,
		PageW:      1700,
		PageH:      2200,
		Label:      "Name",
		Confidence: 0.78,
	}
	got := proposalsFromHeuristic([]heuristic.Field{field}, 200, 0)
	if len(got) != 1 {
		t.Fatalf("got %d proposals, want 1", len(got))
	}
	p := got[0]

	if p.Type != "text" {
		t.Errorf("Type = %q, want text", p.Type)
	}
	if p.Page != 1 {
		t.Errorf("Page = %d, want 1", p.Page)
	}
	if p.PageW != 612 || p.PageH != 792 {
		t.Errorf("PageW/H = %v/%v, want 612/792", p.PageW, p.PageH)
	}
	// X = 170 px * 72/200 = 61.2 pt
	if p.X != 61.2 {
		t.Errorf("X = %v, want 61.2", p.X)
	}
	// W = 100 px * 0.36 = 36
	if p.W != 36 {
		t.Errorf("W = %v, want 36", p.W)
	}
	// H = 30 px * 0.36 = 10.8
	if p.H != 10.8 {
		t.Errorf("H = %v, want 10.8", p.H)
	}
	// Y = 792 - (220+30)*0.36 = 792 - 90 = 702
	if p.Y != 702 {
		t.Errorf("Y = %v, want 702 (origin flipped to bottom-left)", p.Y)
	}
	if p.Source != "heuristic" {
		t.Errorf("Source = %q, want heuristic", p.Source)
	}
	if p.Confidence != 0.78 {
		t.Errorf("Confidence = %v, want 0.78", p.Confidence)
	}
	// Polish pass slugifies labels into snake_case lowercase keys —
	// "Name" → "name", "Full Name" → "full_name", etc. The casing
	// change is intentional: integrators get one consistent key shape
	// across all three cascade tiers regardless of how the source
	// PDF was authored.
	if p.DataKey != "name" {
		t.Errorf("DataKey = %q, want name (post-polish slug)", p.DataKey)
	}
}

func TestProposalsFromHeuristic_DPIDefault(t *testing.T) {
	// dpi <= 0 should fall back to 200 (sidecar default).
	field := heuristic.Field{
		Type: "text", Page: 1,
		X: 200, Y: 100, W: 200, H: 20,
		PageW: 1700, PageH: 2200,
		Label: "X", Confidence: 0.5,
	}
	got := proposalsFromHeuristic([]heuristic.Field{field}, 0, 0)
	if len(got) != 1 {
		t.Fatalf("got %d, want 1", len(got))
	}
	if got[0].PageW != 612 {
		t.Errorf("PageW = %v, want 612 (default 200dpi assumed)", got[0].PageW)
	}
}

func TestProposalsFromHeuristic_DataKeyFallback(t *testing.T) {
	// Empty Label → synthetic data key "field_N".
	fields := []heuristic.Field{
		{Type: "text", Page: 1, PageW: 1700, PageH: 2200, X: 100, Y: 100, W: 200, H: 20, Label: ""},
		{Type: "text", Page: 1, PageW: 1700, PageH: 2200, X: 100, Y: 200, W: 200, H: 20, Label: ""},
	}
	got := proposalsFromHeuristic(fields, 200, 0)
	if got[0].DataKey != "field_1" {
		t.Errorf("first DataKey = %q, want field_1", got[0].DataKey)
	}
	if got[1].DataKey != "field_2" {
		t.Errorf("second DataKey = %q, want field_2", got[1].DataKey)
	}
	if got[0].Label != "field_1" {
		t.Errorf("first Label = %q, want field_1 (mirrored from key when empty)", got[0].Label)
	}
}

func TestProposalsFromHeuristic_DataKeyOffset(t *testing.T) {
	// idxOffset lets the cascade orchestrator continue numbering past
	// the AcroForm-named fields so synthetic keys don't collide.
	fields := []heuristic.Field{
		{Type: "text", Page: 1, PageW: 1700, PageH: 2200, X: 100, Y: 100, W: 200, H: 20, Label: ""},
	}
	got := proposalsFromHeuristic(fields, 200, 5) // pretend AcroForm gave 5
	if got[0].DataKey != "field_6" {
		t.Errorf("DataKey = %q, want field_6 (offset by 5)", got[0].DataKey)
	}
}

func TestProposalsFromHeuristic_EmptyInput(t *testing.T) {
	if got := proposalsFromHeuristic(nil, 200, 0); len(got) != 0 {
		t.Errorf("nil input → %d proposals, want 0", len(got))
	}
	if got := proposalsFromHeuristic([]heuristic.Field{}, 200, 0); len(got) != 0 {
		t.Errorf("empty input → %d proposals, want 0", len(got))
	}
}

func TestProposalsFromHeuristic_NegativeYClamped(t *testing.T) {
	// A box that extends past the rasterized page height (rounding
	// edge case) would compute negative Y in user-space; clamp to 0
	// instead of confusing the designer.
	field := heuristic.Field{
		Type: "text", Page: 1,
		X: 100, Y: 2200, W: 100, H: 30, // Y+H > PageH
		PageW: 1700, PageH: 2200,
		Label: "Edge",
	}
	got := proposalsFromHeuristic([]heuristic.Field{field}, 200, 0)
	if got[0].Y < 0 {
		t.Errorf("Y = %v, want clamped to >= 0", got[0].Y)
	}
}

func TestProposalsFromHeuristic_PropsByType(t *testing.T) {
	cases := []struct {
		typ              string
		wantFontFamily   bool
		wantNoFontFamily bool
	}{
		{typ: "text", wantFontFamily: true},
		{typ: "signature", wantFontFamily: true},
		{typ: "checkbox", wantNoFontFamily: true},
		{typ: "radio", wantNoFontFamily: true},
	}
	for _, tc := range cases {
		t.Run(tc.typ, func(t *testing.T) {
			f := heuristic.Field{
				Type: tc.typ, Page: 1, PageW: 1700, PageH: 2200,
				X: 100, Y: 100, W: 50, H: 20, Label: "x",
			}
			got := proposalsFromHeuristic([]heuristic.Field{f}, 200, 0)
			_, hasFont := got[0].Props["fontFamily"]
			if tc.wantFontFamily && !hasFont {
				t.Errorf("type=%s missing fontFamily prop", tc.typ)
			}
			if tc.wantNoFontFamily && hasFont {
				t.Errorf("type=%s should NOT have fontFamily prop", tc.typ)
			}
		})
	}
}
