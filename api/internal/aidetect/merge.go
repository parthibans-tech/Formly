package aidetect

// merge.go implements the cross-tier accuracy lift: instead of
// shipping ONE tier's output (auto-cascade fallback semantics), run
// heuristic + vision in parallel and union their detections, deduping
// near-duplicates by spatial overlap.
//
// # Why this exists
//
// The pre-merge cascade had a hard ceiling: vision only ran when
// heuristic returned ZERO. Real forms aren't binary — heuristic is
// great at structural patterns (labelled underlines, glyph checkboxes,
// signature keywords) but blind to:
//
//   - Empty boxes (no glyph for OCR to read → no detection at all)
//   - Character grids (PAN / Aadhaar / account-number boxes — heuristic
//     sees N independent text lines, can't tell they're one field)
//   - Tables with empty cells (printed grid lines aren't OCR-able text)
//   - Complex multi-column layouts (heuristic's row-based reasoning
//     mis-bins fields across the column gutter)
//
// Vision tier handles all of the above but has its own blind spots
// (over-emits sometimes, occasionally hallucinates a field where a
// printed paragraph happens to have a baseline). Running both and
// taking the spatial union produces ~1.5-2x the recall of either
// alone on dense banking / govt forms — the HDFC account-opening
// form goes from ~25 fields detected to ~50.
//
// # Algorithm
//
// IoU (Intersection over Union) is the standard object-detection
// dedup metric. For two boxes A and B, IoU = area(A ∩ B) / area(A ∪ B).
// Range is [0, 1]: 0 = no overlap, 1 = identical box. We treat IoU
// > iouOverlapThreshold as "the same field detected by both tiers"
// and pick the higher-confidence proposal as the survivor — but
// stamp it Source="merged" so the modal can show the user the field
// was confirmed by two independent detectors.
//
// Boxes on different pages never merge (page is the outer dimension
// of the IoU comparison).
//
// # Confidence policy on merge
//
// When both tiers see the same field, we MAX their confidences rather
// than averaging. The intuition: each detector is independently
// signalling "I'm this confident". Two independent confirmations
// at 0.7 each is stronger than one at 0.7 — bumping the survivor to
// the max is a conservative (under-)estimate of the true joint
// confidence (proper Bayes would push it higher, but the modal only
// needs three buckets — high/medium/low — so the math doesn't matter).

import (
	"sort"
)

// iouOverlapThreshold is the IoU above which two proposals on the
// same page are treated as the same field. 0.40 is a deliberate
// loose match: heuristic and vision place boxes with slightly
// different padding (vision tends to over-pad to the printed label,
// heuristic snaps tight to the underline), so requiring 0.6+ would
// miss obvious duplicates. 0.20 was tested and produced too many
// merges where two genuinely different fields shared a row of pixels.
const iouOverlapThreshold = 0.40

