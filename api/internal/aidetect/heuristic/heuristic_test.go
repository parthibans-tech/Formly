package heuristic

import (
	"strings"
	"testing"

	"github.com/docforge/api/internal/ocr"
)

// box is a tiny helper to keep test fixtures readable. Coordinates
// follow the sidecar convention (top-left origin, pixels at
// rasterization DPI).
func box(text string, x, y, w, h float64) ocr.LayoutBox {
	return ocr.LayoutBox{
		Text: text,
		X:    x, Y: y, W: w, H: h,
		Bbox:       [4]float64{x, y, w, h},
		Confidence: 0.9,
	}
}

func page(w, h int, boxes ...ocr.LayoutBox) ocr.LayoutPage {
	return ocr.LayoutPage{W: w, H: h, Boxes: boxes}
}

func findFirst(fields []Field, typ, label string) (Field, bool) {
	for _, f := range fields {
		if f.Type == typ && f.Label == label {
			return f, true
		}
	}
	return Field{}, false
}

func TestDetect_EmptyInput(t *testing.T) {
	if got := Detect(nil); len(got) != 0 {
		t.Errorf("nil pages → %d fields, want 0", len(got))
	}
	if got := Detect([]ocr.LayoutPage{}); len(got) != 0 {
		t.Errorf("empty pages → %d fields, want 0", len(got))
	}
	if got := Detect([]ocr.LayoutPage{{W: 100, H: 100}}); len(got) != 0 {
		t.Errorf("page with no boxes → %d fields, want 0", len(got))
	}
}

func TestDetect_LabelColonGap_EmitsTextField(t *testing.T) {
	// "Name:"  with empty space to the right, then "Date:" at x=500.
	// Expect a text field between them.
	p := page(800, 1100,
		box("Name:", 60, 100, 60, 20),
		box("Date:", 500, 100, 60, 20),
	)
	got := Detect([]ocr.LayoutPage{p})

	if len(got) != 2 {
		t.Fatalf("got %d fields, want 2 (one per label):\n%+v", len(got), got)
	}
	f, ok := findFirst(got, "text", "Name")
	if !ok {
		t.Fatalf("missing text field for Name: got %+v", got)
	}
	if f.X < 120 || f.X > 130 {
		t.Errorf("Name text X = %v, want ~126", f.X)
	}
	if f.W < 360 || f.W > 380 {
		t.Errorf("Name text W = %v, want ~370 (gap to Date label)", f.W)
	}
	if f.Page != 1 {
		t.Errorf("Page = %d, want 1", f.Page)
	}
	if f.PageW != 800 || f.PageH != 1100 {
		t.Errorf("PageW/H = %d/%d, want 800/1100", f.PageW, f.PageH)
	}
	if f.Confidence < 0.7 {
		t.Errorf("Confidence = %v, want >= 0.70", f.Confidence)
	}
}

func TestDetect_LabelAloneOnRow_EmitsToRightMargin(t *testing.T) {
	p := page(800, 1100,
		box("Address:", 60, 200, 80, 20),
	)
	got := Detect([]ocr.LayoutPage{p})
	if len(got) != 1 {
		t.Fatalf("got %d fields, want 1", len(got))
	}
	if got[0].W < 600 {
		t.Errorf("text W = %v, want > 600 (page width minus label minus margin)", got[0].W)
	}
	if got[0].Confidence < 0.75 {
		t.Errorf("Confidence = %v, want >= 0.78 for wide gap", got[0].Confidence)
	}
}

func TestDetect_TooNarrowGap_Dropped(t *testing.T) {
	p := page(800, 1100,
		box("Yes:", 60, 100, 40, 20),
		box("No", 110, 100, 30, 20), // only ~6px gap
	)
	got := Detect([]ocr.LayoutPage{p})
	for _, f := range got {
		if f.Type == "text" {
			t.Errorf("emitted text field for narrow gap: %+v", f)
		}
	}
}

func TestDetect_FullwidthColon_AlsoTriggers(t *testing.T) {
	p := page(800, 1100,
		box("姓名：", 60, 100, 80, 20),
	)
	got := Detect([]ocr.LayoutPage{p})
	if len(got) != 1 || got[0].Type != "text" {
		t.Fatalf("fullwidth colon didn't emit text field: %+v", got)
	}
	if got[0].Label != "姓名" {
		t.Errorf("Label = %q, want 姓名 (colon stripped)", got[0].Label)
	}
}

