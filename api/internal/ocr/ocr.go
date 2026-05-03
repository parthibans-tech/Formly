// Package ocr is a thin HTTP client for the paddle-ocr sidecar
// service so the docchat "Summarize / Ask" feature can answer
// questions about scanned PDFs and image uploads.
//
// # Why a sidecar (and what changed from the previous implementation)
//
// This package previously shelled out to the `tesseract` CLI plus
// `pdftoppm` (poppler) and `convert` (ImageMagick) directly from the
// api process. That worked but came with three operational scars:
//
//   - The api image had to bundle ~600MB of OS packages (tesseract +
//     language packs + poppler + imagemagick).
//   - Accuracy on noisy phone photos and Indic-script ID cards
//     plateaued — tesseract's LSTM engine is older than the
//     transformer-based PP-OCRv4 PaddleOCR ships with.
//   - Per-language tuning meant per-PSM tuning, which leaked into the
//     ocrprofiles surface and the admin UI.
//
// PaddleOCR runs as a Python sidecar (infra/paddle-ocr/) for the same
// architectural reasons we run Ollama as a sidecar: heavyweight
// language-specific dependencies don't belong in the api binary's
// build chain. The api speaks HTTP to the sidecar at PADDLE_OCR_URL;
// every other consumer of this package (docchat, ocrprofiles) keeps
// the same Config / WithProfile / PDFToText / ImageToText surface, so
// nothing else needed to change.
//
// # Why HTTP not gRPC or shared memory
//
//   - HTTP keeps the sidecar language-agnostic. If we swap PaddleOCR
//     for a future engine (vision-LLM, doctr) the wire format stays
//     multipart-form + JSON.
//   - The latency overhead of HTTP-over-loopback is ~0.5ms; OCR itself
//     is 200ms-2s per page. The serialization cost is in the noise.
//
// # Operational requirements
//
// Production deployments need the paddle-ocr sidecar reachable at
// PADDLE_OCR_URL (defaults to http://localhost:8868 for host-mode
// dev, set to http://paddle-ocr:8868 in compose). Without it,
// /healthz fails the startup probe and OCR-dependent endpoints
// surface 502 ai_error at request time.
package ocr

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// Sentinels mapped to user-visible errors by the docchat handler.
var (
	// ErrDisabled is returned when OCR_ENABLED is unset or false. The
	// docchat fallback treats this as "no OCR available" and lets the
	// 415 not_textual response stand.
	ErrDisabled = errors.New("ocr: disabled (set OCR_ENABLED=1)")
	// ErrSidecarUnavailable is returned when the paddle-ocr sidecar
	// isn't reachable (DNS failure, connection refused, healthz
	// returns non-2xx). Operators see this in the api log on the
	// startup-time probe; the per-request error path surfaces it as
	// a 502 ai_error so users know it's a deployment issue, not a
	// content issue.
	ErrSidecarUnavailable = errors.New("ocr: paddle-ocr sidecar unreachable (set PADDLE_OCR_URL)")

	// Backwards-compat aliases. The old tesseract-shaped sentinels
	// were re-exported by docchat/ocrprofiles error paths; keeping
	// them as aliases avoids a wider rename in this PR. A subsequent
	// cleanup can drop these once no caller mentions them.
	ErrTesseractMissing = ErrSidecarUnavailable
	ErrPdftoppmMissing  = ErrSidecarUnavailable
)

// PSM* constants are kept as a deprecated compatibility shim. PaddleOCR
// auto-detects layout — there's no equivalent of tesseract's
// page-segmentation mode — so these values are accepted by WithProfile
// and silently ignored. The constants stay defined so callers /
// migrations / DB rows that mention PSM still compile.
//
// Deprecated: PaddleOCR has no equivalent. Field is parsed for
// backwards compatibility and no-op'd.
const (
	PSMOSDOnly             = 0
	PSMAutoWithOSD         = 1
	PSMAutoOnly            = 2
	PSMAuto                = 3
	PSMSingleColumn        = 4
	PSMSingleVerticalBlock = 5
	PSMSingleUniformBlock  = 6
	PSMSingleLine          = 7
	PSMSingleWord          = 8
	PSMSingleWordCircle    = 9
	PSMSingleChar          = 10
	PSMSparseText          = 11
	PSMSparseTextWithOSD   = 12
	PSMRawLineBypassHacks  = 13
)

