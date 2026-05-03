package ocr

// Layout endpoints are the bbox-preserving twin of the plain text
// /ocr/* endpoints, used by the auto-field-detection heuristic in
// internal/aidetect to find label/blank/checkbox geometry on scanned
// or flat PDFs (and on image-backed templates).
//
// They share the sidecar's per-language engine cache with /ocr/* —
// no second model download — but instead of joining detected lines
// into a single text string, they retain the per-line axis-aligned
// bounding box and confidence the detector produces.
//
// Coordinate convention (from the sidecar, unchanged here):
//   - origin = top-left of the rasterized page
//   - +x rightward, +y downward
//   - units = pixels at the rasterization DPI
//   - bbox = [x, y, w, h], axis-aligned
//
// The aidetect package is the only consumer today and converts these
// pixel coordinates to PDF user-space (origin bottom-left, units =
// 1/72") at proposal-emit time so the static designer overlay drops
// in without further translation.

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"
)

// LayoutBox is a single OCR-detected text line with its tight axis-
// aligned bounding box and the detector's confidence. Wire shape
// matches the sidecar exactly (`bbox` is the 4-element [x,y,w,h]
// array; we expand it into named fields here for ergonomic Go usage).
type LayoutBox struct {
	Text       string  `json:"text"`
	X          float64 `json:"-"`
	Y          float64 `json:"-"`
	W          float64 `json:"-"`
	H          float64 `json:"-"`
	Confidence float64 `json:"conf"`

	// Bbox is the raw [x, y, w, h] array as the sidecar emits it.
	// Kept on the struct so JSON encoding round-trips cleanly (e.g.
	// when an aidetect handler echoes the layout back to a debug
	// endpoint). Prefer the X/Y/W/H accessors in Go code.
	Bbox [4]float64 `json:"bbox"`
}

// LayoutPage is one rasterized page's worth of layout boxes plus the
// page dimensions in pixels at the rasterization DPI. Heuristic
// detectors normalize box coords against W/H to avoid baking the DPI
// into the rules.
type LayoutPage struct {
	W     int         `json:"w"`
	H     int         `json:"h"`
	Boxes []LayoutBox `json:"boxes"`

	// Grids is populated when the caller asks the sidecar for
	// character-grid detection (LayoutPDF/LayoutImage with the grids
	// flag). Empty when the feature wasn't requested or no grids were
	// found. See LayoutGrid for the per-grid record shape.
	Grids []LayoutGrid `json:"grids,omitempty"`

	// Checkboxes is populated alongside Grids — same opt-in flag, same
	// CV pass on the page raster. Each entry is one detected empty
	// rectangle that's plausibly a checkbox or radio button. The
	// heuristic tier consumes them and emits one checkbox Field per
	// entry with the nearest right-side OCR text as the label.
	Checkboxes []LayoutCheckbox `json:"checkboxes,omitempty"`
}

// LayoutCheckbox is one CV-detected small empty rectangle that the
// sidecar identified as a likely checkbox or radio. Coordinates share
// the LayoutBox space (pixels at the rasterization DPI, top-left
// origin). No additional fields beyond the bbox — checkbox geometry
// is uniform; the label and intent come from surrounding OCR text.
type LayoutCheckbox struct {
	X    float64    `json:"-"`
	Y    float64    `json:"-"`
	W    float64    `json:"-"`
	H    float64    `json:"-"`
	Bbox [4]float64 `json:"bbox"`
}

// LayoutGrid is one detected character grid — a row of N adjacent
// equal-size empty boxes, the canonical fillable pattern on Indian KYC
// and bank account-opening forms (PAN, CKYC, LEI, address blocks,
// DD/MM/YYYY date strips). Coordinates share the LayoutBox space:
// pixels at the rasterization DPI, top-left origin.
//
// Cells is the integer cell count, exposed so the heuristic tier can
// emit downstream maxLength hints (a 10-cell grid below "PAN Number"
// is almost certainly a 10-character PAN field).
type LayoutGrid struct {
	X      float64 `json:"-"`
	Y      float64 `json:"-"`
	W      float64 `json:"-"`
	H      float64 `json:"-"`
	Cells  int     `json:"cells"`
	CellW  float64 `json:"cell_w"`
	CellH  float64 `json:"cell_h"`

	// Bbox is the raw [x, y, w, h] array as the sidecar emits it.
	// Same expand-on-decode dance as LayoutBox so Go consumers read
	// X/Y/W/H ergonomically while the wire stays compact.
	Bbox [4]float64 `json:"bbox"`
}

// layoutPDFResp is the wire shape of POST /layout/pdf.
type layoutPDFResp struct {
	Pages []LayoutPage `json:"pages"`
}

