// Package heuristic infers form-field placements from PaddleOCR
// layout output (text + axis-aligned bbox per detected line) without
// any AI calls. It's the second tier in the auto-field-detection
// cascade — AcroForm extraction runs first; this fires when the PDF
// has no /AcroForm dict (scanned / flattened forms).
//
// # Design
//
// The detector is a pure function over []ocr.LayoutPage. Coordinates
// stay in the sidecar's pixel space (top-left origin, units = pixels
// at the rasterization DPI). The aidetect cascade orchestrator
// translates to PDF user-space (1/72", origin bottom-left) when
// emitting the public Proposal struct, so this package can be
// exercised with synthetic LayoutPage fixtures and never needs a real
// PDF or sidecar.
//
// # Rules in V1
//
// We aim to cover the four highest-signal patterns commonly seen in
// scanned/flat business forms:
//
//   - Checkbox: explicit glyphs the OCR engine actually sees —
//     "[ ]" "[X]" "□" "☐" "☑" "▢" "■". Empty boxes that the OCR
//     ignores are unrecoverable from text-only output; PP-Structure
//     would help, but we deliberately avoid loading a second model.
//
//   - Radio: parenthesized glyphs "( )" "(X)" "( • )" or circle
//     unicode "○" "●" "◯" "◉". Same rationale.
//
//   - Signature: keyword-driven. A line whose text contains
//     "signature", "sign here", "signed by", or "customer sign"
//     anchors a signature widget sized ~220x36 px placed next to or
//     below the keyword. Underline runs ("________") near the keyword
//     are folded into the same proposal rather than emitted twice.
//
//   - Text field: the canonical "Label:  ____" pattern. A line
//     ending in ":" emits a text widget filling the horizontal gap
//     between the label and the next box on the same row (or to the
//     page right margin if the label is alone on its row). A bare
//     underline run with no preceding colon-label still emits a text
//     proposal but with lower confidence because we can't bind a
//     decent label.
//
// Anything we're not confident about is dropped — the modal is
// "review and accept", over-emission would just add noise. The user
// can still draw widgets manually for missed fields.
//
// # Confidence
//
// Per-Field confidence is a coarse 0..1 estimate so the modal can
// surface a "high / medium / low" signal to the reviewer:
//
//   - 0.85: explicit glyph match (checkbox/radio) + adjacent label
//   - 0.80: signature keyword in line
//   - 0.70: colon-label + same-row gap >= minTextFieldWPx
//   - 0.55: bare underline run (no label binding)
//   - 0.40: anything else we still emit
package heuristic

import (
	"regexp"
	"sort"
	"strings"
	"unicode"

	"github.com/docforge/api/internal/ocr"
)

// Field is one detected widget proposal in pixel space. The cascade
// orchestrator in internal/aidetect translates X/Y/W/H to PDF
// user-space and Page+Label into a Proposal struct.
type Field struct {
	// Type matches the static designer's widget vocabulary used by
	// AcroForm extraction — "text" / "checkbox" / "radio" / "signature".
	Type string

	// Page is the 1-based page index from the source PDF / image.
	Page int

	// X/Y/W/H are pixel coordinates, top-left origin, at the
	// rasterization DPI of the source layout pages. Caller is
	// responsible for converting to PDF user-space.
	X, Y, W, H float64

	// PageW / PageH are the rasterized page dimensions in pixels,
	// so the orchestrator can scale to PDF point dimensions without
	// re-querying the sidecar.
	PageW int
	PageH int

	// Label is the human-readable hint surfaced in the review modal
	// and used to seed the field's data key. May be empty for bare
	// underline runs.
	Label string

	// Confidence is a 0..1 estimate. See package doc for the rubric.
	Confidence float64

	// MaxLength is non-zero when we know the field is bounded — set
	// from a character grid's cell count. Downstream uses it to seed
	// the designer's maxLength prop so a 10-cell PAN grid produces a
	// 10-character text field. Zero means "unbounded / unknown".
	MaxLength int
}