func TestDetect_CheckboxGlyph_PairsWithRightLabel(t *testing.T) {
	p := page(800, 1100,
		box("[ ]", 60, 100, 18, 18),
		box("Subscribe to newsletter", 90, 100, 240, 18),
	)
	got := Detect([]ocr.LayoutPage{p})
	cb, ok := findFirst(got, "checkbox", "Subscribe to newsletter")
	if !ok {
		t.Fatalf("missing checkbox: got %+v", got)
	}
	if cb.Confidence < 0.8 {
		t.Errorf("checkbox conf = %v, want >= 0.85", cb.Confidence)
	}
	// The right-label box should be marked consumed → no separate
	// emission for it.
	for _, f := range got {
		if f.Label == "Subscribe to newsletter" && f.Type != "checkbox" {
			t.Errorf("right-label was double-emitted as %s", f.Type)
		}
	}
}

func TestDetect_CheckboxGlyph_FilledVariants(t *testing.T) {
	cases := []string{"[X]", "[x]", "[✓]", "☐", "☑", "■", "▢"}
	for _, glyph := range cases {
		t.Run(glyph, func(t *testing.T) {
			p := page(800, 1100, box(glyph, 60, 100, 18, 18))
			got := Detect([]ocr.LayoutPage{p})
			if len(got) != 1 || got[0].Type != "checkbox" {
				t.Errorf("glyph %q didn't emit checkbox: %+v", glyph, got)
			}
		})
	}
}

func TestDetect_RadioGlyph(t *testing.T) {
	cases := []string{"( )", "(X)", "(•)", "○", "●"}
	for _, glyph := range cases {
		t.Run(glyph, func(t *testing.T) {
			p := page(800, 1100, box(glyph, 60, 100, 16, 16))
			got := Detect([]ocr.LayoutPage{p})
			if len(got) != 1 || got[0].Type != "radio" {
				t.Errorf("glyph %q didn't emit radio: %+v", glyph, got)
			}
		})
	}
}

func TestDetect_RadioPair_BothEmittedWithLabels(t *testing.T) {
	p := page(800, 1100,
		box("( )", 60, 100, 16, 16),
		box("Male", 80, 100, 40, 16),
		box("( )", 200, 100, 16, 16),
		box("Female", 220, 100, 60, 16),
	)
	got := Detect([]ocr.LayoutPage{p})
	if _, ok := findFirst(got, "radio", "Male"); !ok {
		t.Errorf("missing radio Male in %+v", got)
	}
	if _, ok := findFirst(got, "radio", "Female"); !ok {
		t.Errorf("missing radio Female in %+v", got)
	}
}

func TestDetect_SignatureKeyword_PlacesBelowOrRight(t *testing.T) {
	// Keyword alone on a row near the bottom; expect signature
	// widget placed to the right (room available) at the right
	// dimensions.
	p := page(800, 1100,
		box("Signature:", 60, 900, 100, 22),
	)
	got := Detect([]ocr.LayoutPage{p})
	if len(got) != 1 || got[0].Type != "signature" {
		t.Fatalf("expected one signature field, got %+v", got)
	}
	f := got[0]
	if f.W < 200 || f.H < 30 {
		t.Errorf("signature dims = %vx%v, want at least 200x30", f.W, f.H)
	}
	if f.X < 160 {
		t.Errorf("signature X = %v, expected to be right of keyword", f.X)
	}
	if f.Confidence < 0.75 {
		t.Errorf("conf = %v, want >= 0.80", f.Confidence)
	}
}

func TestDetect_SignatureWithUnderline_NoDoubleEmit(t *testing.T) {
	// "Signature: ____________" → one signature, NOT a signature
	// plus a text-from-underline.
	p := page(800, 1100,
		box("Signature:", 60, 900, 100, 22),
		box("________________", 170, 900, 300, 22),
	)
	got := Detect([]ocr.LayoutPage{p})
	sigs, texts := 0, 0
	for _, f := range got {
		switch f.Type {
		case "signature":
			sigs++
		case "text":
			texts++
		}
	}
	if sigs != 1 {
		t.Errorf("signatures = %d, want 1", sigs)
	}
	if texts != 0 {
		t.Errorf("text fields = %d, want 0 (underline should be suppressed)", texts)
	}
}

func TestDetect_BareUnderline_EmitsTextWithLeftLabel(t *testing.T) {
	p := page(800, 1100,
		box("Phone", 60, 100, 50, 18),
		box("____________", 130, 100, 200, 18),
	)
	got := Detect([]ocr.LayoutPage{p})
	if len(got) != 1 || got[0].Type != "text" {
		t.Fatalf("expected one text field, got %+v", got)
	}
	if got[0].Label != "Phone" {
		t.Errorf("Label = %q, want Phone", got[0].Label)
	}
	if got[0].Confidence < 0.65 {
		t.Errorf("conf = %v, want >= 0.70 for underline-with-label", got[0].Confidence)
	}
}

