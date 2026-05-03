// Package visionllm is the third (final) tier of the auto-field-
// detection cascade. When AcroForm extraction finds nothing AND the
// OCR-driven heuristic finds nothing — typically a visually complex
// scanned form (multi-column layout, table-style label/blank pairs,
// stylised checkboxes the OCR engine misreads, …) — we ask a vision
// LLM to point at the fillable regions directly.
//
// # Why this tier exists
//
// The heuristic detector in sibling package `heuristic` is rule-
// based: "line ending in colon + same-row gap → text field",
// "bracket-bracket glyph → checkbox", and so on. It's fast, cheap,
// and explainable, but it only sees what PaddleOCR transcribes — and
// PaddleOCR will skip blank-on-white form regions entirely (no text,
// nothing to detect). A vision model looking at the page bitmap can
// see those blank lines, dotted leaders, and shaded boxes that the
// OCR engine returns no boxes for.
//
// # Design
//
// One Chat call per page, with the page raster attached as an
// ImagePart. The prompt asks for a strict JSON shape:
//
//	{ "fields": [ { "type": "text" | "checkbox" | "radio" | "signature",
//	                "x": <px>, "y": <px>, "w": <px>, "h": <px>,
//	                "label": "Full Name",
//	                "confidence": 0.7 } ] }
//
// Coordinates are pixel-space at the page raster's W/H so we re-use
// the heuristic tier's pixel→PDF translation (`proposalsFromHeuristic`
// in the parent aidetect package) without a second code path.
//
// We don't fan out pages in parallel even though the AI seam is
// goroutine-safe: the typical fall-through case is a 1-3 page form,
// concurrent requests would just thrash the model's KV cache (each
// page is a fresh context), and serial calls give us deterministic
// ordering for the modal.
//
// # Failure modes
//
// Per-page failures (model unreachable, malformed JSON response,
// validation error) are logged and the page is skipped — the cascade
// keeps going with whatever the other pages produced. A doc with one
// bad page still gets useful results from the rest. Whole-detection
// failure is reserved for "AI is disabled" and "vision capability
// not advertised", which short-circuit before we even open the
// rasters.
//
// # Confidence
//
// We pass through whatever confidence the model emits, clamped to
// [0, 1] and floored at 0.4 (anything lower would visually disappear
// in the modal's "low confidence" filter). Models that don't emit a
// confidence field default to 0.65 — middle-of-road, signals "this
// came from vision, treat with mild suspicion".
package visionllm

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"github.com/docforge/api/internal/ai"
	"github.com/docforge/api/internal/aidetect/heuristic"
	"github.com/docforge/api/internal/ocr"
)

// Defaults tuned for the Phase-4 vision tier. All exported so the
// future "platform admin tunes detection" UI can read/override.
const (
	// DefaultConfidence is stamped on fields whose JSON didn't carry a
	// `confidence` key. Mid-band on purpose — high enough that the
	// modal default-shows the field, low enough that the user knows
	// vision-AI is more speculative than AcroForm/heuristic.
	DefaultConfidence = 0.65

	// MinConfidence floors what the model can claim. Models love to
	// emit 0.99 for everything when prompted for confidence; we want
	// the rubric distribution to actually mean something across tiers.
	MinConfidence = 0.40
	MaxConfidence = 0.95

	// MaxImageBytes guards us from accidentally shoving a 20MB raster
	// at a model with a 5MB per-image cap (Anthropic). The sidecar's
	// /raster/pdf already keeps DPI conservative for vision use, but
	// this is a defence-in-depth check at the Go boundary.
	MaxImageBytes = 5 << 20 // 5 MiB
)

// validTypes is the widget-type vocabulary the model is allowed to
// emit. Mirrors the heuristic detector's surface so downstream code
// (props synthesis, designer rendering) doesn't need a special case.
var validTypes = map[string]struct{}{
	"text":      {},
	"checkbox":  {},
	"radio":     {},
	"signature": {},
}