// Config governs the OCR client's behaviour. The zero value is
// "disabled" — call FromEnv to populate, or build manually.
type Config struct {
	Enabled bool

	// BaseURL points at the paddle-ocr sidecar. Default
	// "http://localhost:8868" (host-mode dev); set
	// PADDLE_OCR_URL=http://paddle-ocr:8868 inside compose.
	BaseURL string

	// Lang is forwarded to the sidecar as the `lang` form field.
	// PaddleOCR expects ISO codes ("en", "hi", "ta", "ch", "ja", ...).
	// Multi-language tesseract syntax ("eng+hin") is accepted for
	// backwards compatibility — the sidecar splits on "+" and aliases
	// the legacy codes to the PaddleOCR equivalents.
	Lang string

	// MaxPages caps how many pages of a PDF the sidecar will OCR in
	// a single request. Defends against a 500-page scanned book
	// pinning the sidecar for an hour. Forwarded as form field
	// `max_pages`.
	MaxPages int

	// DPI for PDF rasterization on the sidecar (pdf2image → pdftoppm).
	// 200 is the sweet spot — higher (300+) marginally improves
	// accuracy on small fonts but doubles per-page CPU; lower (150)
	// is fine for typed contracts but loses small text.
	DPI int

	// PerPageTimeout is used as the per-request HTTP client deadline
	// for image OCR, and as the per-page budget that gates total PDF
	// timeout (PerPageTimeout * MaxPages).
	PerPageTimeout time.Duration

	// PSM is a deprecated compatibility field — PaddleOCR has no
	// equivalent of tesseract's page-segmentation mode. Stored so the
	// WithProfile signature stays stable; not sent to the sidecar.
	//
	// Deprecated: ignored by the PaddleOCR backend.
	PSM int

	// Preprocess was a tesseract-era flag controlling the imagemagick
	// deskew/sharpen pass. PaddleOCR does its own preprocessing
	// internally (angle classification + adaptive thresholding) so
	// this is now a no-op kept for backwards compatibility.
	//
	// Deprecated: ignored by the PaddleOCR backend.
	Preprocess bool

	// HTTPClient is exposed for tests (httptest.Server). Production
	// callers leave this nil and we lazy-build a default client with
	// sensible timeouts.
	HTTPClient *http.Client
}

// Defaults populated by FromEnv when env vars are unset.
const (
	defaultLang           = "en"
	defaultMaxPages       = 30
	defaultDPI            = 200
	defaultPerPageTimeout = 30 * time.Second
	defaultBaseURL        = "http://localhost:8868"
	// defaultPSM kept for the WithProfile zero-value path; it's never
	// sent to the sidecar.
	defaultPSM        = PSMAuto
	defaultPreprocess = true
)