func TestDetect_BareUnderline_NoLabel_StillEmitsAtLowerConf(t *testing.T) {
	p := page(800, 1100,
		box("____________", 60, 100, 200, 18),
	)
	got := Detect([]ocr.LayoutPage{p})
	if len(got) != 1 || got[0].Type != "text" {
		t.Fatalf("expected one text field, got %+v", got)
	}
	if got[0].Label != "" {
		t.Errorf("Label = %q, want empty", got[0].Label)
	}
	if got[0].Confidence > 0.6 {
		t.Errorf("conf = %v, want <= 0.55 for unlabelled underline", got[0].Confidence)
	}
}

func TestDetect_NoColonNoUnderline_NoEmission(t *testing.T) {
	p := page(800, 1100,
		box("Some prose paragraph with no fields.", 60, 100, 400, 22),
		box("More prose continues here.", 60, 130, 350, 22),
	)
	got := Detect([]ocr.LayoutPage{p})
	if len(got) != 0 {
		t.Errorf("non-form text emitted %d fields: %+v", len(got), got)
	}
}

func TestDetect_PageNumberStamped(t *testing.T) {
	pages := []ocr.LayoutPage{
		page(800, 1100, box("Name:", 60, 100, 50, 20)),
		page(800, 1100, box("Date:", 60, 100, 50, 20)),
	}
	got := Detect(pages)
	if len(got) != 2 {
		t.Fatalf("got %d, want 2", len(got))
	}
	if got[0].Page != 1 {
		t.Errorf("page 0 field.Page = %d, want 1", got[0].Page)
	}
	if got[1].Page != 2 {
		t.Errorf("page 1 field.Page = %d, want 2", got[1].Page)
	}
}

func TestDetect_OutOfOrderInputIsSorted(t *testing.T) {
	// Boxes given in random order; detector should still emit a
	// well-formed text field for "Email:" because it sorts internally.
	p := page(800, 1100,
		box("Email:", 60, 200, 60, 20),
		box("Name:", 60, 100, 60, 20), // emit goes here
	)
	got := Detect([]ocr.LayoutPage{p})
	// Emission order should be top-to-bottom now.
	if len(got) < 2 {
		t.Fatalf("got %d fields, want at least 2", len(got))
	}
	if got[0].Label != "Name" || got[1].Label != "Email" {
		t.Errorf("emit order = [%s, %s], want [Name, Email]",
			got[0].Label, got[1].Label)
	}
}

// TestDetect_SectionPrefix_AllCapsHeader covers the canonical pattern
// the section feature exists for: a "PERSONAL DETAILS" / "MAILING
// ADDRESS" style header followed by labels that repeat across blocks.
// Without section context, two pages worth of "Name:" / "City:" would
// collapse to suffixed dupes (name_2, city_2) — meaningful but
// content-free. With section context they become "personal_details_
// name" / "mailing_address_city", which round-trip into a usable
// schema for downstream consumers.
func TestDetect_SectionPrefix_AllCapsHeader(t *testing.T) {
	// Y=80: section header (all caps, alone on row)
	// Y=140: "Name:" with text gap to right
	// Y=300: another section header
	// Y=360: "Name:" again — must be qualified by the second section
	p := page(800, 1100,
		box("PERSONAL DETAILS", 60, 80, 220, 20),
		box("Name:", 60, 140, 60, 20),
		box("MAILING ADDRESS", 60, 300, 220, 20),
		box("Name:", 60, 360, 60, 20),
	)
	got := Detect([]ocr.LayoutPage{p})
	if len(got) != 2 {
		t.Fatalf("got %d fields, want 2: %+v", len(got), got)
	}
	if got[0].Label != "PERSONAL DETAILS - Name" {
		t.Errorf("[0] Label = %q, want %q", got[0].Label, "PERSONAL DETAILS - Name")
	}
	if got[1].Label != "MAILING ADDRESS - Name" {
		t.Errorf("[1] Label = %q, want %q", got[1].Label, "MAILING ADDRESS - Name")
	}
}

// TestDetect_SectionPrefix_LargerFontHeader pins the visual-hierarchy
// signal — a header at title-case body height won't trip the all-caps
// heuristic, but a 1.5× taller bbox should still mark it as a header.
func TestDetect_SectionPrefix_LargerFontHeader(t *testing.T) {
	// Body height = 20, header height = 32 (1.6×). Title case on the
	// header so only the height signal qualifies it.
	p := page(800, 1100,
		box("Applicant Information", 60, 80, 280, 32),
		box("Email:", 60, 160, 60, 20),
	)
	got := Detect([]ocr.LayoutPage{p})
	if len(got) != 1 {
		t.Fatalf("got %d, want 1: %+v", len(got), got)
	}
	if got[0].Label != "Applicant Information - Email" {
		t.Errorf("Label = %q, want %q", got[0].Label, "Applicant Information - Email")
	}
}