// Pixel-space tuning. All thresholds are at the sidecar's default
// 200dpi rasterization; the heuristic doesn't need exact tuning
// because the user reviews every emitted proposal.
const (
	// sameRowYTolerancePx — two boxes are "on the same row" when
	// their vertical centers are within this many pixels. 8 px at
	// 200dpi ≈ 0.04in ≈ ~3pt — tight enough to separate adjacent
	// rows, loose enough to absorb baseline noise from PaddleOCR.
	sameRowYTolerancePx = 8.0

	// minTextFieldWPx — text proposals narrower than this are
	// dropped (a 30px gap is almost certainly punctuation, not a
	// fillable field).
	minTextFieldWPx = 60.0

	// rightMarginPx — when the label is alone on its row, the
	// emitted text widget runs from the label's right edge to
	// (page.W - rightMarginPx). Matches typical printer margin.
	rightMarginPx = 40.0

	// sigW / sigH — synthetic signature widget dimensions. ~1.1in x
	// 0.18in at 200dpi, the size of a typical printed signature
	// line so the rendered widget overlay sits roughly where a
	// human pen-stroke would.
	sigWPx = 220.0
	sigHPx = 36.0

	// glyphFieldHPx — when a glyph is the only signal (e.g. a
	// standalone "[ ]"), the OCR bbox is the glyph itself. We size
	// the proposed widget to that glyph rather than expanding
	// outward, since the user would otherwise drag-resize anyway.
	glyphFieldHPx = 18.0
)

var (
	// Glyph patterns we explicitly recognise. PaddleOCR happily
	// reads these as text when rendered; what we can't recover is
	// truly empty checkboxes (a hollow square with no fill on a
	// scan often gets dropped by the detector). PP-Structure would
	// help with those — left for V2.
	checkboxGlyph = regexp.MustCompile(`^(?:\[\s*[xX✓✗]?\s*\]|☐|☑|☒|□|■|▢|▣)$`)
	radioGlyph    = regexp.MustCompile(`^(?:\(\s*[xX•·]?\s*\)|○|●|◯|◉|◎)$`)

	// sigKeyword fires on lines whose text is dominated by a
	// signature cue. We use \b for word boundaries so "designate"
	// doesn't accidentally match "sign".
	sigKeyword = regexp.MustCompile(`(?i)\b(signature|sign\s+here|signed\s+by|customer\s+sign|signed?\s*[:：])\b`)

	// labelEnding catches both ASCII colon and the East Asian
	// fullwidth colon (\uFF1A) — Indic forms in particular often
	// use "label : value".
	labelEnding = regexp.MustCompile(`[:：]\s*$`)

	// underlineRun catches a box whose text is essentially just
	// underscores or whitespace — the OCR signature for a printed
	// fillable line. Three underscores is the shortest run we'll
	// accept (shorter is usually a typo or em-dash).
	underlineRun = regexp.MustCompile(`^[_\s]{3,}$`)
)

// Detect runs the rule set over each page in document order and
// returns proposed fields. Output order is the same row/column scan
// order PaddleOCR's detection model emits, which matches reading
// order for left-to-right scripts.
func Detect(pages []ocr.LayoutPage) []Field {
	out := []Field{}
	for pageIdx, page := range pages {
		out = append(out, detectPage(pageIdx+1, page)...)
	}
	return out
}