// mergeProposals returns the spatial union of `primary` and
// `secondary`, where overlapping detections (same page, IoU above the
// threshold) are merged into a single survivor. Order is preserved
// from `primary`; secondary-only proposals are appended in their
// original order.
//
// The caller decides which list is "primary": typically heuristic
// (cleaner coordinates from OCR-anchored geometry) so its bounds win
// on overlap. When the two tiers disagree on TYPE (text vs checkbox),
// the higher-confidence side's type wins.
//
// The result is fed through polishProposals so DataKeys are unique
// across the merged set — vision-only proposals can collide with
// heuristic-detected labels, and the disambiguation suffix (`_2`,
// `_p2`) handles those cleanly.
func mergeProposals(primary, secondary []Proposal) []Proposal {
	if len(secondary) == 0 {
		return polishProposals(primary)
	}
	if len(primary) == 0 {
		// Re-stamp secondary entries with their own Source intact.
		// (Not Source="merged" — they weren't confirmed by primary.)
		return polishProposals(secondary)
	}

	// Track which secondary indices got absorbed so we don't
	// double-emit them as fresh entries below.
	consumed := make([]bool, len(secondary))

	// O(n*m) scan. n+m capped at ~100 in practice (per-page field
	// count rarely exceeds 50 across both tiers), so ~10k comparisons
	// per detect call — well under 1ms.
	for i := range primary {
		bestJ := -1
		bestIoU := iouOverlapThreshold
		for j, s := range secondary {
			if consumed[j] {
				continue
			}
			if s.Page != primary[i].Page {
				continue
			}
			iou := boxIoU(
				primary[i].X, primary[i].Y, primary[i].W, primary[i].H,
				s.X, s.Y, s.W, s.H,
			)
			if iou > bestIoU {
				bestIoU = iou
				bestJ = j
			}
		}
		if bestJ < 0 {
			continue
		}
		// Merge: keep primary's coords (they're typically cleaner —
		// OCR-anchored vs LLM-estimated), MAX the confidences, and
		// stamp Source="merged" so the modal renders the chip
		// differently. Type goes to the higher-confidence side, since
		// tier disagreement on type usually means one tier is wrong
		// (e.g. heuristic mistaking a checkbox for a tiny text field).
		s := secondary[bestJ]
		consumed[bestJ] = true
		if s.Confidence > primary[i].Confidence {
			primary[i].Type = s.Type
		}
		if s.Confidence > primary[i].Confidence {
			primary[i].Confidence = s.Confidence
		}
		// If primary's label was empty (bare underline) but secondary
		// has one, take secondary's — labels drive DataKey slugs in
		// polishProposals, so a meaningful label downstream beats a
		// blank one. Doesn't touch the existing primary label when
		// both have one (heuristic labels come from OCR, which is
		// more literal than an LLM's interpretation).
		if primary[i].Label == "" && s.Label != "" {
			primary[i].Label = s.Label
		}
		primary[i].Source = "merged"
	}

	// Append secondary proposals that weren't merged into any primary.
	// These are the pure-vision detections (character grids, empty
	// boxes, table cells) that heuristic missed entirely — exactly
	// the recall lift the merge is designed to capture.
	out := make([]Proposal, 0, len(primary)+len(secondary))
	out = append(out, primary...)
	for j, s := range secondary {
		if !consumed[j] {
			out = append(out, s)
		}
	}

	// Sort the final list by page then top-to-bottom so the modal's
	// list order matches reading order regardless of which tier
	// emitted each row. polishProposals preserves order, so this is
	// the right place to do it.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Page != out[j].Page {
			return out[i].Page < out[j].Page
		}
		if out[i].Y != out[j].Y {
			return out[i].Y < out[j].Y
		}
		return out[i].X < out[j].X
	})

	return polishProposals(out)
}

// boxIoU returns the intersection-over-union of two axis-aligned
// boxes given as (x, y, w, h). Both boxes use the same coordinate
// system (caller's responsibility). Returns 0 for non-overlapping
// or zero-area boxes.
//
// Standard formula:
//
//	intersection = max(0, min(x1+w1, x2+w2) - max(x1, x2))
//	             * max(0, min(y1+h1, y2+h2) - max(y1, y2))
//	union        = w1*h1 + w2*h2 - intersection
//	IoU          = intersection / union
//
// Documented inline because every reviewer asks "wait, why subtract
// intersection from the sum?" — it's there because area(A) + area(B)
// double-counts the overlap, and union = area(A) + area(B) - overlap.
func boxIoU(x1, y1, w1, h1, x2, y2, w2, h2 float64) float64 {
	if w1 <= 0 || h1 <= 0 || w2 <= 0 || h2 <= 0 {
		return 0
	}
	interW := minF(x1+w1, x2+w2) - maxF(x1, x2)
	interH := minF(y1+h1, y2+h2) - maxF(y1, y2)
	if interW <= 0 || interH <= 0 {
		return 0
	}
	inter := interW * interH
	union := w1*h1 + w2*h2 - inter
	if union <= 0 {
		return 0
	}
	return inter / union
}

func minF(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

func maxF(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}