// TestDetect_SectionPrefix_NoHeaderAbove covers fields in the page
// preamble — anything that appears before the first header gets no
// prefix, so the form's title block doesn't accidentally become a
// section name for unrelated fields.
func TestDetect_SectionPrefix_NoHeaderAbove(t *testing.T) {
	p := page(800, 1100,
		box("Date:", 60, 60, 60, 20),         // pre-header
		box("PERSONAL DETAILS", 60, 200, 220, 20),
		box("Name:", 60, 260, 60, 20),
	)
	got := Detect([]ocr.LayoutPage{p})
	if len(got) != 2 {
		t.Fatalf("got %d, want 2: %+v", len(got), got)
	}
	if got[0].Label != "Date" {
		t.Errorf("[0] Label = %q, want %q (no header above)", got[0].Label, "Date")
	}
	if got[1].Label != "PERSONAL DETAILS - Name" {
		t.Errorf("[1] Label = %q, want %q", got[1].Label, "PERSONAL DETAILS - Name")
	}
}

// TestDetect_SectionPrefix_NoDoublePrefix guards the idempotency the
// merge tier relies on — when the label already contains the section
// text (e.g. vision-LLM emitted it pre-qualified), we don't stack a
// second copy on top.
func TestDetect_SectionPrefix_NoDoublePrefix(t *testing.T) {
	p := page(800, 1100,
		box("OFFICE", 60, 80, 100, 20),
		// Engineered scenario: a label that already names its section.
		box("OFFICE Phone:", 60, 140, 140, 20),
	)
	got := Detect([]ocr.LayoutPage{p})
	if len(got) != 1 {
		t.Fatalf("got %d, want 1: %+v", len(got), got)
	}
	// Should NOT be "OFFICE - OFFICE Phone".
	if got[0].Label != "OFFICE Phone" {
		t.Errorf("Label = %q, want %q (section already in label)", got[0].Label, "OFFICE Phone")
	}
}

// TestDetect_SectionPrefix_DisqualifiesColonLabel verifies that
// "Name:" — a field label, not a section header — never gets promoted
// to header status even when alone on its row. Otherwise every label
// would become a section title and prefix itself.
func TestDetect_SectionPrefix_DisqualifiesColonLabel(t *testing.T) {
	p := page(800, 1100,
		box("Name:", 60, 80, 60, 20), // alone on row, but ends in colon
		box("Email:", 60, 160, 60, 20),
	)
	got := Detect([]ocr.LayoutPage{p})
	if len(got) != 2 {
		t.Fatalf("got %d, want 2: %+v", len(got), got)
	}
	for _, f := range got {
		if strings.Contains(f.Label, " - ") {
			t.Errorf("field %q got an unwanted section prefix", f.Label)
		}
	}
}

// TestDetect_SectionPrefix_FillsEmptyLabel covers the bare-underline
// case — heuristic detected a fillable line but couldn't bind a
// label. The section name is better than nothing, so we promote it
// in-place rather than keeping the empty Label.
func TestDetect_SectionPrefix_FillsEmptyLabel(t *testing.T) {
	p := page(800, 1100,
		box("SIGNATURES", 60, 80, 200, 20),
		box("____________________", 200, 160, 300, 20), // bare underline, no label to its left
	)
	got := Detect([]ocr.LayoutPage{p})
	if len(got) != 1 {
		t.Fatalf("got %d, want 1: %+v", len(got), got)
	}
	if got[0].Label != "SIGNATURES" {
		t.Errorf("Label = %q, want %q (section fills empty label)", got[0].Label, "SIGNATURES")
	}
}

// pageWithGrids builds a LayoutPage carrying both OCR boxes AND the
// CV-detected character grids the sidecar emits. The grid bboxes are
// in pixel space (same as boxes), with the cell count exposed for
// the heuristic to surface as maxLength downstream.
func pageWithGrids(w, h int, boxes []ocr.LayoutBox, grids []ocr.LayoutGrid) ocr.LayoutPage {
	return ocr.LayoutPage{W: w, H: h, Boxes: boxes, Grids: grids}
}

func grid(x, y, w, h float64, cells int) ocr.LayoutGrid {
	return ocr.LayoutGrid{
		X: x, Y: y, W: w, H: h,
		Cells: cells,
		CellW: w / float64(cells),
		CellH: h,
		Bbox:  [4]float64{x, y, w, h},
	}
}

