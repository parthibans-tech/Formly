package ocr

import (
	"context"
	"encoding/base64"
	"errors"
	"testing"
	"time"
)

// TestRasterPDF_RoundTrip verifies the multipart envelope, response
// decode, and Bytes() lazy decode all work end-to-end against a
// fake sidecar. We reuse fakeLayoutSidecar from layout_test.go since
// both endpoints share the same multipart-form + JSON-response shape.
func TestRasterPDF_RoundTrip(t *testing.T) {
	pngA := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3}
	pngB := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9}
	body := `{"pages":[
		{"w":1224,"h":1584,"png_base64":"` + base64.StdEncoding.EncodeToString(pngA) + `"},
		{"w":1224,"h":1584,"png_base64":"` + base64.StdEncoding.EncodeToString(pngB) + `"}
	]}`
	srv := fakeLayoutSidecar(t, "/raster/pdf", body, func(t *testing.T, f map[string]string, file []byte) {
		// Raster endpoint takes max_pages + dpi but NOT lang — vision
		// model doesn't need to know the script.
		if _, hasLang := f["lang"]; hasLang {
			t.Errorf("raster request leaked lang field: %q", f["lang"])
		}
		if f["max_pages"] != "5" {
			t.Errorf("max_pages = %q, want 5", f["max_pages"])
		}
		if f["dpi"] != "144" {
			t.Errorf("dpi = %q, want 144 (RasterDPI default)", f["dpi"])
		}
		if string(file) != "fakepdfbytes" {
			t.Errorf("file body = %q, want fakepdfbytes", file)
		}
	})
	defer srv.Close()

	cfg := Config{
		Enabled:        true,
		BaseURL:        srv.URL,
		MaxPages:       5,
		// Leave DPI unset so RasterPDF uses RasterDPI (144).
		PerPageTimeout: 5 * time.Second,
	}
	pages, err := cfg.RasterPDF(context.Background(), []byte("fakepdfbytes"))
	if err != nil {
		t.Fatalf("RasterPDF: %v", err)
	}
	if len(pages) != 2 {
		t.Fatalf("got %d pages, want 2", len(pages))
	}
	if pages[0].W != 1224 || pages[0].H != 1584 {
		t.Errorf("page 0 dims = %dx%d, want 1224x1584", pages[0].W, pages[0].H)
	}
	got, err := pages[0].Bytes()
	if err != nil {
		t.Fatalf("Bytes: %v", err)
	}
	if string(got) != string(pngA) {
		t.Errorf("page 0 bytes mismatch")
	}
	// Second call should return the cached buffer (same backing
	// array — easiest check is identity via length & content).
	got2, _ := pages[0].Bytes()
	if &got[0] != &got2[0] {
		t.Errorf("Bytes() not memoized — second call decoded again")
	}
}

func TestRasterPDF_DisabledShortCircuits(t *testing.T) {
	cfg := Config{Enabled: false}
	pages, err := cfg.RasterPDF(context.Background(), []byte("anything"))
	if !errors.Is(err, ErrDisabled) {
		t.Fatalf("err = %v, want ErrDisabled", err)
	}
	if pages != nil {
		t.Errorf("pages = %v, want nil", pages)
	}
}

func TestRasterPDF_EmptyBody(t *testing.T) {
	cfg := Config{Enabled: true, BaseURL: "http://unused", PerPageTimeout: time.Second}
	pages, err := cfg.RasterPDF(context.Background(), nil)
	if err != nil {
		t.Errorf("err = %v, want nil", err)
	}
	if pages != nil {
		t.Errorf("pages = %v, want nil for empty body", pages)
	}
}

func TestRasterPDF_SidecarUnavailableWrapped(t *testing.T) {
	cfg := Config{
		Enabled:        true,
		BaseURL:        "http://127.0.0.1:1", // refused
		MaxPages:       1,
		PerPageTimeout: time.Second,
	}
	_, err := cfg.RasterPDF(context.Background(), []byte("body"))
	if err == nil {
		t.Fatal("want error, got nil")
	}
	if !errors.Is(err, ErrSidecarUnavailable) {
		t.Errorf("err = %v, want wrapped ErrSidecarUnavailable", err)
	}
}

// TestRasterPDF_DPIClampedDown verifies that an operator-set OCR_DPI
// lower than RasterDPI is honoured (memory-constrained deployments),
// but a higher OCR_DPI is ignored — vision models don't benefit from
// the extra pixels and the per-image byte cap matters.
func TestRasterPDF_DPIClampedDown(t *testing.T) {
	pngStub := base64.StdEncoding.EncodeToString([]byte{0x89, 0x50})
	body := `{"pages":[{"w":100,"h":100,"png_base64":"` + pngStub + `"}]}`

	t.Run("explicit lower DPI honoured", func(t *testing.T) {
		var seenDPI string
		srv := fakeLayoutSidecar(t, "/raster/pdf", body, func(t *testing.T, f map[string]string, _ []byte) {
			seenDPI = f["dpi"]
		})
		defer srv.Close()
		cfg := Config{Enabled: true, BaseURL: srv.URL, MaxPages: 1, DPI: 96, PerPageTimeout: time.Second}
		if _, err := cfg.RasterPDF(context.Background(), []byte("x")); err != nil {
			t.Fatalf("RasterPDF: %v", err)
		}
		if seenDPI != "96" {
			t.Errorf("dpi = %q, want 96 (operator override)", seenDPI)
		}
	})

	t.Run("higher DPI capped at RasterDPI", func(t *testing.T) {
		var seenDPI string
		srv := fakeLayoutSidecar(t, "/raster/pdf", body, func(t *testing.T, f map[string]string, _ []byte) {
			seenDPI = f["dpi"]
		})
		defer srv.Close()
		cfg := Config{Enabled: true, BaseURL: srv.URL, MaxPages: 1, DPI: 300, PerPageTimeout: time.Second}
		if _, err := cfg.RasterPDF(context.Background(), []byte("x")); err != nil {
			t.Fatalf("RasterPDF: %v", err)
		}
		if seenDPI != "144" {
			t.Errorf("dpi = %q, want 144 (capped at RasterDPI)", seenDPI)
		}
	})
}

func TestRasterPage_BytesBadBase64(t *testing.T) {
	p := RasterPage{PNGBase64: "!!! not base64 !!!"}
	if _, err := p.Bytes(); err == nil {
		t.Fatal("want decode error, got nil")
	}
}