func detectPage(pageNum int, page ocr.LayoutPage) []Field {
	// Short-circuit only when ALL inputs are empty. A page with grids
	// or checkboxes but no OCR boxes (rare but possible — a pure
	// character-grid form, or a "tick-the-box" preference page with no
	// instructions) still needs the corresponding CV pass to run.
	if len(page.Boxes) == 0 && len(page.Grids) == 0 && len(page.Checkboxes) == 0 {
		return nil
	}

	// Stable scan order: top-to-bottom, then left-to-right within a
	// row. PaddleOCR usually returns boxes in close-to-this order
	// already but we re-sort defensively so the heuristic is
	// deterministic across engine versions.
	ordered := make([]ocr.LayoutBox, len(page.Boxes))
	copy(ordered, page.Boxes)
	sort.SliceStable(ordered, func(i, j int) bool {
		if absf(ordered[i].Y-ordered[j].Y) > sameRowYTolerancePx {
			return ordered[i].Y < ordered[j].Y
		}
		return ordered[i].X < ordered[j].X
	})

	// Pre-pass: find section headers so we can prefix each emitted
	// Field's Label with its parent section. This is what turns a
	// repeating "Doc No" row inside three separate "Reg Doc" blocks
	// into three uniquely-keyable fields ("reg_doc_1_doc_no" etc.)
	// rather than three colliding "doc_no"s the polish pass would have
	// to suffix-disambiguate. Section context comes from the form
	// itself, so the keys read meaningfully to a human integrator.
	headers := detectSectionHeaders(ordered)

	out := []Field{}
	consumed := make([]bool, len(ordered))

	// appendWithSection mirrors the section-qualified label convention
	// the vision-LLM prompt produces (" - " separator). Polish then
	// slugifies both sources identically — section_label_field_label.
	appendWithSection := func(f Field) {
		if section := sectionFor(f.Y, headers); section != "" {
			if strings.TrimSpace(f.Label) == "" {
				f.Label = section
			} else if !strings.Contains(f.Label, section) {
				f.Label = section + " - " + f.Label
			}
		}
		out = append(out, f)
	}

	for i, b := range ordered {
		if consumed[i] {
			continue
		}
		text := strings.TrimSpace(b.Text)
		if text == "" {
			continue
		}

		switch {
		case checkboxGlyph.MatchString(text):
			f := makeGlyphField("checkbox", pageNum, page, b, neighborLabelRight(ordered, i, consumed))
			f.Confidence = 0.85
			appendWithSection(f)

		case radioGlyph.MatchString(text):
			f := makeGlyphField("radio", pageNum, page, b, neighborLabelRight(ordered, i, consumed))
			f.Confidence = 0.85
			appendWithSection(f)

		case sigKeyword.MatchString(text):
			appendWithSection(makeSignatureField(pageNum, page, b))
			// Suppress an immediately-following underline run that's
			// part of the same signature line — otherwise we'd emit
			// both a signature and a text widget over each other.
			suppressFollowingUnderline(ordered, consumed, i)

		case labelEnding.MatchString(text):
			if f, ok := makeTextFromLabel(pageNum, page, ordered, i); ok {
				appendWithSection(f)
			}

		case underlineRun.MatchString(text):
			if f, ok := makeTextFromUnderline(pageNum, page, ordered, i); ok {
				appendWithSection(f)
			}
		}
	}

	// Character-grid pass. Grids come from the OCR sidecar's CV-based
	// detector (rows of empty equal-size boxes — PAN, CKYC, address
	// blocks, DD/MM/YYYY date strips). They're invisible to text-OCR
	// because the cells are empty; this pass is what closes the recall
	// gap on Indian KYC/AOF forms.
	if len(page.Grids) > 0 {
		gridFields := fieldsFromGrids(pageNum, page, ordered)
		// Suppress per-box fields that sit inside a grid — typically
		// the heuristic latched onto placeholder hint text rendered
		// inside the grid (e.g. "ddmmyy" inside a date strip), or an
		// underline run drawn under a grid row. The grid is always the
		// better representation: correct width, correct cell count.
		out = suppressFieldsInsideGrids(out, gridFields)
		for _, gf := range gridFields {
			appendWithSection(gf)
		}
	}

	// Checkbox pass. Same architectural story as grids: CV detector in
	// the sidecar finds the empty squares OCR can't see, and we bind a
	// label here from the surrounding OCR text. The right-side label is
	// dominant ("[ ] Savings", "[ ] Current Account") because that's
	// the printed-form convention; we fall back to a left-side label
	// when nothing reasonable is to the right.
	if len(page.Checkboxes) > 0 {
		cbFields := fieldsFromCheckboxes(pageNum, page, ordered)
		out = suppressFieldsAroundCheckboxes(out, cbFields)
		for _, cf := range cbFields {
			appendWithSection(cf)
		}
	}

	// Re-sort so grid + checkbox fields land in reading order alongside
	// the per-box detections. Without this, the late-pass fields would
	// all trail at the end of `out` regardless of their Y coordinate.
	if len(page.Grids) > 0 || len(page.Checkboxes) > 0 {
		sort.SliceStable(out, func(i, j int) bool {
			if absf(out[i].Y-out[j].Y) > sameRowYTolerancePx {
				return out[i].Y < out[j].Y
			}
			return out[i].X < out[j].X
		})
	}
	return out
}

// fieldsFromGrids converts each detected character grid into a single
// text Field with its label bound from the surrounding OCR text.
//
// Label-binding heuristic — first match wins:
//  1. Box on the same row, left of the grid, ending in colon ("PAN
//     Number:"). High signal, used by most printed forms.
//  2. Box on the same row, left of the grid, no colon. Catches "PAN
//     Number [grid]" (no punctuation, common on Indian bank forms).
//  3. Box directly above the grid, horizontally overlapping. Catches
//     stacked labels ("*Company Name/Flat\nNo & Bldg Name\n[grid]").
//  4. Empty label — the polish pass will assign a synthetic field_N
//     name and the section-prefix pass may still add context.
//
// Confidence is 0.82: high enough to surface as "high" in the review
// modal, low enough to leave room for AcroForm-derived fields (1.0)
// to win on the rare PDF that exposes both AcroForm and CV-grids.
func fieldsFromGrids(pageNum int, page ocr.LayoutPage, ordered []ocr.LayoutBox) []Field {
	out := make([]Field, 0, len(page.Grids))
	for _, g := range page.Grids {
		label := bindGridLabel(g, ordered)
		// Height: prefer the grid's measured cell height. Some grids
		// have very thin lines (cell_h ~14px) which would render as
		// an unusably short widget; clamp to a sensible minimum.
		h := g.H
		if h < 18 {
			h = 18
		}
		out = append(out, Field{
			Type:       "text",
			Page:       pageNum,
			X:          g.X,
			Y:          g.Y,
			W:          g.W,
			H:          h,
			PageW:      page.W,
			PageH:      page.H,
			Label:      label,
			Confidence: 0.82,
			MaxLength:  g.Cells,
		})
	}
	return out
}