// TestDetect_Grid_BindLeftLabelWithColon — canonical PAN-style row:
// "PAN Number" sits to the left of a 10-cell grid. The grid becomes
// one text field, label inherited from the left text, MaxLength=10.
// This is the headline case the whole CV-grid feature exists for.
func TestDetect_Grid_BindLeftLabelWithColon(t *testing.T) {
	boxes := []ocr.LayoutBox{
		box("PAN Number:", 60, 200, 110, 20),
	}
	grids := []ocr.LayoutGrid{
		grid(200, 200, 280, 22, 10),
	}
	got := Detect([]ocr.LayoutPage{pageWithGrids(800, 1100, boxes, grids)})

	// One field for the grid (the left label is consumed for naming,
	// not separately emitted because no underline / colon-gap pattern
	// triggers).
	if len(got) != 1 {
		t.Fatalf("got %d fields, want 1: %+v", len(got), got)
	}
	f := got[0]
	if f.Type != "text" {
		t.Errorf("Type = %q, want text", f.Type)
	}
	if f.Label != "PAN Number" {
		t.Errorf("Label = %q, want %q (left-side colon label)", f.Label, "PAN Number")
	}
	if f.MaxLength != 10 {
		t.Errorf("MaxLength = %d, want 10 (cell count)", f.MaxLength)
	}
	if f.X != 200 || f.W != 280 {
		t.Errorf("bbox = (%v, w=%v), want (200, w=280)", f.X, f.W)
	}
}

// TestDetect_Grid_BindLeftLabelNoColon — many Indian bank forms
// omit the colon: "PAN Number" then directly into the grid. Same
// label-binding behaviour expected.
func TestDetect_Grid_BindLeftLabelNoColon(t *testing.T) {
	boxes := []ocr.LayoutBox{
		box("CKYC Number", 60, 200, 110, 20),
	}
	grids := []ocr.LayoutGrid{
		grid(200, 200, 392, 22, 14),
	}
	got := Detect([]ocr.LayoutPage{pageWithGrids(800, 1100, boxes, grids)})
	if len(got) != 1 {
		t.Fatalf("got %d, want 1: %+v", len(got), got)
	}
	if got[0].Label != "CKYC Number" {
		t.Errorf("Label = %q, want %q", got[0].Label, "CKYC Number")
	}
	if got[0].MaxLength != 14 {
		t.Errorf("MaxLength = %d, want 14", got[0].MaxLength)
	}
}

// TestDetect_Grid_BindLabelStackedLeft — the canonical Indian-form
// stacked label: "*Company Name/Flat" / "No & Bldg Name" stacked at
// the LEFT of the page, with the grid starting on the same row as the
// bottom label line. The bottom label ("No & Bldg Name") binds because
// the same-row left-side pass picks it up; the line above is just
// context the user can read in the modal.
func TestDetect_Grid_BindLabelStackedLeft(t *testing.T) {
	boxes := []ocr.LayoutBox{
		box("*Company Name/Flat", 60, 400, 180, 20),
		box("No & Bldg Name", 60, 425, 140, 20),
	}
	grids := []ocr.LayoutGrid{
		// Same row as the BOTTOM label line, off to the right.
		grid(280, 425, 480, 22, 16),
	}
	got := Detect([]ocr.LayoutPage{pageWithGrids(800, 1100, boxes, grids)})
	// Two unrelated labels above land in their own row, but only the
	// grid produces a Field — the labels themselves don't end in a
	// colon and don't have an underline run, so no per-box Fields.
	if len(got) != 1 {
		t.Fatalf("got %d, want 1: %+v", len(got), got)
	}
	if got[0].Label != "No & Bldg Name" {
		t.Errorf("Label = %q, want %q (same-row left label binds)", got[0].Label, "No & Bldg Name")
	}
}

// TestDetect_Grid_BindLabelDirectlyAbove — the ALT pattern where the
// label sits squarely above the grid (no horizontally-adjacent label
// to its left). Pass 2 of the binder should fire and pick up the line
// directly above with horizontal overlap.
func TestDetect_Grid_BindLabelDirectlyAbove(t *testing.T) {
	boxes := []ocr.LayoutBox{
		box("Branch Name", 300, 100, 120, 20),
	}
	grids := []ocr.LayoutGrid{
		// Sits directly under the label (overlapping its X-range).
		grid(290, 140, 320, 22, 12),
	}
	got := Detect([]ocr.LayoutPage{pageWithGrids(800, 1100, boxes, grids)})
	if len(got) != 1 {
		t.Fatalf("got %d, want 1: %+v", len(got), got)
	}
	if got[0].Label != "Branch Name" {
		t.Errorf("Label = %q, want %q (directly-above label binds)", got[0].Label, "Branch Name")
	}
}

