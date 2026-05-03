package aidetect

import (
	"math"
	"testing"
)

// TestBoxIoU covers the math primitive every merge decision rests on.
// Each case names the spatial relationship being tested so a future
// change to the IoU formula is caught with the failing case naming
// the regression.
func TestBoxIoU(t *testing.T) {
	cases := []struct {
		name                                   string
		x1, y1, w1, h1, x2, y2, w2, h2, wantIoU float64
	}{
		{"identical boxes", 10, 10, 100, 50, 10, 10, 100, 50, 1.0},
		{"no overlap (disjoint x)", 0, 0, 50, 50, 100, 0, 50, 50, 0.0},
		{"no overlap (disjoint y)", 0, 0, 50, 50, 0, 100, 50, 50, 0.0},
		{"touching edges (zero-width intersection)", 0, 0, 50, 50, 50, 0, 50, 50, 0.0},
		// b inside a: intersection = 25*25 = 625; union = 100*100 = 10000;
		// IoU = 625/10000 = 0.0625
		{"contained box", 0, 0, 100, 100, 25, 25, 25, 25, 0.0625},
		// half-overlap horizontally: a=[0,0,100,50], b=[50,0,100,50]
		// intersection = 50*50 = 2500; union = 5000+5000-2500 = 7500;
		// IoU = 2500/7500 = 0.333...
		{"half horizontal overlap", 0, 0, 100, 50, 50, 0, 100, 50, 1.0 / 3.0},
		{"zero-area first box", 10, 10, 0, 50, 10, 10, 100, 50, 0.0},
		{"negative-w second box", 10, 10, 100, 50, 10, 10, -10, 50, 0.0},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := boxIoU(tc.x1, tc.y1, tc.w1, tc.h1, tc.x2, tc.y2, tc.w2, tc.h2)
			if math.Abs(got-tc.wantIoU) > 1e-6 {
				t.Errorf("boxIoU = %v, want %v", got, tc.wantIoU)
			}
		})
	}
}

// TestMergeProposals_OverlappingFieldsCollapse covers the headline
// case: heuristic and vision both detect the same field. The merge
// keeps one survivor stamped Source="merged" with the higher
// confidence — NOT two duplicate proposals.
func TestMergeProposals_OverlappingFieldsCollapse(t *testing.T) {
	heur := []Proposal{
		{Page: 1, Label: "Name", DataKey: "name", X: 100, Y: 200, W: 200, H: 20,
			Source: "heuristic", Confidence: 0.7},
	}
	vis := []Proposal{
		// Same field, slightly shifted (typical of vision-LLM coord
		// estimation). IoU = (180*18) / (200*20 + 200*20 - 180*18) ≈ 0.86,
		// well above the 0.40 threshold.
		{Page: 1, Label: "Full Name", DataKey: "full_name", X: 110, Y: 202, W: 190, H: 18,
			Source: "vision", Confidence: 0.85},
	}
	got := mergeProposals(heur, vis)
	if len(got) != 1 {
		t.Fatalf("merge produced %d proposals, want 1: %+v", len(got), got)
	}
	if got[0].Source != "merged" {
		t.Errorf("Source = %q, want \"merged\"", got[0].Source)
	}
	if got[0].Confidence != 0.85 {
		t.Errorf("Confidence = %v, want 0.85 (max of inputs)", got[0].Confidence)
	}
	// Primary's coords win — heuristic's are typically OCR-anchored
	// and tighter than vision's estimates.
	if got[0].X != 100 || got[0].W != 200 {
		t.Errorf("coords lost from primary: X=%v W=%v want X=100 W=200", got[0].X, got[0].W)
	}
}

// TestMergeProposals_DisjointFieldsAdd ensures vision-only fields
// (the recall lift the merge exists for — character grids, table
// cells, empty boxes) come through as additions, not lost.
func TestMergeProposals_DisjointFieldsAdd(t *testing.T) {
	heur := []Proposal{
		{Page: 1, Label: "Name", DataKey: "name", X: 100, Y: 200, W: 200, H: 20,
			Source: "heuristic", Confidence: 0.7},
	}
	vis := []Proposal{
		// Different region entirely — a PAN character grid heuristic
		// can't see (no glyphs for OCR to detect inside the empty boxes).
		{Page: 1, Label: "PAN", DataKey: "pan", X: 100, Y: 400, W: 300, H: 30,
			Source: "vision", Confidence: 0.8},
	}
	got := mergeProposals(heur, vis)
	if len(got) != 2 {
		t.Fatalf("merge produced %d proposals, want 2: %+v", len(got), got)
	}
	// Both should keep their original Source — neither was confirmed
	// by the other tier.
	gotSources := map[string]int{}
	for _, p := range got {
		gotSources[p.Source]++
	}
	if gotSources["heuristic"] != 1 || gotSources["vision"] != 1 {
		t.Errorf("source mix wrong: %+v", gotSources)
	}
}

// TestMergeProposals_DifferentPagesNeverMerge guards the page-scope
// of IoU comparison. Two boxes with identical coordinates on
// different pages must NOT be treated as the same field — they're
// independent fields that happen to be at the same x/y.
func TestMergeProposals_DifferentPagesNeverMerge(t *testing.T) {
	heur := []Proposal{
		{Page: 1, Label: "Sig", DataKey: "sig", X: 100, Y: 600, W: 200, H: 30,
			Source: "heuristic", Confidence: 0.8},
	}
	vis := []Proposal{
		{Page: 2, Label: "Sig", DataKey: "sig", X: 100, Y: 600, W: 200, H: 30,
			Source: "vision", Confidence: 0.8},
	}
	got := mergeProposals(heur, vis)
	if len(got) != 2 {
		t.Fatalf("merge produced %d proposals, want 2 (different pages): %+v", len(got), got)
	}
	// Polish should disambiguate the duplicate "sig" key with a page
	// suffix — we get this for free from polishProposals being the
	// last step of mergeProposals.
	if got[0].DataKey == got[1].DataKey {
		t.Errorf("DataKeys collided across pages: both = %q", got[0].DataKey)
	}
}