// bindGridLabel finds the most-likely text label for a grid by scanning
// surrounding OCR boxes. Empty string when nothing plausible is found —
// the caller falls back to synthetic naming downstream.
func bindGridLabel(g ocr.LayoutGrid, ordered []ocr.LayoutBox) string {
	const (
		// How far left of the grid we'll look. ~1.5 inches at 200dpi
		// — past that, the "label" is probably an unrelated field.
		leftLookahead = 300.0
		// Vertical tolerance for "same row" matching against the
		// grid's vertical center.
		rowTol = 14.0
		// How far above the grid we'll look for a stacked label.
		// Grid labels above are usually 1-2 lines tall, ~24-50px.
		aboveLookahead = 60.0
	)
	gridMidY := g.Y + g.H/2
	gridLeft := g.X
	gridRight := g.X + g.W

	// Pass 1: same-row left-side colon-terminated label.
	bestColon := ""
	bestColonDist := leftLookahead
	bestPlain := ""
	bestPlainDist := leftLookahead
	for _, b := range ordered {
		bMidY := b.Y + b.H/2
		if absf(bMidY-gridMidY) > rowTol {
			continue
		}
		if b.X+b.W > gridLeft+2 {
			continue // not to the left of the grid
		}
		dist := gridLeft - (b.X + b.W)
		if dist > leftLookahead || dist < 0 {
			continue
		}
		text := strings.TrimSpace(b.Text)
		if text == "" {
			continue
		}
		if labelEnding.MatchString(text) {
			if dist < bestColonDist {
				bestColon = strings.TrimRight(text, ": ：")
				bestColonDist = dist
			}
		} else {
			if dist < bestPlainDist {
				bestPlain = strings.TrimRight(text, ": ：")
				bestPlainDist = dist
			}
		}
	}
	if bestColon != "" {
		return bestColon
	}
	if bestPlain != "" {
		return bestPlain
	}

	// Pass 2: stacked label above the grid. Take the bottom-most box
	// that overlaps the grid horizontally and sits within
	// aboveLookahead pixels above. If the label is multi-line we'd
	// want to concatenate, but in practice the bottom-most line is
	// the most specific ("No & Bldg Name" rather than "*Company
	// Name/Flat") and is what users recognise.
	var aboveText string
	bestAboveY := -1.0
	for _, b := range ordered {
		if b.Y+b.H > g.Y {
			continue
		}
		if g.Y-(b.Y+b.H) > aboveLookahead {
			continue
		}
		// Horizontal overlap test — at least 30% of the box must lie
		// over the grid's x-range.
		ox0 := maxf(b.X, gridLeft)
		ox1 := minf(b.X+b.W, gridRight)
		if ox1-ox0 < b.W*0.3 {
			continue
		}
		text := strings.TrimSpace(b.Text)
		if text == "" {
			continue
		}
		if labelEnding.MatchString(text) || underlineRun.MatchString(text) {
			continue
		}
		if b.Y > bestAboveY {
			bestAboveY = b.Y
			aboveText = strings.TrimRight(text, ": ：")
		}
	}
	return aboveText
}

// suppressFieldsInsideGrids drops Fields that substantially overlap a
// grid Field. We use intersection-over-min-area (NOT IoU, NOT
// intersection-over-self) so two cases both qualify:
//
//   - Small field inside a big grid (placeholder text "ddmmyy" inside
//     a date strip) → inter / smallArea is high, drop.
//   - Big colon-gap field that EXTENDS past a grid (heuristic emitted
//     "Expiry Date:" running label-edge → page-margin, but a grid
//     occupies most of that span) → inter / gridArea is high, drop.
//
// Either side being mostly-covered by the other is the signal that
// they're representing the same physical field, and the grid is always
// the more accurate version (correct width, known cell count).
func suppressFieldsInsideGrids(fields, grids []Field) []Field {
	if len(grids) == 0 || len(fields) == 0 {
		return fields
	}
	kept := fields[:0]
	for _, f := range fields {
		fArea := f.W * f.H
		if fArea <= 0 {
			kept = append(kept, f)
			continue
		}
		drop := false
		for _, g := range grids {
			gArea := g.W * g.H
			if gArea <= 0 {
				continue
			}
			ix0 := maxf(f.X, g.X)
			iy0 := maxf(f.Y, g.Y)
			ix1 := minf(f.X+f.W, g.X+g.W)
			iy1 := minf(f.Y+f.H, g.Y+g.H)
			if ix1 <= ix0 || iy1 <= iy0 {
				continue
			}
			inter := (ix1 - ix0) * (iy1 - iy0)
			minArea := fArea
			if gArea < minArea {
				minArea = gArea
			}
			if inter/minArea >= 0.5 {
				drop = true
				break
			}
		}
		if !drop {
			kept = append(kept, f)
		}
	}
	return kept
}