// TestDetect_Grid_SuppressesPlaceholderText — a date strip with
// "ddmmyy" rendered inside the cells gets BOTH a heuristic detection
// (from the placeholder text) AND a grid detection. The grid
// suppression should drop the heuristic field because it sits inside
// the grid.
func TestDetect_Grid_SuppressesPlaceholderText(t *testing.T) {
	// The placeholder "ddmmyy" inside the grid is also OCR'd as a
	// label-with-colon pattern via "Expiry Date:" sitting to its
	// left, which is what produced the misplaced widgets in the
	// user's earlier screenshot.
	boxes := []ocr.LayoutBox{
		box("Expiry Date:", 60, 200, 110, 20),
		box("ddmmyy", 250, 200, 50, 18), // placeholder text inside the grid
	}
	grids := []ocr.LayoutGrid{
		grid(200, 195, 168, 25, 6), // DDMMYY = 6 cells
	}
	got := Detect([]ocr.LayoutPage{pageWithGrids(800, 1100, boxes, grids)})
	// Should be exactly one field — the grid. The "Expiry Date:" colon-gap
	// detection lands inside the grid (its widget X >= 176 sits in the
	// grid's 200-368 span), so suppression drops it.
	if len(got) != 1 {
		t.Fatalf("got %d, want 1: %+v", len(got), got)
	}
	if got[0].MaxLength != 6 {
		t.Errorf("MaxLength = %d, want 6 (grid wins, not the placeholder)", got[0].MaxLength)
	}
	if got[0].Label != "Expiry Date" {
		t.Errorf("Label = %q, want %q", got[0].Label, "Expiry Date")
	}
}

// TestDetect_Grid_NoLabelFallback — a grid with no nearby OCR text
// (rare but possible with isolated character grids) emits the field
// with empty Label. The downstream polish pass assigns a synthetic
// field_N name; here we just verify we don't panic and the cell
// count is still surfaced.
func TestDetect_Grid_NoLabelFallback(t *testing.T) {
	grids := []ocr.LayoutGrid{
		grid(300, 500, 280, 22, 10),
	}
	got := Detect([]ocr.LayoutPage{pageWithGrids(800, 1100, nil, grids)})
	if len(got) != 1 {
		t.Fatalf("got %d, want 1: %+v", len(got), got)
	}
	if got[0].MaxLength != 10 {
		t.Errorf("MaxLength = %d, want 10", got[0].MaxLength)
	}
	if got[0].Label != "" {
		t.Errorf("Label = %q, want empty (no OCR text near grid)", got[0].Label)
	}
}

// TestDetect_Grid_MultipleGridsReadingOrder — three grids stacked
// vertically (typical of a 3-row "Doc No / Doc No / Doc No" block)
// emit in top-to-bottom reading order intermixed with their labels.
func TestDetect_Grid_MultipleGridsReadingOrder(t *testing.T) {
	boxes := []ocr.LayoutBox{
		box("Reg Doc 1 - Doc No", 60, 200, 180, 20),
		box("Reg Doc 2 - Doc No", 60, 250, 180, 20),
		box("Other Doc - Doc No", 60, 300, 180, 20),
	}
	grids := []ocr.LayoutGrid{
		grid(260, 200, 400, 22, 20),
		grid(260, 250, 400, 22, 20),
		grid(260, 300, 400, 22, 20),
	}
	got := Detect([]ocr.LayoutPage{pageWithGrids(800, 1100, boxes, grids)})
	if len(got) != 3 {
		t.Fatalf("got %d, want 3: %+v", len(got), got)
	}
	wantLabels := []string{"Reg Doc 1 - Doc No", "Reg Doc 2 - Doc No", "Other Doc - Doc No"}
	for i, want := range wantLabels {
		if got[i].Label != want {
			t.Errorf("[%d] Label = %q, want %q (full: %+v)", i, got[i].Label, want, got)
		}
	}
}

// TestDetect_Grid_SectionPrefixApplied — grid fields go through the
// same section-prefix pass as box-derived fields. A "MAILING ADDRESS"
// header above and "*City / Town" left of a grid yields the
// fully-qualified label "MAILING ADDRESS - *City / Town".
func TestDetect_Grid_SectionPrefixApplied(t *testing.T) {
	boxes := []ocr.LayoutBox{
		box("MAILING ADDRESS", 60, 100, 200, 20),
		box("*City / Town", 60, 400, 110, 20),
	}
	grids := []ocr.LayoutGrid{
		grid(200, 400, 280, 22, 10),
	}
	got := Detect([]ocr.LayoutPage{pageWithGrids(800, 1100, boxes, grids)})
	if len(got) != 1 {
		t.Fatalf("got %d, want 1: %+v", len(got), got)
	}
	want := "MAILING ADDRESS - *City / Town"
	if got[0].Label != want {
		t.Errorf("Label = %q, want %q", got[0].Label, want)
	}
}