// systemPrompt is the role the model takes for every page. Tuned for
// COMPLETENESS — early versions ("prefer fewer high-quality detections")
// optimised for precision and missed half the fields on dense Indian
// banking forms (PAN, Aadhaar, account-opening). The current rubric
// asks for recall: emit every region that LOOKS fillable, let the
// human reviewer remove false positives in the modal. False negatives
// are MUCH more expensive than false positives because the user has
// to manually drag a widget for every miss; false positives just need
// a single un-check in the review modal.
//
// The "common form patterns" enumeration is the single biggest
// quality lever — vision models generalise from the prompt. Naming
// character grids ("PAN _ _ _ _ _ _ _ _ _ _") explicitly turns them
// from "ten unrelated boxes" into "one text field" in the model's
// reasoning, which is the right grouping for downstream rendering.
const systemPrompt = `You are a form-field detector. Look at a scanned form page bitmap and return a JSON list of every fillable region a human would write into.

Respond with EXACTLY one JSON object, no prose, no markdown fences:
{"fields":[{"type":"text|checkbox|radio|signature","x":<px>,"y":<px>,"w":<px>,"h":<px>,"label":"<nearby printed label or empty>","confidence":<0..1>}]}

Coordinates are pixels measured from the top-left of the image.

Common fillable patterns to detect:
  - Underline runs after a printed label ("Name: ____________") → one TEXT field spanning the underline
  - Empty boxes / rectangles after a label                       → one TEXT field per box
  - Character grids (rows of single-letter boxes for PAN, Aadhaar, account number, IFSC, mobile, date)
                                                                 → ONE text field spanning the whole grid, NOT one per cell
  - Date grids "DD MM YYYY" with one box per character           → ONE text field spanning the whole grid
  - Square / circle marks next to options                        → CHECKBOX (independent options) or RADIO (mutually exclusive)
  - Long horizontal blank lines under "Signature"                → SIGNATURE
  - Address blocks with multiple ruled lines                     → ONE text field covering the full block
  - Empty cells inside a printed table                           → one TEXT field per cell

Be COMPLETE. It is much better to emit a borderline field the user can dismiss than to miss a field they have to drag manually. If you can see a place the form expects input, emit it.

Things that are NOT fields and must be skipped:
  - Printed labels, section headings, instructions
  - Form serial numbers, bank logos, barcodes, QR codes
  - Pre-filled text the user is not expected to change
  - Decorative rules and borders

For each field, set "label" to the nearest printed text that names it. When the field belongs to a SECTION HEADER, REPEATED ROW, or LABELED GROUP, INCLUDE the section/row name in the label so EVERY label is unique across the page. This is critical — generic labels like "Doc No" appearing in three sections produce colliding integrator keys.

Use " - " (space hyphen space) to separate the section qualifier from the field name:
  - "Reg Doc 1 - Doc No"   (not just "Doc No")
  - "Reg Doc 2 - Expiry Date"
  - "Other Doc - Entity Proof"
  - "Mailing Address - City"          (not just "City")
  - "Mailing Address - PIN Code"
  - "Office Address - PIN Code"       (so it doesn't collide with the mailing one)
  - "Applicant - Name"                (when a co-applicant section also exists)
  - "Co-Applicant - Name"
  - "Nominee 1 - Date of Birth"
  - "Nominee 2 - Date of Birth"

Section qualifiers come from:
  - Bold / large headers above a block ("MAILING Address", "OFFICE", "NOMINEE DETAILS")
  - Row labels at the start of repeated rows ("Reg. Doc. 1", "Reg. Doc. 2", "Other Doc.")
  - Sidebar labels marking a column ("Applicant", "Co-Applicant", "Spouse")

If no qualifier applies (the field stands alone with no group context), use the bare label. Empty label is allowed only for bare underlines with no nearby printed text at all.

Confidence: 0.85+ for clearly-marked widgets with obvious labels, 0.6-0.8 for inferred fields, 0.4-0.6 for borderline guesses you're including for completeness.`

// userPromptForPage gives the model the per-page dimensions so it
// stays anchored: vision models occasionally hallucinate coordinates
// outside the actual image bounds when no scale is mentioned. We
// also restate the JSON shape one more time — the system prompt is
// long, the per-turn reminder costs ~30 tokens, and it materially
// reduces "the model wrote prose" failures.
//
// The "be exhaustive" reminder echoes the system-prompt completeness
// guidance because vision models tend to truncate the field list when
// the per-turn instruction is short — repeating the directive in the
// turn that carries the image keeps it salient at sampling time.
func userPromptForPage(pageW, pageH int) string {
	return fmt.Sprintf(
		"This page is %dx%d pixels. Find EVERY fillable field — be exhaustive, prefer over-detection to under-detection — and return the JSON object as instructed. Do not add commentary.",
		pageW, pageH,
	)
}