// fieldsFromCheckboxes converts each CV-detected checkbox into a single
// checkbox Field with its label bound from the nearest OCR text.
//
// Label-binding for checkboxes follows printed-form convention — the
// label is to the RIGHT of the box ("[ ] Savings", "[ ] Tatkal", "[ ]
// Form 60"). Right-side scan is the primary; we fall back to a same-
// row left-side label only when nothing reasonable is to the right
// (rare — usually a "(✓ if applicable)"-style label).
//
// Confidence is 0.78 — slightly below grid fields (0.82) because
// checkbox CV detection has more false-positive failure modes (small
// decorative boxes, low-DPI scan artefacts forming square contours).
// Still high enough to surface as "high" in the modal so the user
// sees them by default.
func fieldsFromCheckboxes(pageNum int, page ocr.LayoutPage, ordered []ocr.LayoutBox) []Field {
	out := make([]Field, 0, len(page.Checkboxes))
	for _, cb := range page.Checkboxes {
		label := bindCheckboxLabel(cb, ordered)
		out = append(out, Field{
			Type:       "checkbox",
			Page:       pageNum,
			X:          cb.X,
			Y:          cb.Y,
			W:          cb.W,
			H:          cb.H,
			PageW:      page.W,
			PageH:      page.H,
			Label:      label,
			Confidence: 0.78,
		})
	}
	return out
}

// bindCheckboxLabel returns the label text most likely associated with
// a checkbox. The right-side scan window is intentionally narrow (~120
// px = ~0.6 inch at 200 dpi) so adjacent checkboxes in a "tick which
// applies" row don't steal each other's labels.
func bindCheckboxLabel(cb ocr.LayoutCheckbox, ordered []ocr.LayoutBox) string {
	const (
		// How far right we'll scan for the label. Adjacent checkbox
		// rows on Indian forms typically space their boxes ~150-200 px
		// apart with ~80-120 px of label width between them, so 120 px
		// is the safest cap to avoid pulling in the next checkbox's
		// label.
		rightLookahead = 120.0
		// Vertical-center tolerance for "same row" matching. Looser
		// than text-row tolerance because the OCR'd label text and
		// the empty checkbox border have different center-points
		// (text baseline vs box midline).
		rowTol = 12.0
		// Left fallback lookahead — used only when no right-side
		// label was found (e.g. "Tatkal [ ]" instead of "[ ] Tatkal").
		leftLookahead = 80.0
	)
	cbMidY := cb.Y + cb.H/2
	cbRight := cb.X + cb.W

	// Pass 1: nearest text on the same row, to the right.
	bestRight := ""
	bestRightDist := rightLookahead
	for _, b := range ordered {
		if absf((b.Y+b.H/2)-cbMidY) > rowTol {
			continue
		}
		if b.X < cbRight-2 {
			continue // not to the right of the box
		}
		text := strings.TrimSpace(b.Text)
		if text == "" {
			continue
		}
		// Skip glyph patterns that are themselves checkboxes detected
		// via OCR — we don't want a CV-detected checkbox to bind to a
		// neighbouring "[ ]" glyph as its label.
		if checkboxGlyph.MatchString(text) || radioGlyph.MatchString(text) {
			continue
		}
		dist := b.X - cbRight
		if dist < 0 || dist > rightLookahead {
			continue
		}
		if dist < bestRightDist {
			bestRight = text
			bestRightDist = dist
		}
	}
	if bestRight != "" {
		return strings.TrimRight(bestRight, ": ：")
	}

	// Pass 2: fallback — nearest text on the same row, to the left.
	bestLeft := ""
	bestLeftDist := leftLookahead
	for _, b := range ordered {
		if absf((b.Y+b.H/2)-cbMidY) > rowTol {
			continue
		}
		if b.X+b.W > cb.X+2 {
			continue
		}
		text := strings.TrimSpace(b.Text)
		if text == "" {
			continue
		}
		if checkboxGlyph.MatchString(text) || radioGlyph.MatchString(text) {
			continue
		}
		dist := cb.X - (b.X + b.W)
		if dist < 0 || dist > leftLookahead {
			continue
		}
		if dist < bestLeftDist {
			bestLeft = text
			bestLeftDist = dist
		}
	}
	return strings.TrimRight(bestLeft, ": ：")
}