// FromEnv builds a Config from environment variables:
//
//	OCR_ENABLED              "1"/"true" to enable
//	PADDLE_OCR_URL           sidecar base URL (default http://localhost:8868)
//	OCR_LANG                 PaddleOCR lang code (default "en"). Accepts
//	                         legacy tesseract syntax (e.g. "eng+hin");
//	                         the sidecar aliases.
//	OCR_MAX_PAGES            cap pages per PDF (default 30)
//	OCR_DPI                  PDF rasterization DPI (default 200)
//	OCR_PER_PAGE_TIMEOUT_SEC per-page sidecar budget (default 30)
//	OCR_PSM                  legacy tesseract PSM — accepted for back-
//	                         compat and silently ignored (PaddleOCR
//	                         auto-detects layout)
//	OCR_PREPROCESS           legacy preprocess toggle — accepted and
//	                         ignored (PaddleOCR preprocesses internally)
func FromEnv() Config {
	c := Config{
		BaseURL:        defaultBaseURL,
		Lang:           defaultLang,
		MaxPages:       defaultMaxPages,
		DPI:            defaultDPI,
		PerPageTimeout: defaultPerPageTimeout,
		PSM:            defaultPSM,
		Preprocess:     defaultPreprocess,
	}
	if v := os.Getenv("OCR_ENABLED"); v == "1" || strings.EqualFold(v, "true") {
		c.Enabled = true
	}
	if v := os.Getenv("PADDLE_OCR_URL"); v != "" {
		c.BaseURL = strings.TrimRight(v, "/")
	}
	if v := os.Getenv("OCR_LANG"); v != "" {
		c.Lang = v
	}
	if v := os.Getenv("OCR_MAX_PAGES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.MaxPages = n
		}
	}
	if v := os.Getenv("OCR_DPI"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.DPI = n
		}
	}
	if v := os.Getenv("OCR_PER_PAGE_TIMEOUT_SEC"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.PerPageTimeout = time.Duration(n) * time.Second
		}
	}
	if v := os.Getenv("OCR_PSM"); v != "" {
		// Parsed for log-friendliness but never forwarded.
		if n, err := strconv.Atoi(v); err == nil && n >= 0 && n <= 13 {
			c.PSM = n
		}
	}
	if v := os.Getenv("OCR_PREPROCESS"); v != "" {
		c.Preprocess = v == "1" || strings.EqualFold(v, "true")
	}
	return c
}

// WithProfile clones the config and applies per-call overrides from
// an OCR profile. Empty/zero values mean "inherit" so the caller
// passes everything through unconditionally:
//
//	oc := h.OCR.WithProfile(profile.Lang, profile.PSM, profile.Preprocess)
//
// The signature is preserved from the tesseract era for source
// compatibility. PSM and Preprocess are stored on the returned config
// but never sent to the sidecar (PaddleOCR has no equivalent and
// preprocesses internally).
func (c Config) WithProfile(lang string, psm int, preprocess *bool) Config {
	out := c
	if lang != "" {
		out.Lang = lang
	}
	if psm >= 0 && psm <= 13 {
		out.PSM = psm
	}
	if preprocess != nil {
		out.Preprocess = *preprocess
	}
	return out
}

// Probe verifies the sidecar is reachable and healthy. Call once at
// startup to log a clear "OCR enabled but sidecar missing" message
// instead of failing the first request. Uses a short per-request
// timeout so a stuck sidecar doesn't block api boot for the full
// PerPageTimeout.
func (c Config) Probe() error {
	if !c.Enabled {
		return ErrDisabled
	}
	url := c.baseURL() + "/healthz"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrSidecarUnavailable, err)
	}
	resp, err := c.client().Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrSidecarUnavailable, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("%w: healthz returned HTTP %d", ErrSidecarUnavailable, resp.StatusCode)
	}
	return nil
}

func (c Config) baseURL() string {
	if c.BaseURL != "" {
		return strings.TrimRight(c.BaseURL, "/")
	}
	return defaultBaseURL
}

// client returns the HTTP client to use for sidecar calls. We use a
// per-Config default with a generous timeout so PDF requests with
// many pages don't hit the wire-level deadline before the sidecar
// finishes — the per-page budget is enforced on the request context
// instead.
func (c Config) client() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	// Wire-level timeout = per-page budget * max-pages * fudge factor.
	// We deliberately don't use http.Client.Timeout (which would cap
	// request + response together at this value); instead we let the
	// request context drive cancellation and use a long fallback here.
	return &http.Client{
		Timeout: 0, // no client-level cap; context governs
		Transport: &http.Transport{
			IdleConnTimeout:     90 * time.Second,
			MaxIdleConnsPerHost: 4,
		},
	}
}

