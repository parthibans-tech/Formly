package docchat

// Tests for chainOCR — the small composition function that decides
// whether to fall through to OCR after the primary extractor returns
// nothing. The interesting paths are the gating rules:
//
//   - Primary returns text → OCR must NOT fire (don't double-spend).
//   - Primary errors out  → OCR must NOT fire (don't paper over a real bug).
//   - Primary returns ""  → OCR fires only for OCR-eligible MIMEs.
//
// We pass fake extractor functions in for both layers so the test is
// pure-Go (no tesseract dependency) and runs in milliseconds.

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/docforge/api/internal/ocr"
)

// bogusOCR builds an OCR config that's enabled but points at a
// localhost port nothing's listening on, with a real (non-zero)
// per-page timeout so the HTTP client gets a fast connection-refused
// error rather than blocking on a deadline. Tests that want to
// assert "OCR was attempted" use this config and check for any
// OCR-shaped error in the result.
func bogusOCR() ocr.Config {
	return ocr.Config{
		Enabled:        true,
		BaseURL:        "http://127.0.0.1:1", // refused fast
		Lang:           "en",
		MaxPages:       1,
		DPI:            72,
		PerPageTimeout: 5 * time.Second,
	}
}

// looksLikeOCRError returns true for any error message that could only
// come from the OCR path — sidecar unreachable, sidecar HTTP error,
// or our own sentinel errors.
func looksLikeOCRError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, ocr.ErrSidecarUnavailable) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "ocr ") ||
		strings.Contains(msg, "sidecar") ||
		strings.Contains(msg, "paddle") ||
		strings.Contains(msg, "127.0.0.1:1") ||
		strings.Contains(msg, "connection refused")
}

// pdfToTextStub / imageToTextStub are method-shaped helpers that
// approximate ocr.Config's PDFToText/ImageToText. We can't easily
// monkey-patch a struct method, so the chainOCR design relies on the
// real ocr.Config — and we instead verify the gating logic by:
//
//  1. Routing a primary extractor that returns "" for OCR-eligible
//     MIMEs, then asserting the chain bottoms out at the real ocr.Config
//     (which is disabled in this test → returns ErrDisabled).
//  2. Confirming non-eligible MIMEs and non-empty primary results
//     short-circuit before touching OCR.

func TestChainOCR_PrimaryHasText_NoOCR(t *testing.T) {
	primary := func(ctx context.Context, mime string, body []byte) (string, error) {
		return "extracted from text layer", nil
	}
	// OCR config is enabled but pointed at a non-existent binary —
	// if the chain mistakenly fires OCR, we'd see ErrTesseractMissing.
	cfg := bogusOCR()
	chained := chainOCR(primary, cfg, nil)

	got, err := chained(context.Background(), "application/pdf", []byte("anything"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "extracted from text layer" {
		t.Errorf("got %q, want primary's output (OCR must not have fired)", got)
	}
}

func TestChainOCR_PrimaryError_PropagatesAndSkipsOCR(t *testing.T) {
	want := errors.New("decode failure")
	primary := func(ctx context.Context, mime string, body []byte) (string, error) {
		return "", want
	}
	cfg := bogusOCR()
	chained := chainOCR(primary, cfg, nil)

	got, err := chained(context.Background(), "application/pdf", []byte("x"))
	if !errors.Is(err, want) {
		t.Errorf("err = %v, want %v", err, want)
	}
	if got != "" {
		t.Errorf("got %q, want empty", got)
	}
}

func TestChainOCR_PrimaryEmpty_NonEligibleMIME_NoOCR(t *testing.T) {
	primary := func(ctx context.Context, mime string, body []byte) (string, error) {
		return "", nil
	}
	// OCR points at a missing binary; if the chain incorrectly tried
	// OCR for this MIME we'd see an ErrTesseractMissing-shaped error.
	cfg := bogusOCR()
	chained := chainOCR(primary, cfg, nil)

	got, err := chained(context.Background(), "application/zip", []byte("PK"))
	if err != nil {
		t.Errorf("unexpected error for non-OCR-eligible MIME: %v", err)
	}
	if got != "" {
		t.Errorf("got %q, want empty (no OCR for application/zip)", got)
	}
}

func TestChainOCR_PrimaryEmpty_PDF_FiresOCR(t *testing.T) {
	primary := func(ctx context.Context, mime string, body []byte) (string, error) {
		return "", nil
	}
	cfg := bogusOCR()
	chained := chainOCR(primary, cfg, nil)

	_, err := chained(context.Background(), "application/pdf", []byte("%PDF-1.4"))
	// We expect an OCR-shaped error because the binaries are bogus —
	// the important assertion is that the chain TRIED OCR rather than
	// silently returning "".
	if err == nil {
		t.Fatal("expected OCR error (binaries point at /nope), got nil")
	}
	if !looksLikeOCRError(err) {
		t.Errorf("err = %v, does not look like an OCR error", err)
	}
}

func TestChainOCR_PrimaryEmpty_Image_FiresOCR(t *testing.T) {
	primary := func(ctx context.Context, mime string, body []byte) (string, error) {
		return "", nil
	}
	cfg := bogusOCR()
	chained := chainOCR(primary, cfg, nil)

	_, err := chained(context.Background(), "image/png", []byte{0x89, 0x50, 0x4e, 0x47})
	if err == nil {
		t.Fatal("expected OCR error, got nil")
	}
	if !looksLikeOCRError(err) {
		t.Errorf("err = %v, does not look like an OCR error", err)
	}
}

func TestWithOCR_DisabledIsNoOp(t *testing.T) {
	h := &Handler{Extract: func(ctx context.Context, mime string, body []byte) (string, error) {
		return "primary-only", nil
	}}
	before := h.Extract
	h2 := h.WithOCR(ocr.Config{Enabled: false})
	if h2 != h {
		t.Error("WithOCR returned a different handler instance")
	}
	// Functions aren't directly comparable in Go, so we verify behaviour
	// instead: a disabled WithOCR must leave Extract producing the same
	// result as the original.
	got, _ := h.Extract(context.Background(), "application/pdf", nil)
	want, _ := before(context.Background(), "application/pdf", nil)
	if got != want {
		t.Errorf("Extract changed despite disabled OCR: got %q want %q", got, want)
	}
}

func TestIsOCRablePDF(t *testing.T) {
	yes := []string{"application/pdf", "Application/PDF", "  application/pdf  "}
	no := []string{"application/zip", "image/png", "", "application/msword"}
	for _, m := range yes {
		if !isOCRablePDF(m) {
			t.Errorf("isOCRablePDF(%q) = false, want true", m)
		}
	}
	for _, m := range no {
		if isOCRablePDF(m) {
			t.Errorf("isOCRablePDF(%q) = true, want false", m)
		}
	}
}

func TestIsOCRableImage(t *testing.T) {
	yes := []string{"image/png", "image/jpeg", "image/JPG", "image/webp", "image/tiff"}
	no := []string{"image/svg+xml", "image/heic", "application/pdf", ""}
	for _, m := range yes {
		if !isOCRableImage(m) {
			t.Errorf("isOCRableImage(%q) = false, want true", m)
		}
	}
	for _, m := range no {
		if isOCRableImage(m) {
			t.Errorf("isOCRableImage(%q) = true, want false", m)
		}
	}
}