// suppressFieldsAroundCheckboxes drops Fields that are likely
// duplicates of a CV-detected checkbox. Two cases the OCR-driven
// passes can produce:
//
//   - A glyph-derived checkbox Field at exactly the same location
//     (PaddleOCR happened to read the empty box as "[ ]"). Drop the
//     glyph field — the CV detector is more reliable on coordinates.
//   - A text Field whose label is the checkbox's intended label
//     ("Savings:" emitted as a text-with-gap field). Drop the text
//     field — the gap was the next checkbox's slot, not a fillable
//     text widget.
//
// Same intersection-over-min-area policy as the grid suppressor.
func suppressFieldsAroundCheckboxes(fields, checkboxes []Field) []Field {
	if len(checkboxes) == 0 || len(fields) == 0 {
		return fields
	}
	kept := fields[:0]
	for _, f := range fields {
		fArea := f.W * f.H
		if fArea <= 0 {
			kept = append(kept, f)
			continue
		}
		drop := false
		for _, c := range checkboxes {
			cArea := c.W * c.H
			if cArea <= 0 {
				continue
			}
			ix0 := maxf(f.X, c.X)
			iy0 := maxf(f.Y, c.Y)
			ix1 := minf(f.X+f.W, c.X+c.W)
			iy1 := minf(f.Y+f.H, c.Y+c.H)
			if ix1 <= ix0 || iy1 <= iy0 {
				continue
			}
			inter := (ix1 - ix0) * (iy1 - iy0)
			minArea := fArea
			if cArea < minArea {
				minArea = cArea
			}
			if inter/minArea >= 0.5 {
				drop = true
				break
			}
		}
		if !drop {
			kept = append(kept, f)
		}
	}
	return kept
}