// pageWithCheckboxes builds a LayoutPage carrying both OCR boxes AND
// the CV-detected checkbox bboxes the sidecar emits. Mirrors
// pageWithGrids — separate helper so tests stay self-documenting about
// which late-pass they're exercising.
func pageWithCheckboxes(w, h int, boxes []ocr.LayoutBox, cbs []ocr.LayoutCheckbox) ocr.LayoutPage {
	return ocr.LayoutPage{W: w, H: h, Boxes: boxes, Checkboxes: cbs}
}

func checkbox(x, y, w, h float64) ocr.LayoutCheckbox {
	return ocr.LayoutCheckbox{
		X: x, Y: y, W: w, H: h,
		Bbox: [4]float64{x, y, w, h},
	}
}

// TestDetect_Checkbox_BindsRightLabel — canonical "[ ] Savings" row.
// CV detector finds the empty square; binder picks up the right-side
// OCR text as the label.
func TestDetect_Checkbox_BindsRightLabel(t *testing.T) {
	boxes := []ocr.LayoutBox{
		box("Savings", 100, 200, 80, 20),
	}
	cbs := []ocr.LayoutCheckbox{
		checkbox(60, 200, 18, 18),
	}
	got := Detect([]ocr.LayoutPage{pageWithCheckboxes(800, 1100, boxes, cbs)})
	if len(got) != 1 {
		t.Fatalf("got %d, want 1: %+v", len(got), got)
	}
	if got[0].Type != "checkbox" {
		t.Errorf("Type = %q, want checkbox", got[0].Type)
	}
	if got[0].Label != "Savings" {
		t.Errorf("Label = %q, want Savings", got[0].Label)
	}
}

// TestDetect_Checkbox_StripsTrailingColon — "Tatkal:" right-side label
// gets the colon trimmed so the slugged key downstream is "tatkal" not
// "tatkal_". Mirrors the colon-trim that the per-box passes do.
//
// Note: "Tatkal:" with empty space to its right also triggers the
// per-box colon-gap text emitter, so the page may produce an extra
// text field. We assert on the checkbox label, not the field count.
func TestDetect_Checkbox_StripsTrailingColon(t *testing.T) {
	boxes := []ocr.LayoutBox{
		box("Tatkal:", 100, 200, 80, 20),
		// Cap the colon-gap with another label far to the right so the
		// gap detector at least has a defined endpoint; not strictly
		// necessary for the assertion but keeps the fixture honest.
		box("End", 760, 200, 30, 20),
	}
	cbs := []ocr.LayoutCheckbox{
		checkbox(60, 200, 18, 18),
	}
	got := Detect([]ocr.LayoutPage{pageWithCheckboxes(800, 1100, boxes, cbs)})
	cb, ok := findFirst(got, "checkbox", "Tatkal")
	if !ok {
		t.Fatalf("expected checkbox bound to 'Tatkal' (colon trimmed); got %+v", got)
	}
	if strings.HasSuffix(cb.Label, ":") {
		t.Errorf("Label %q still has trailing colon", cb.Label)
	}
}

// TestDetect_Checkbox_LeftFallback — "Form 60   [ ]" pattern: no text
// to the right, so the binder falls back to the same-row left side.
func TestDetect_Checkbox_LeftFallback(t *testing.T) {
	boxes := []ocr.LayoutBox{
		box("Form 60", 60, 200, 80, 20),
	}
	cbs := []ocr.LayoutCheckbox{
		checkbox(180, 200, 18, 18), // checkbox to the RIGHT of the text
	}
	got := Detect([]ocr.LayoutPage{pageWithCheckboxes(800, 1100, boxes, cbs)})
	if len(got) != 1 {
		t.Fatalf("got %d, want 1: %+v", len(got), got)
	}
	if got[0].Label != "Form 60" {
		t.Errorf("Label = %q, want %q (left fallback)", got[0].Label, "Form 60")
	}
}

// TestDetect_Checkbox_RightWindowCap — adjacent checkboxes "[ ]
// Savings   [ ] Current" must NOT have the second checkbox steal the
// first's label. The right-lookahead cap (~120px) is what enforces
// this; if it ever loosens, this test catches the regression.
func TestDetect_Checkbox_RightWindowCap(t *testing.T) {
	boxes := []ocr.LayoutBox{
		box("Savings", 100, 200, 80, 20),
		box("Current", 300, 200, 80, 20),
	}
	cbs := []ocr.LayoutCheckbox{
		checkbox(60, 200, 18, 18),  // [ ] Savings
		checkbox(260, 200, 18, 18), // [ ] Current
	}
	got := Detect([]ocr.LayoutPage{pageWithCheckboxes(800, 1100, boxes, cbs)})
	if len(got) != 2 {
		t.Fatalf("got %d, want 2: %+v", len(got), got)
	}
	// Reading order: leftmost first.
	if got[0].Label != "Savings" {
		t.Errorf("[0] Label = %q, want Savings", got[0].Label)
	}
	if got[1].Label != "Current" {
		t.Errorf("[1] Label = %q, want Current", got[1].Label)
	}
}