// PDFToText posts the PDF to the sidecar's /ocr/pdf endpoint with the
// configured lang / max_pages / DPI and returns the joined text the
// sidecar produces (pages separated by "\n\n").
//
// On any sidecar error (404, 5xx, JSON decode failure) we return a
// wrapped error so the caller can choose to surface a partial answer
// or fail closed; the previous tesseract path returned partial text +
// error on per-page failures, and the docchat surface relied on that.
// PaddleOCR doesn't return per-page errors today, so this path is
// either "all text" or "empty + error".
func (c Config) PDFToText(ctx context.Context, body []byte) (string, error) {
	if !c.Enabled {
		return "", ErrDisabled
	}
	if len(body) == 0 {
		return "", nil
	}
	maxPages := c.MaxPages
	if maxPages <= 0 {
		maxPages = defaultMaxPages
	}
	dpi := c.DPI
	if dpi <= 0 {
		dpi = defaultDPI
	}
	// Per-page budget * page cap, with a small floor so a 1-page doc
	// still gets a reasonable timeout. The sidecar enforces its own
	// internal page cap, so this is only a defence-in-depth deadline.
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
	}
	resp, err := c.postFile(rctx, "/ocr/pdf", "in.pdf", body, fields)
	if err != nil {
		return "", fmt.Errorf("ocr pdf: %w", err)
	}
	return resp.Text, nil
}

// ImageToText posts the image bytes to the sidecar's /ocr/image
// endpoint. PaddleOCR handles its own preprocessing internally
// (angle classification + adaptive thresholding); the legacy
// Preprocess flag is accepted on Config but does nothing here.
func (c Config) ImageToText(ctx context.Context, body []byte) (string, error) {
	if !c.Enabled {
		return "", ErrDisabled
	}
	if len(body) == 0 {
		return "", nil
	}
	rctx, cancel := context.WithTimeout(ctx, c.PerPageTimeout)
	defer cancel()
	resp, err := c.postFile(rctx, "/ocr/image", "in.bin", body, map[string]string{
		"lang": c.langOrDefault(),
	})
	if err != nil {
		return "", fmt.Errorf("ocr image: %w", err)
	}
	return resp.Text, nil
}

func (c Config) langOrDefault() string {
	if c.Lang != "" {
		return c.Lang
	}
	return defaultLang
}

// sidecarResp is the wire shape both /ocr/image and /ocr/pdf return.
// Pages is populated only by /ocr/pdf and only consumed by future
// callers that want per-page output; current callers read Text.
type sidecarResp struct {
	Text  string   `json:"text"`
	Pages []string `json:"pages,omitempty"`
}

// postFile builds a multipart/form-data request with the file blob
// plus auxiliary form fields and POSTs it to the sidecar, decoding
// the response into sidecarResp (the wire shape used by /ocr/image
// and /ocr/pdf). Layout endpoints with a different JSON shape use
// postFileRaw and decode themselves.
func (c Config) postFile(ctx context.Context, path, filename string, body []byte, fields map[string]string) (*sidecarResp, error) {
	respBody, err := c.postFileRaw(ctx, path, filename, body, fields)
	if err != nil {
		return nil, err
	}
	var out sidecarResp
	if err := json.Unmarshal(respBody, &out); err != nil {
		return nil, fmt.Errorf("decode sidecar response: %w (body: %s)", err, truncate(string(respBody), 256))
	}
	return &out, nil
}

// postFileRaw is the lower-level helper shared by postFile and the
// /layout/* callers. It does the multipart envelope + HTTP exchange
// and returns the raw response body (capped at 8MB) on a 2xx, so
// callers can decode whatever JSON shape their endpoint returns.
func (c Config) postFileRaw(ctx context.Context, path, filename string, body []byte, fields map[string]string) ([]byte, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			return nil, fmt.Errorf("multipart field %s: %w", k, err)
		}
	}
	fw, err := mw.CreateFormFile("file", filename)
	if err != nil {
		return nil, fmt.Errorf("multipart file: %w", err)
	}
	if _, err := fw.Write(body); err != nil {
		return nil, fmt.Errorf("multipart write: %w", err)
	}
	if err := mw.Close(); err != nil {
		return nil, fmt.Errorf("multipart close: %w", err)
	}
	url := c.baseURL() + path
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, &buf)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := c.client().Do(req)
	if err != nil {
		// Network / DNS / connection refused — surface the sentinel
		// so the docchat handler can map it to 502 ai_error.
		return nil, fmt.Errorf("%w: %v", ErrSidecarUnavailable, err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20)) // 8MB ceiling on the response
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("sidecar HTTP %d: %s", resp.StatusCode, truncate(string(respBody), 512))
	}
	return respBody, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