// LayoutPDF rasterizes the PDF on the sidecar and returns per-page
// boxes. Honours the same MaxPages / DPI / Lang knobs as PDFToText so
// callers get consistent caps (a heavily-paginated scan that gets
// cropped by /ocr/pdf will be cropped the same way here).
//
// On any sidecar error the returned slice is nil and the error wraps
// ErrSidecarUnavailable for transport failures or includes the HTTP
// status for 4xx/5xx responses.
func (c Config) LayoutPDF(ctx context.Context, body []byte) ([]LayoutPage, error) {
	if !c.Enabled {
		return nil, ErrDisabled
	}
	if len(body) == 0 {
		return nil, nil
	}
	maxPages := c.MaxPages
	if maxPages <= 0 {
		maxPages = defaultMaxPages
	}
	dpi := c.DPI
	if dpi <= 0 {
		dpi = defaultDPI
	}
	totalBudget := c.PerPageTimeout * time.Duration(maxPages)
	if totalBudget < 30*time.Second {
		totalBudget = 30 * time.Second
	}
	rctx, cancel := context.WithTimeout(ctx, totalBudget)
	defer cancel()

	fields := map[string]string{
		"lang":      c.langOrDefault(),
		"max_pages": strconv.Itoa(maxPages),
		"dpi":       strconv.Itoa(dpi),
		// Always request grids — the sidecar field is opt-in for
		// backward compat, but inside the api we always want them.
		// They're empty for forms without grids, ~1ms of CV work
		// per page either way, and the heuristic tier needs them
		// to detect Indian KYC character grids the OCR text path
		// can't see.
		"grids": "true",
	}
	raw, err := c.postFileRaw(rctx, "/layout/pdf", "in.pdf", body, fields)
	if err != nil {
		return nil, fmt.Errorf("ocr layout pdf: %w", err)
	}
	var out layoutPDFResp
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("decode layout response: %w", err)
	}
	for i := range out.Pages {
		expandBboxes(out.Pages[i].Boxes)
		expandGrids(out.Pages[i].Grids)
		expandCheckboxes(out.Pages[i].Checkboxes)
	}
	return out.Pages, nil
}

// LayoutImage runs the bbox-preserving OCR for a single image.
// Returned LayoutPage.W/H are the source image dimensions in pixels.
// nil result + nil error iff body is empty.
func (c Config) LayoutImage(ctx context.Context, body []byte) (*LayoutPage, error) {
	if !c.Enabled {
		return nil, ErrDisabled
	}
	if len(body) == 0 {
		return nil, nil
	}
	rctx, cancel := context.WithTimeout(ctx, c.PerPageTimeout)
	defer cancel()
	raw, err := c.postFileRaw(rctx, "/layout/image", "in.bin", body, map[string]string{
		"lang":  c.langOrDefault(),
		"grids": "true",
	})
	if err != nil {
		return nil, fmt.Errorf("ocr layout image: %w", err)
	}
	var out LayoutPage
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("decode layout response: %w", err)
	}
	expandBboxes(out.Boxes)
	expandGrids(out.Grids)
	expandCheckboxes(out.Checkboxes)
	return &out, nil
}

// expandBboxes copies the [x,y,w,h] tuple into the named X/Y/W/H
// fields so downstream Go code can read them ergonomically without
// indexing the array. Kept separate from JSON unmarshal so the wire
// shape (a flat 4-array) stays compact.
func expandBboxes(boxes []LayoutBox) {
	for i := range boxes {
		boxes[i].X = boxes[i].Bbox[0]
		boxes[i].Y = boxes[i].Bbox[1]
		boxes[i].W = boxes[i].Bbox[2]
		boxes[i].H = boxes[i].Bbox[3]
	}
}

// expandGrids is the LayoutGrid twin of expandBboxes — same wire-to-
// ergonomic shape coercion, separate function so the box and grid
// types stay decoupled in case their schemas drift later.
func expandGrids(grids []LayoutGrid) {
	for i := range grids {
		grids[i].X = grids[i].Bbox[0]
		grids[i].Y = grids[i].Bbox[1]
		grids[i].W = grids[i].Bbox[2]
		grids[i].H = grids[i].Bbox[3]
	}
}

// expandCheckboxes mirrors expandGrids/expandBboxes for LayoutCheckbox.
// A separate function rather than a generic one because Go's lack of
// type parameters on field access would force reflection — and there
// are only three call sites, so the duplication is cheap.
func expandCheckboxes(boxes []LayoutCheckbox) {
	for i := range boxes {
		boxes[i].X = boxes[i].Bbox[0]
		boxes[i].Y = boxes[i].Bbox[1]
		boxes[i].W = boxes[i].Bbox[2]
		boxes[i].H = boxes[i].Bbox[3]
	}
}
