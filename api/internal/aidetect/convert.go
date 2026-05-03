package aidetect

// convert.go isolates the cascade policy + coordinate-translation
// logic from the HTTP handler so the rules are unit-testable without
// spinning up Postgres or the OCR sidecar.

import (
	"fmt"
	"strings"

	"github.com/docforge/api/internal/aidetect/heuristic"
)

// Strategy selects which detection tier(s) to run. The handler reads
// `?strategy=` from the query string and parses it through
// parseStrategy.
type Strategy string

const (
	// StrategyAuto is the default — try AcroForm first, then heuristic
	// if AcroForm produces zero, then vision-LLM (Phase 4) if heuristic
	// also produces zero AND the operator's AI provider supports
	// vision. Stops at the first tier that returns a non-empty result.
	StrategyAuto Strategy = "auto"

	// StrategyAcroForm runs ONLY the AcroForm tier — the deterministic
	// path. Useful when the caller knows the PDF was authored in
	// Acrobat / Word / LibreOffice and wants to skip the cost of OCR
	// rasterization on a known-tagged file.
	StrategyAcroForm Strategy = "acroform"

	// StrategyHeuristic skips AcroForm and goes straight to OCR-based
	// inference. Useful when the AcroForm extraction is known to be
	// noisy (e.g. forms with leftover legacy widgets) and the user
	// wants the cleaner heuristic output.
	StrategyHeuristic Strategy = "heuristic"

	// StrategyVision pins the vision-LLM tier — useful for "show me
	// what the model thinks" debugging or for forms whose layout the
	// heuristic tier mis-handles (e.g. tables, multi-column ID cards).
	// Returns an empty result with an explanatory message if the
	// active AI provider doesn't advertise vision capability.
	StrategyVision Strategy = "vision"

	// StrategyMerge runs heuristic + vision in parallel and unions
	// their detections (IoU dedup; see merge.go). Best recall on
	// dense forms — heuristic catches structural patterns, vision
	// catches semantic ones, the merge captures both. Falls back to
	// whichever tier IS available when one isn't (vision config
	// missing → ships heuristic-only with a note in Message).
	//
	// `auto` ALSO performs the merge when both tiers are available;
	// the explicit `merge` strategy exists so callers can pin this
	// behaviour even when AcroForm extraction succeeded (auto would
	// short-circuit on AcroForm hits, merge does not).
	StrategyMerge Strategy = "merge"
)

// parseStrategy normalises the raw query value. Empty / unrecognised
// → auto, so callers can pass through user-supplied strings without
// pre-validating.
func parseStrategy(raw string) Strategy {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "acroform":
		return StrategyAcroForm
	case "heuristic":
		return StrategyHeuristic
	case "vision":
		return StrategyVision
	case "merge":
		return StrategyMerge
	default:
		return StrategyAuto
	}
}

// proposalsFromHeuristic converts pixel-space heuristic.Field
// records into PDF user-space Proposal records. The conversion has
// two parts:
//
//  1. Pixel → point scaling. The sidecar rasterizes at `dpi` pixels
//     per inch; PDF user-space is 72 points per inch. So the scale
//     factor is 72/dpi (e.g. 0.36 at 200dpi).
//  2. Y-axis flip. Image-space puts the origin at the top-left and
//     +y goes downward; PDF user-space puts the origin at the
//     bottom-left and +y goes upward. So pdf_y = page_h_pt - (px_y
//     + px_h) * ptPerPx.
//
// dpi must match what the sidecar used to rasterize. The handler
// reads it from h.OCR.DPI and passes it through.
//
// idxOffset is added to the synthetic-label counter when the caller
// wants stable data keys across multiple cascade tiers (e.g.
// AcroForm produced 5 named fields, heuristic should number its
// unnamed underlines starting at 6 not 1).
func proposalsFromHeuristic(fields []heuristic.Field, dpi int, idxOffset int) []Proposal {
	if dpi <= 0 {
		dpi = 200
	}
	ptPerPx := 72.0 / float64(dpi)
	out := make([]Proposal, 0, len(fields))
	unnamedCounter := idxOffset
	for _, f := range fields {
		pageWPt := float64(f.PageW) * ptPerPx
		pageHPt := float64(f.PageH) * ptPerPx

		xPt := f.X * ptPerPx
		wPt := f.W * ptPerPx
		hPt := f.H * ptPerPx
		// Flip Y so we land in PDF user-space (origin bottom-left).
		yPt := pageHPt - (f.Y+f.H)*ptPerPx

		// Defensive clamp — rounding + the upstream OCR's box
		// extension can occasionally produce a sub-pixel negative
		// coordinate. The static designer tolerates these but they
		// look ugly in the review modal.
		if yPt < 0 {
			yPt = 0
		}
		if xPt < 0 {
			xPt = 0
		}

		label := f.Label
		dataKey := safeDataKey(label)
		if dataKey == "" {
			unnamedCounter++
			dataKey = fmt.Sprintf("field_%d", unnamedCounter)
			if label == "" {
				label = dataKey
			}
		}

		props := heuristicProps(f.Type)
		// Grid-derived fields carry a known cell count — surface it as
		// the maxLength prop so the designer enforces it for the user.
		// A 10-cell PAN grid then produces a 10-character text field
		// instead of an unbounded one the user has to manually cap.
		if f.MaxLength > 0 {
			props["maxLength"] = f.MaxLength
		}

		out = append(out, Proposal{
			Type:       f.Type,
			Page:       f.Page,
			X:          round2(xPt),
			Y:          round2(yPt),
			W:          round2(wPt),
			H:          round2(hPt),
			DataKey:    dataKey,
			Label:      label,
			PageW:      round2(pageWPt),
			PageH:      round2(pageHPt),
			Props:      props,
			Source:     "heuristic",
			Confidence: f.Confidence,
		})
	}
	// polishProposals re-derives clean snake_case keys from the labels
	// and disambiguates duplicates. Without this, two heuristic-detected
	// "Name" fields on the same page would produce identical DataKeys
	// and the modal would render them as one logical row with the
	// second silently overwriting the first on accept.
	return polishProposals(out)
}

// heuristicProps mirrors aidetect.go's defaultPropsFor but for the
// heuristic tier where we don't have a backing acroform.Field to
// pull MaxLen / Tooltip / Options from. Pure defaults; the user
// edits in the modal.
func heuristicProps(widgetType string) map[string]interface{} {
	props := map[string]interface{}{
		"fontSize":   12,
		"fontFamily": "Helvetica",
		"color":      "#111827",
		"align":      "L",
	}
	switch widgetType {
	case "checkbox", "radio":
		// Glyph widgets — strip text styling.
		delete(props, "fontSize")
		delete(props, "fontFamily")
		delete(props, "color")
		delete(props, "align")
	case "signature":
		// Signature widgets render their own UI; the static designer
		// ignores text-style props but we keep fontSize for the
		// "Signed by:" caption.
	}
	return props
}

// round2 rounds to 2 decimal places, matching the sidecar's bbox
// rounding so JSON diffs stay meaningful.
func round2(x float64) float64 {
	return float64(int(x*100+0.5)) / 100
}
