package ocr

// Raster endpoint is the OCR-bypass twin of /layout/pdf — it
// rasterizes the PDF on the sidecar and returns each page as a
// base64-encoded PNG, but does NOT run PaddleOCR on the pages.
//
// Used by the auto-field-detection cascade's vision-LLM tier
// (internal/aidetect/visionllm), where the detection model is the
// LLM itself — running OCR first would just waste CPU on a result
// the vision model is going to ignore.
//
// Coordinate convention: the per-page W/H are pixels at the
// requested DPI, same convention LayoutPage uses, so consumers can
// reuse the same pixel→PDF user-space conversion when mapping LLM-
// emitted boxes back into widget coordinates.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"time"
)

// RasterPage is one rendered PDF page returned by /raster/pdf.
// PNGBase64 is the raw base64 string the sidecar emits; callers that
// need bytes should use Bytes() rather than re-decoding by hand —
// it caches the decode so a vision-LLM that retries on 5xx doesn't
// pay the decode cost twice.
type RasterPage struct {
	W         int    `json:"w"`
	H         int    `json:"h"`
	PNGBase64 string `json:"png_base64"`

	// decoded is populated lazily by Bytes(); unexported so JSON
	// encoding ignores it automatically.
	decoded []byte
}

// Bytes returns the decoded PNG bytes for this page. The first call
// pays the base64 decode; subsequent calls return the cached buffer.
// Returns an error only if the sidecar emitted invalid base64, which
// would be a sidecar bug rather than a user-input issue.
func (p *RasterPage) Bytes() ([]byte, error) {
	if p.decoded != nil {
		return p.decoded, nil
	}
	b, err := base64.StdEncoding.DecodeString(p.PNGBase64)
	if err != nil {
		return nil, fmt.Errorf("raster page base64: %w", err)
	}
	p.decoded = b
	return b, nil
}

// rasterPDFResp matches the wire shape of POST /raster/pdf.
type rasterPDFResp struct {
	Pages []RasterPage `json:"pages"`
}

// RasterDPI is the default rasterization DPI for vision-LLM use. It
// is intentionally lower than the OCR DPI (defaultDPI=200) because
// vision models tokenize images into a fixed grid and don't benefit
// from extra pixels past ~120-150 dpi for letter-size pages, while
// the per-image byte cap on most APIs (Anthropic ~5MB, vLLM/llava
// ~4MB) gets uncomfortable past 200 dpi on multi-page PDFs.
const RasterDPI = 144

// RasterPDF asks the sidecar to render the PDF (no OCR) and returns
// per-page base64 PNGs. Honours MaxPages from the Config; uses the
// vision-tuned RasterDPI by default but accepts an override via
// Config.DPI when the operator has explicitly set OCR_DPI lower
// than 144 (e.g. memory-constrained deployments).
//
// Returns nil + ErrDisabled when OCR is off; nil + nil when body is
// empty; wrapped ErrSidecarUnavailable on transport failure; wrapped
// HTTP-status error on a non-2xx sidecar response.
func (c Config) RasterPDF(ctx context.Context, body []byte) ([]RasterPage, error) {
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
	// Vision tier picks its own DPI ceiling. We use Config.DPI only
	// when the operator set it explicitly *lower* than RasterDPI —
	// going higher would cost tokens with no detection-quality gain.
	dpi := RasterDPI
	if c.DPI > 0 && c.DPI < RasterDPI {
		dpi = c.DPI
	}
	totalBudget := c.PerPageTimeout * time.Duration(maxPages)
	if totalBudget < 30*time.Second {
		totalBudget = 30 * time.Second
	}
	rctx, cancel := context.WithTimeout(ctx, totalBudget)
	defer cancel()

	fields := map[string]string{
		"max_pages": strconv.Itoa(maxPages),
		"dpi":       strconv.Itoa(dpi),
	}
	raw, err := c.postFileRaw(rctx, "/raster/pdf", "in.pdf", body, fields)
	if err != nil {
		return nil, fmt.Errorf("ocr raster pdf: %w", err)
	}
	var out rasterPDFResp
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("decode raster response: %w", err)
	}
	return out.Pages, nil
}