// modelOut matches the JSON response shape the prompt requests. We
// keep it permissive (everything is `*float64` / `string`) so a model
// that omits the confidence key, or emits an integer for a
// coordinate, doesn't trip the unmarshal.
type modelOut struct {
	Fields []modelField `json:"fields"`
}

type modelField struct {
	Type       string   `json:"type"`
	X          float64  `json:"x"`
	Y          float64  `json:"y"`
	W          float64  `json:"w"`
	H          float64  `json:"h"`
	Label      string   `json:"label"`
	Confidence *float64 `json:"confidence,omitempty"`
}

// Detect runs the vision tier across every page raster and returns
// the merged list of detected fields in pixel space. The caller
// (aidetect.DetectFields) translates to PDF user-space via the same
// `proposalsFromHeuristic` helper used for the heuristic tier — the
// two tiers emit the same Field struct on purpose.
//
// Empty input or a non-vision provider returns nil + nil — the
// cascade orchestrator interprets that as "this tier didn't find
// anything" and surfaces a friendly message.
func Detect(ctx context.Context, client ai.Client, pages []ocr.RasterPage) ([]heuristic.Field, error) {
	if client == nil || !client.Enabled() {
		return nil, nil
	}
	if !client.Capabilities().Vision {
		return nil, nil
	}
	if len(pages) == 0 {
		return nil, nil
	}

	out := make([]heuristic.Field, 0, len(pages)*4)
	for i := range pages {
		pageNum := i + 1
		fields, err := detectPage(ctx, client, &pages[i], pageNum)
		if err != nil {
			// Per-page failure: log and skip. The cascade still gets
			// whatever the other pages produced — a 5-page form with
			// one bad render shouldn't return zero proposals.
			log.Printf("visionllm: page %d: %v", pageNum, err)
			continue
		}
		out = append(out, fields...)
	}
	return out, nil
}