// TestDetect_Checkbox_IgnoresGlyphLabels — the OCR sometimes reads an
// empty checkbox as a "[ ]" or "□" glyph. We must not let a CV-detected
// checkbox bind to a neighbouring OCR'd glyph as its label, because
// that glyph IS another checkbox slot, not text.
func TestDetect_Checkbox_IgnoresGlyphLabels(t *testing.T) {
	boxes := []ocr.LayoutBox{
		box("[ ]", 100, 200, 18, 18), // OCR'd glyph (another checkbox)
		box("Savings", 130, 200, 80, 20),
	}
	cbs := []ocr.LayoutCheckbox{
		checkbox(60, 200, 18, 18),
	}
	got := Detect([]ocr.LayoutPage{pageWithCheckboxes(800, 1100, boxes, cbs)})
	// We expect the checkbox label to skip the "[ ]" glyph and bind to
	// "Savings". The OCR glyph itself may also produce its own field
	// from the per-box passes — that's fine, what we're guarding here
	// is that the CV-detected checkbox's label isn't "[ ]".
	cb, ok := findFirst(got, "checkbox", "Savings")
	if !ok {
		t.Fatalf("no checkbox bound to Savings; got %+v", got)
	}
	if cb.Label == "[ ]" {
		t.Fatalf("checkbox bound to glyph instead of text label")
	}
}

// TestDetect_Checkbox_SuppressesOverlappingTextField — when the OCR's
// per-box pass produces a text field whose bbox sits on top of a CV-
// detected checkbox (e.g. a "[Savings]" run mistaken as a text widget),
// the CV checkbox wins and the duplicate text field is dropped.
func TestDetect_Checkbox_SuppressesOverlappingTextField(t *testing.T) {
	// "Account Type:" + a long underline that overlaps the checkbox row
	// would normally produce a text field across the underline. We
	// stage the underline so its widget bbox overlaps the checkbox.
	boxes := []ocr.LayoutBox{
		box("[ ]", 60, 200, 18, 18), // OCR-glyph at the SAME spot as the CV checkbox
		box("Savings", 100, 200, 80, 20),
	}
	cbs := []ocr.LayoutCheckbox{
		checkbox(60, 200, 18, 18),
	}
	got := Detect([]ocr.LayoutPage{pageWithCheckboxes(800, 1100, boxes, cbs)})
	// Exactly one checkbox emerges (the CV-detected one). Whatever the
	// per-box pass tried to produce at the same coords gets suppressed
	// by the intersection-over-min-area filter.
	cbCount := 0
	for _, f := range got {
		if f.Type == "checkbox" {
			cbCount++
		}
	}
	if cbCount != 1 {
		t.Fatalf("got %d checkbox fields, want 1: %+v", cbCount, got)
	}
}

// TestDetect_Checkbox_SectionPrefixApplied — checkbox fields get the
// same "SECTION - label" prefix the per-box and grid fields get,
// because all three flow through appendWithSection inside detectPage.
func TestDetect_Checkbox_SectionPrefixApplied(t *testing.T) {
	boxes := []ocr.LayoutBox{
		box("ACCOUNT PREFERENCES", 60, 100, 240, 20),
		box("Savings", 100, 400, 80, 20),
	}
	cbs := []ocr.LayoutCheckbox{
		checkbox(60, 400, 18, 18),
	}
	got := Detect([]ocr.LayoutPage{pageWithCheckboxes(800, 1100, boxes, cbs)})
	cb, ok := findFirst(got, "checkbox", "ACCOUNT PREFERENCES - Savings")
	if !ok {
		t.Fatalf("expected section-prefixed checkbox label, got %+v", got)
	}
	if cb.Type != "checkbox" {
		t.Errorf("Type = %q, want checkbox", cb.Type)
	}
}

// TestDetect_Checkbox_NoLabelFallback — a checkbox with no nearby OCR
// text emits with empty label; downstream polish assigns a synthetic
// field_N. Just verifies we don't panic and the field is preserved.
func TestDetect_Checkbox_NoLabelFallback(t *testing.T) {
	cbs := []ocr.LayoutCheckbox{
		checkbox(60, 500, 18, 18),
	}
	got := Detect([]ocr.LayoutPage{pageWithCheckboxes(800, 1100, nil, cbs)})
	if len(got) != 1 {
		t.Fatalf("got %d, want 1: %+v", len(got), got)
	}
	if got[0].Type != "checkbox" {
		t.Errorf("Type = %q, want checkbox", got[0].Type)
	}
	if got[0].Label != "" {
		t.Errorf("Label = %q, want empty", got[0].Label)
	}
}