// TestMergeProposals_TypeOpinionFromHigherConfidence covers the
// disagreement case: heuristic says "text" with low conf, vision
// says "checkbox" with high conf. The higher-confidence side's type
// wins — heuristic mistaking a checkbox for a tiny text field is
// a real failure mode the merge corrects.
func TestMergeProposals_TypeOpinionFromHigherConfidence(t *testing.T) {
	heur := []Proposal{
		{Page: 1, Label: "Agree", Type: "text", X: 100, Y: 200, W: 20, H: 20,
			Source: "heuristic", Confidence: 0.5},
	}
	vis := []Proposal{
		{Page: 1, Label: "Agree", Type: "checkbox", X: 100, Y: 200, W: 20, H: 20,
			Source: "vision", Confidence: 0.9},
	}
	got := mergeProposals(heur, vis)
	if len(got) != 1 {
		t.Fatalf("merge produced %d proposals, want 1: %+v", len(got), got)
	}
	if got[0].Type != "checkbox" {
		t.Errorf("Type = %q, want \"checkbox\" (vision had higher conf)", got[0].Type)
	}
}

// TestMergeProposals_LabelInheritedWhenPrimaryEmpty exercises the
// label-promotion rule: if heuristic detected a bare underline (no
// nearby label text → empty Label) and vision found one with the
// same region AND has a label, take vision's. Otherwise the modal
// shows "field_3" instead of "Father's Name", which is precisely
// what the polish pass is designed to avoid.
func TestMergeProposals_LabelInheritedWhenPrimaryEmpty(t *testing.T) {
	heur := []Proposal{
		{Page: 1, Label: "", DataKey: "field_1", X: 100, Y: 200, W: 200, H: 20,
			Source: "heuristic", Confidence: 0.55},
	}
	vis := []Proposal{
		{Page: 1, Label: "Father's Name", DataKey: "fathers_name", X: 100, Y: 200, W: 200, H: 20,
			Source: "vision", Confidence: 0.7},
	}
	got := mergeProposals(heur, vis)
	if len(got) != 1 {
		t.Fatalf("merge produced %d proposals, want 1: %+v", len(got), got)
	}
	if got[0].Label != "Father's Name" {
		t.Errorf("Label = %q, want \"Father's Name\" (vision filled in for empty primary)", got[0].Label)
	}
	// Polish re-derives DataKey from the inherited Label.
	if got[0].DataKey != "fathers_name" {
		t.Errorf("DataKey = %q, want \"fathers_name\" (re-slugged from inherited label)", got[0].DataKey)
	}
}

// TestMergeProposals_EmptySides verifies the boundary cases where
// one tier returned nothing. Polish still runs so the surviving
// tier's keys are normalised consistently.
func TestMergeProposals_EmptySides(t *testing.T) {
	heur := []Proposal{
		{Page: 1, Label: "Name", X: 100, Y: 200, W: 200, H: 20,
			Source: "heuristic", Confidence: 0.7},
	}
	got := mergeProposals(heur, nil)
	if len(got) != 1 || got[0].DataKey != "name" {
		t.Errorf("heur+nil merge wrong: %+v", got)
	}
	got = mergeProposals(nil, heur)
	if len(got) != 1 || got[0].DataKey != "name" {
		t.Errorf("nil+heur merge wrong: %+v", got)
	}
	got = mergeProposals(nil, nil)
	if len(got) != 0 {
		t.Errorf("nil+nil merge should produce empty result, got %+v", got)
	}
}

// TestMergeProposals_SortByPageThenPosition guards the post-merge
// ordering invariant the modal relies on for "renders in reading
// order". Without this, a vision-detected field at the top of page
// 1 could sort after a heuristic-detected field at the bottom of
// page 1, breaking the user's mental model of "fields appear top-
// to-bottom".
func TestMergeProposals_SortByPageThenPosition(t *testing.T) {
	heur := []Proposal{
		{Page: 1, Label: "Bottom", X: 100, Y: 700, W: 100, H: 20,
			Source: "heuristic", Confidence: 0.7},
	}
	vis := []Proposal{
		{Page: 1, Label: "Top", X: 100, Y: 100, W: 100, H: 20,
			Source: "vision", Confidence: 0.8},
		{Page: 2, Label: "Page Two", X: 100, Y: 100, W: 100, H: 20,
			Source: "vision", Confidence: 0.8},
	}
	got := mergeProposals(heur, vis)
	if len(got) != 3 {
		t.Fatalf("got %d proposals, want 3", len(got))
	}
	wantOrder := []string{"Top", "Bottom", "Page Two"}
	for i, p := range got {
		if p.Label != wantOrder[i] {
			t.Errorf("[%d] Label = %q, want %q (full order: %v)",
				i, p.Label, wantOrder[i], proposalLabels(got))
		}
	}
}

func proposalLabels(props []Proposal) []string {
	out := make([]string, len(props))
	for i, p := range props {
		out[i] = p.Label
	}
	return out
}