func maxf(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func minf(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

// sectionHeader is a "block label" — a short, isolated, often
// upper-case OCR line that introduces the fields beneath it. Examples
// from real-world forms: "PERSONAL DETAILS", "Mailing Address",
// "OFFICE", "Reg Doc 1". The position pins a downward span: every
// Field whose Y is between this header and the next-header-down is
// scoped to this section.
type sectionHeader struct {
	Text string  // cleaned label, no trailing punctuation
	Y    float64 // top of header bbox (pixel space)
	H    float64
}

// detectSectionHeaders scans an already-row-sorted box list for likely
// section headers. We combine three independent signals because no
// single one is reliable on a noisy OCR layout:
//
//  1. **Larger font** — bbox H notably above the page median. Section
//     titles are typically 1.25×–2× the body height. This is the most
//     reliable signal when the form was authored with visual hierarchy.
//
//  2. **All caps** — uppercase ratio ≥ 0.7 on a short line. Catches
//     headers like "PERSONAL DETAILS" / "MAILING ADDRESS" that were
//     authored at body size but capitalised for emphasis.
//
//  3. **Solitary short line** — a 1–4 word line alone on its row with
//     mixed case. Catches "Office" / "Residence" style mini-headers
//     that lack styling but are visually obvious from whitespace.
//
// We deliberately exclude anything ending in a colon (that's a label,
// not a header) and anything matching glyph/underline patterns
// (already-handled field signals). False positives here are cheap: an
// over-eager prefix just makes a key slightly more verbose; the polish
// pass still trims to 64 chars, and the user sees the label before
// accepting.
func detectSectionHeaders(ordered []ocr.LayoutBox) []sectionHeader {
	if len(ordered) < 2 {
		return nil
	}

	// Median height for the "larger font" signal. We only consider
	// boxes with non-zero height (defensive against malformed sidecar
	// output).
	heights := make([]float64, 0, len(ordered))
	for _, b := range ordered {
		if b.H > 0 {
			heights = append(heights, b.H)
		}
	}
	if len(heights) == 0 {
		return nil
	}
	sort.Float64s(heights)
	// Lower-median: for even N, prefer the smaller of the two middle
	// values. This keeps the body-height reference stable when a page
	// has only a handful of boxes — picking the upper median for [20,
	// 32] would set the body bar at 32 and miss the actual header.
	median := heights[(len(heights)-1)/2]
	largeH := median * 1.25

	// Bucket boxes by row to detect "alone on row" candidates. Bucket
	// granularity = sameRowYTolerancePx so neighbours that PaddleOCR
	// emits with sub-pixel Y jitter still group together.
	rowOccupants := make(map[int]int)
	for _, b := range ordered {
		key := int(b.Y / sameRowYTolerancePx)
		rowOccupants[key]++
	}

	var headers []sectionHeader
	for _, b := range ordered {
		text := strings.TrimSpace(b.Text)
		if text == "" {
			continue
		}
		// Disqualifiers — these are field signals, not headers.
		if labelEnding.MatchString(text) {
			continue
		}
		if checkboxGlyph.MatchString(text) || radioGlyph.MatchString(text) || underlineRun.MatchString(text) {
			continue
		}

		words := strings.Fields(text)
		if len(words) == 0 || len(words) > 6 {
			continue
		}
		// Reject lines that look like sentences/instructions (long, with
		// terminal punctuation) — real headers are short and dense.
		if strings.HasSuffix(text, ".") && len(words) > 3 {
			continue
		}

		upperRatio := upperLetterRatio(text)
		alone := rowOccupants[int(b.Y/sameRowYTolerancePx)] == 1

		isHeader := false
		switch {
		case b.H >= largeH && len(words) <= 6:
			// Visual-hierarchy signal: bigger font.
			isHeader = true
		case upperRatio >= 0.7 && countLetters(text) >= 3:
			// All-caps signal — works even at body size.
			isHeader = true
		case alone && len(words) <= 4 && upperRatio >= 0.4:
			// Solitary short line with at least some capitalisation.
			isHeader = true
		}
		if !isHeader {
			continue
		}

		clean := strings.Trim(text, " .:-—_")
		if clean == "" {
			continue
		}
		headers = append(headers, sectionHeader{Text: clean, Y: b.Y, H: b.H})
	}
	// Order by Y so sectionFor's linear scan can stop early.
	sort.SliceStable(headers, func(i, j int) bool { return headers[i].Y < headers[j].Y })
	return headers
}

// sectionFor returns the text of the closest section header whose
// bottom edge sits above y. Empty string when no header has been
// crossed yet — i.e. the field is in the page preamble.
func sectionFor(y float64, headers []sectionHeader) string {
	var best string
	for _, h := range headers {
		if h.Y+h.H <= y {
			best = h.Text
		} else {
			// headers are sorted ascending by Y; everything below the
			// field can't be its section.
			break
		}
	}
	return best
}

// upperLetterRatio computes uppercase-letters / total-letters on s.
// Non-letter runes (digits, punctuation, whitespace) are excluded
// from the denominator so "DOB:" and "ID #" still register as
// fully-uppercase even though only half their characters are letters.
func upperLetterRatio(s string) float64 {
	letters, upper := 0, 0
	for _, r := range s {
		if unicode.IsLetter(r) {
			letters++
			if unicode.IsUpper(r) {
				upper++
			}
		}
	}
	if letters == 0 {
		return 0
	}
	return float64(upper) / float64(letters)
}

func countLetters(s string) int {
	n := 0
	for _, r := range s {
		if unicode.IsLetter(r) {
			n++
		}
	}
	return n
}

// makeGlyphField wraps a checkbox/radio glyph box into a Field. The
// widget bbox is the glyph itself — the user can resize in the
// designer if they want a larger touch target.
func makeGlyphField(typ string, pageNum int, page ocr.LayoutPage, b ocr.LayoutBox, label string) Field {
	h := b.H
	if h < glyphFieldHPx*0.6 {
		h = glyphFieldHPx
	}
	return Field{
		Type:  typ,
		Page:  pageNum,
		X:     b.X,
		Y:     b.Y,
		W:     b.W,
		H:     h,
		PageW: page.W,
		PageH: page.H,
		Label: label,
	}
}

// makeSignatureField anchors a signature widget next to a keyword
// box. We place it to the right of the keyword if there's room
// (label says "Signature:" and the line continues), otherwise below
// (label is on its own line above a blank zone). The dimensions are
// fixed to a typical signature-line size so the rendered overlay
// looks reasonable even before the user accepts the proposal.
func makeSignatureField(pageNum int, page ocr.LayoutPage, b ocr.LayoutBox) Field {
	rightSpace := float64(page.W) - (b.X + b.W) - rightMarginPx
	var x, y, w, h float64
	if rightSpace >= sigWPx {
		// Place to the right of the keyword on the same baseline.
		x = b.X + b.W + 6
		y = b.Y - (sigHPx-b.H)/2
		w = sigWPx
		h = sigHPx
	} else {
		// Place below the keyword.
		x = b.X
		y = b.Y + b.H + 4
		w = sigWPx
		h = sigHPx
	}
	if x < rightMarginPx {
		x = rightMarginPx
	}
	if y < 0 {
		y = b.Y
	}
	return Field{
		Type:       "signature",
		Page:       pageNum,
		X:          x,
		Y:          y,
		W:          w,
		H:          h,
		PageW:      page.W,
		PageH:      page.H,
		Label:      strings.TrimSpace(b.Text),
		Confidence: 0.80,
	}
}

// makeTextFromLabel emits a text widget that fills the horizontal
// gap to the right of a colon-terminated label. ok=false when no
// usable gap is found (the next box on the row is too close).
func makeTextFromLabel(pageNum int, page ocr.LayoutPage, ordered []ocr.LayoutBox, i int) (Field, bool) {
	label := ordered[i]
	gapStart := label.X + label.W + 6 // small breathing room past the colon

	// Find the leftmost box on the same row to the right of the label.
	rightEdge := float64(page.W) - rightMarginPx
	for j, other := range ordered {
		if j == i {
			continue
		}
		if absf(other.Y-label.Y) > sameRowYTolerancePx {
			continue
		}
		if other.X > label.X && other.X < rightEdge {
			rightEdge = other.X - 4
		}
	}
	w := rightEdge - gapStart
	if w < minTextFieldWPx {
		return Field{}, false
	}
	conf := 0.70
	if w >= 200 {
		conf = 0.78 // wide gap = high confidence the user wants this filled
	}
	h := label.H
	if h < 16 {
		h = 22
	}
	return Field{
		Type:       "text",
		Page:       pageNum,
		X:          gapStart,
		Y:          label.Y,
		W:          w,
		H:          h,
		PageW:      page.W,
		PageH:      page.H,
		Label:      strings.TrimRight(strings.TrimSpace(label.Text), ":："),
		Confidence: conf,
	}, true
}

// makeTextFromUnderline emits a text widget overlaid on a bare
// underline run. We scan to the left on the same row for a label
// hint; if nothing is found we still emit, but at lower confidence
// and with a synthetic numeric label so the modal can group
// sensibly.
func makeTextFromUnderline(pageNum int, page ocr.LayoutPage, ordered []ocr.LayoutBox, i int) (Field, bool) {
	line := ordered[i]
	if line.W < minTextFieldWPx {
		return Field{}, false
	}
	label := ""
	bestDist := 9999.0
	for j, other := range ordered {
		if j == i {
			continue
		}
		if absf(other.Y-line.Y) > sameRowYTolerancePx {
			continue
		}
		// Same row, to the left of the underline.
		if other.X+other.W <= line.X {
			d := line.X - (other.X + other.W)
			if d < bestDist {
				bestDist = d
				label = strings.TrimRight(strings.TrimSpace(other.Text), ":：")
			}
		}
	}
	conf := 0.55
	if label != "" {
		conf = 0.70 // promoted: underline + nearby label is a strong signal
	}
	h := line.H
	if h < 16 {
		h = 22
	}
	return Field{
		Type:       "text",
		Page:       pageNum,
		X:          line.X,
		Y:          line.Y - h*0.6, // sit the field above the underline, not on it
		W:          line.W,
		H:          h,
		PageW:      page.W,
		PageH:      page.H,
		Label:      label,
		Confidence: conf,
	}, true
}

// neighborLabelRight returns the trimmed text of the nearest box on
// the same row immediately to the right of i. Used to attach
// "Subscribe to newsletter" to a leading "[ ]" checkbox glyph. The
// neighbour is marked consumed so it doesn't separately trigger a
// label-ending text emission.
func neighborLabelRight(ordered []ocr.LayoutBox, i int, consumed []bool) string {
	src := ordered[i]
	bestJ := -1
	bestDist := 80.0 // px window — beyond this and the label probably belongs to a different glyph
	for j, other := range ordered {
		if j == i || consumed[j] {
			continue
		}
		if absf(other.Y-src.Y) > sameRowYTolerancePx {
			continue
		}
		if other.X <= src.X+src.W {
			continue
		}
		d := other.X - (src.X + src.W)
		if d < bestDist {
			bestDist = d
			bestJ = j
		}
	}
	if bestJ < 0 {
		return ""
	}
	consumed[bestJ] = true
	return strings.TrimSpace(ordered[bestJ].Text)
}

// suppressFollowingUnderline hides a "________" run that sits on the
// same row directly to the right of a signature keyword, so we don't
// emit both a signature and a text widget at the same place.
func suppressFollowingUnderline(ordered []ocr.LayoutBox, consumed []bool, i int) {
	src := ordered[i]
	for j, other := range ordered {
		if j == i || consumed[j] {
			continue
		}
		if absf(other.Y-src.Y) > sameRowYTolerancePx {
			continue
		}
		if other.X <= src.X+src.W {
			continue
		}
		if underlineRun.MatchString(strings.TrimSpace(other.Text)) {
			consumed[j] = true
		}
	}
}

func absf(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}