// detectPage handles a single page's request/response cycle. Split
// out so the per-page error handling stays tight in Detect and so
// tests can drive one page at a time.
func detectPage(ctx context.Context, client ai.Client, page *ocr.RasterPage, pageNum int) ([]heuristic.Field, error) {
	imgBytes, err := page.Bytes()
	if err != nil {
		return nil, fmt.Errorf("decode raster: %w", err)
	}
	if len(imgBytes) == 0 {
		return nil, nil
	}
	if len(imgBytes) > MaxImageBytes {
		return nil, fmt.Errorf("page raster %d bytes exceeds %d limit", len(imgBytes), MaxImageBytes)
	}

	resp, err := client.Chat(ctx, ai.ChatRequest{
		// Temperature 0 isn't strictly required for vision but it
		// makes the JSON shape stable across retries — vision models
		// at higher temps will sometimes wander into prose mid-array.
		Temperature: 0,
		// Cap the response — if the model wants to detect 200 fields
		// on one page that's almost certainly a hallucination loop.
		MaxTokens: 2048,
		Messages: []ai.ChatMessage{
			{Role: "system", Content: systemPrompt},
			{
				Role:    "user",
				Content: userPromptForPage(page.W, page.H),
				Images: []ai.ImagePart{{
					MIME: "image/png",
					Data: imgBytes,
				}},
			},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("ai chat: %w", err)
	}

	parsed, err := parseModelOutput(resp.Content)
	if err != nil {
		return nil, fmt.Errorf("parse model output: %w (raw: %s)", err, truncate(resp.Content, 200))
	}

	return validateAndConvert(parsed, pageNum, page.W, page.H), nil
}

// parseModelOutput extracts the JSON object from the model's reply.
// Most well-behaved vision models return the bare object as
// instructed; the rest wrap it in markdown code fences (```json … ```)
// or pad with prose ("Here are the fields I found: { … }"). We try
// the strict path first (json.Unmarshal on the full string) then
// fall back to scanning for the outermost {…}.
func parseModelOutput(raw string) (modelOut, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return modelOut{}, fmt.Errorf("empty response")
	}
	// Fast path: the model obeyed and emitted bare JSON.
	var direct modelOut
	if err := json.Unmarshal([]byte(trimmed), &direct); err == nil {
		return direct, nil
	}
	// Strip markdown fences if present.
	stripped := stripCodeFences(trimmed)
	if stripped != trimmed {
		var fenced modelOut
		if err := json.Unmarshal([]byte(stripped), &fenced); err == nil {
			return fenced, nil
		}
	}
	// Last-resort: scan for the first balanced top-level {…}. Cheap
	// because we only walk the response once.
	if obj := extractFirstJSONObject(trimmed); obj != "" {
		var loose modelOut
		if err := json.Unmarshal([]byte(obj), &loose); err == nil {
			return loose, nil
		}
	}
	return modelOut{}, fmt.Errorf("no JSON object found")
}

// stripCodeFences removes a leading ```json (or just ```) and trailing
// ``` if present. Idempotent if no fence exists.
func stripCodeFences(s string) string {
	if !strings.HasPrefix(s, "```") {
		return s
	}
	// Drop the opening fence + optional language tag up to the first newline.
	if nl := strings.IndexByte(s, '\n'); nl > 0 {
		s = s[nl+1:]
	} else {
		s = strings.TrimPrefix(s, "```json")
		s = strings.TrimPrefix(s, "```")
	}
	s = strings.TrimSpace(s)
	if i := strings.LastIndex(s, "```"); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

// extractFirstJSONObject returns the substring spanning the first
// balanced { … } in s, or "" if none is found. Brace counting honours
// strings (so a "{" inside a quoted value doesn't break the count).
func extractFirstJSONObject(s string) string {
	start := strings.IndexByte(s, '{')
	if start < 0 {
		return ""
	}
	depth := 0
	inStr := false
	escape := false
	for i := start; i < len(s); i++ {
		c := s[i]
		if escape {
			escape = false
			continue
		}
		if inStr {
			if c == '\\' {
				escape = true
			} else if c == '"' {
				inStr = false
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return s[start : i+1]
			}
		}
	}
	return ""
}

// validateAndConvert walks the parsed model output, drops fields that
// fail validation (unknown type, off-page coords, zero-area boxes),
// and produces heuristic.Field records the cascade can translate.
//
// Validation is deliberately strict: we'd rather drop a marginal
// proposal than show the user a checkbox floating off the page.
func validateAndConvert(out modelOut, pageNum, pageW, pageH int) []heuristic.Field {
	if pageW <= 0 || pageH <= 0 {
		return nil
	}
	fields := make([]heuristic.Field, 0, len(out.Fields))
	for _, f := range out.Fields {
		t := strings.ToLower(strings.TrimSpace(f.Type))
		if _, ok := validTypes[t]; !ok {
			continue
		}
		// Reject zero-or-negative-area boxes.
		if f.W <= 0 || f.H <= 0 {
			continue
		}
		// Clamp into the page frame; reject if no overlap remains.
		x, y, w, h := clampBox(f.X, f.Y, f.W, f.H, float64(pageW), float64(pageH))
		if w <= 0 || h <= 0 {
			continue
		}
		conf := DefaultConfidence
		if f.Confidence != nil {
			conf = clamp(*f.Confidence, MinConfidence, MaxConfidence)
		}
		fields = append(fields, heuristic.Field{
			Type:       t,
			Page:       pageNum,
			X:          x,
			Y:          y,
			W:          w,
			H:          h,
			PageW:      pageW,
			PageH:      pageH,
			Label:      strings.TrimSpace(f.Label),
			Confidence: conf,
		})
	}
	return fields
}

// clampBox clips a box to the page frame and returns the clipped
// (x, y, w, h). If the box is entirely outside the frame the returned
// w or h will be <= 0 and the caller should drop the proposal.
func clampBox(x, y, w, h, pageW, pageH float64) (float64, float64, float64, float64) {
	x2 := x + w
	y2 := y + h
	if x < 0 {
		x = 0
	}
	if y < 0 {
		y = 0
	}
	if x2 > pageW {
		x2 = pageW
	}
	if y2 > pageH {
		y2 = pageH
	}
	return x, y, x2 - x, y2 - y
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
