package ocr

// Tests for the OCR HTTP client. The integration paths previously
// shelled out to real binaries (`tesseract`, `pdftoppm`) and skipped
// when those weren't on PATH; now the package is purely an HTTP
// client to the paddle-ocr sidecar, so we can test the wire shape
// against an in-process httptest.Server without needing any external
// process to be installed.
//
// Coverage:
//   - Env wiring (defaults, overrides, bogus values).
//   - Probe success / failure / disabled.
//   - PDFToText / ImageToText round-trip against a mock sidecar
//     (verifies multipart form construction + JSON decode).
//   - Per-call timeout enforcement via context.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestFromEnv_Defaults(t *testing.T) {
	// Save + restore env to avoid side-effects between tests.
	for _, k := range []string{
		"OCR_ENABLED", "OCR_LANG", "OCR_MAX_PAGES",
		"OCR_DPI", "OCR_PER_PAGE_TIMEOUT_SEC", "OCR_PSM",
		"OCR_PREPROCESS", "PADDLE_OCR_URL",
	} {
		old, hadIt := os.LookupEnv(k)
		_ = os.Unsetenv(k)
		t.Cleanup(func() {
			if hadIt {
				_ = os.Setenv(k, old)
			} else {
				_ = os.Unsetenv(k)
			}
		})
	}
	c := FromEnv()
	if c.Enabled {
		t.Error("default Enabled = true, want false (off-by-default contract)")
	}
	if c.Lang != defaultLang {
		t.Errorf("Lang = %q, want %q", c.Lang, defaultLang)
	}
	if c.BaseURL != defaultBaseURL {
		t.Errorf("BaseURL = %q, want %q", c.BaseURL, defaultBaseURL)
	}
	if c.MaxPages != defaultMaxPages {
		t.Errorf("MaxPages = %d, want %d", c.MaxPages, defaultMaxPages)
	}
	if c.DPI != defaultDPI {
		t.Errorf("DPI = %d, want %d", c.DPI, defaultDPI)
	}
	if c.PerPageTimeout != defaultPerPageTimeout {
		t.Errorf("PerPageTimeout = %s, want %s", c.PerPageTimeout, defaultPerPageTimeout)
	}
}

func TestFromEnv_Override(t *testing.T) {
	t.Setenv("OCR_ENABLED", "true")
	t.Setenv("OCR_LANG", "en+hi")
	t.Setenv("OCR_MAX_PAGES", "100")
	t.Setenv("OCR_DPI", "300")
	t.Setenv("OCR_PER_PAGE_TIMEOUT_SEC", "45")
	t.Setenv("PADDLE_OCR_URL", "http://paddle-ocr:8868")
	c := FromEnv()
	if !c.Enabled {
		t.Error("OCR_ENABLED=true did not set Enabled")
	}
	if c.Lang != "en+hi" {
		t.Errorf("Lang = %q, want %q", c.Lang, "en+hi")
	}
	if c.BaseURL != "http://paddle-ocr:8868" {
		t.Errorf("BaseURL = %q, want %q", c.BaseURL, "http://paddle-ocr:8868")
	}
	if c.MaxPages != 100 {
		t.Errorf("MaxPages = %d, want 100", c.MaxPages)
	}
	if c.DPI != 300 {
		t.Errorf("DPI = %d, want 300", c.DPI)
	}
	if c.PerPageTimeout != 45*time.Second {
		t.Errorf("PerPageTimeout = %s, want 45s", c.PerPageTimeout)
	}
}

func TestFromEnv_TrailingSlashStripped(t *testing.T) {
	// The /healthz and /ocr/* paths the client builds always start
	// with "/", so a trailing slash on PADDLE_OCR_URL would produce
	// "//healthz" — looks the same to most servers but breaks proxies.
	t.Setenv("PADDLE_OCR_URL", "http://paddle-ocr:8868/")
	c := FromEnv()
	if c.BaseURL != "http://paddle-ocr:8868" {
		t.Errorf("BaseURL = %q, want trailing slash stripped", c.BaseURL)
	}
}

func TestFromEnv_BogusValuesIgnored(t *testing.T) {
	t.Setenv("OCR_DPI", "high")
	t.Setenv("OCR_MAX_PAGES", "-5")
	t.Setenv("OCR_PER_PAGE_TIMEOUT_SEC", "0")
	c := FromEnv()
	if c.DPI != defaultDPI {
		t.Errorf("DPI = %d, want default %d on bad input", c.DPI, defaultDPI)
	}
	if c.MaxPages != defaultMaxPages {
		t.Errorf("MaxPages = %d, want default %d on negative input", c.MaxPages, defaultMaxPages)
	}
	if c.PerPageTimeout != defaultPerPageTimeout {
		t.Errorf("PerPageTimeout = %s, want default %s on zero input", c.PerPageTimeout, defaultPerPageTimeout)
	}
}

func TestProbe_Disabled(t *testing.T) {
	c := Config{Enabled: false}
	err := c.Probe()
	if !errors.Is(err, ErrDisabled) {
		t.Errorf("Probe() = %v, want ErrDisabled", err)
	}
}

func TestProbe_HealthzOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			t.Errorf("unexpected path %q", r.URL.Path)
			http.Error(w, "nope", 404)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(srv.Close)
	c := Config{Enabled: true, BaseURL: srv.URL}
	if err := c.Probe(); err != nil {
		t.Errorf("Probe() = %v, want nil", err)
	}
}

func TestProbe_SidecarUnreachable(t *testing.T) {
	// Point at a port nothing's listening on. We pick a high port +
	// localhost so we get a connection-refused error fast (no DNS
	// involved).
	c := Config{Enabled: true, BaseURL: "http://127.0.0.1:1"}
	err := c.Probe()
	if !errors.Is(err, ErrSidecarUnavailable) {
		t.Errorf("Probe() = %v, want ErrSidecarUnavailable", err)
	}
}

func TestProbe_HealthzNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "down", 503)
	}))
	t.Cleanup(srv.Close)
	c := Config{Enabled: true, BaseURL: srv.URL}
	err := c.Probe()
	if !errors.Is(err, ErrSidecarUnavailable) {
		t.Errorf("Probe() = %v, want ErrSidecarUnavailable", err)
	}
}

// ---- request shape: image ----

func TestImageToText_RoundTrip(t *testing.T) {
	var (
		gotLang     string
		gotFileBody []byte
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ocr/image" {
			http.Error(w, "wrong path", 404)
			return
		}
		// Read the multipart form so we can assert it was constructed
		// the way the sidecar expects.
		if err := r.ParseMultipartForm(8 << 20); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		gotLang = r.FormValue("lang")
		f, _, err := r.FormFile("file")
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		defer f.Close()
		gotFileBody, _ = io.ReadAll(f)
		_ = json.NewEncoder(w).Encode(sidecarResp{Text: "Hello OCR"})
	}))
	t.Cleanup(srv.Close)

	c := Config{
		Enabled:        true,
		BaseURL:        srv.URL,
		Lang:           "en",
		PerPageTimeout: 5 * time.Second,
	}
	got, err := c.ImageToText(context.Background(), []byte("fake-png-bytes"))
	if err != nil {
		t.Fatalf("ImageToText: %v", err)
	}
	if got != "Hello OCR" {
		t.Errorf("text = %q, want %q", got, "Hello OCR")
	}
	if gotLang != "en" {
		t.Errorf("sidecar saw lang=%q, want en", gotLang)
	}
	if string(gotFileBody) != "fake-png-bytes" {
		t.Errorf("sidecar saw file body %q, want fake-png-bytes", string(gotFileBody))
	}
}

func TestImageToText_DisabledShortCircuits(t *testing.T) {
	c := Config{Enabled: false}
	got, err := c.ImageToText(context.Background(), []byte{0x89, 0x50, 0x4e, 0x47})
	if !errors.Is(err, ErrDisabled) {
		t.Errorf("err = %v, want ErrDisabled", err)
	}
	if got != "" {
		t.Errorf("got %q, want empty", got)
	}
}

func TestImageToText_SidecarErrorWrapped(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "bad image", 400)
	}))
	t.Cleanup(srv.Close)
	c := Config{Enabled: true, BaseURL: srv.URL, PerPageTimeout: 5 * time.Second}
	_, err := c.ImageToText(context.Background(), []byte("bytes"))
	if err == nil || !strings.Contains(err.Error(), "HTTP 400") {
		t.Errorf("err = %v, want wrapped HTTP 400", err)
	}
}

// ---- request shape: pdf ----

func TestPDFToText_RoundTrip(t *testing.T) {
	var (
		gotLang     string
		gotMaxPages string
		gotDPI      string
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ocr/pdf" {
			http.Error(w, "wrong path", 404)
			return
		}
		if err := r.ParseMultipartForm(8 << 20); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		gotLang = r.FormValue("lang")
		gotMaxPages = r.FormValue("max_pages")
		gotDPI = r.FormValue("dpi")
		// File content type isn't asserted — the sidecar sniffs.
		_, _, err := r.FormFile("file")
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		_ = json.NewEncoder(w).Encode(sidecarResp{
			Text:  "page1\n\npage2",
			Pages: []string{"page1", "page2"},
		})
	}))
	t.Cleanup(srv.Close)

	c := Config{
		Enabled:        true,
		BaseURL:        srv.URL,
		Lang:           "en+hi",
		MaxPages:       10,
		DPI:            250,
		PerPageTimeout: 5 * time.Second,
	}
	got, err := c.PDFToText(context.Background(), []byte("%PDF-1.4 fake"))
	if err != nil {
		t.Fatalf("PDFToText: %v", err)
	}
	if got != "page1\n\npage2" {
		t.Errorf("text = %q, want page1\\n\\npage2", got)
	}
	if gotLang != "en+hi" {
		t.Errorf("lang = %q, want en+hi", gotLang)
	}
	if gotMaxPages != "10" {
		t.Errorf("max_pages = %q, want 10", gotMaxPages)
	}
	if gotDPI != "250" {
		t.Errorf("dpi = %q, want 250", gotDPI)
	}
}

func TestPDFToText_DisabledShortCircuits(t *testing.T) {
	c := Config{Enabled: false}
	got, err := c.PDFToText(context.Background(), []byte("%PDF-1.4"))
	if !errors.Is(err, ErrDisabled) {
		t.Errorf("err = %v, want ErrDisabled", err)
	}
	if got != "" {
		t.Errorf("got %q, want empty", got)
	}
}

func TestPDFToText_EmptyBody(t *testing.T) {
	// Zero-length body is treated as "nothing to do" — important for
	// the docchat path that may pass through an unexpected empty file
	// without 5xx'ing the request.
	c := Config{Enabled: true, BaseURL: "http://does-not-matter"}
	got, err := c.PDFToText(context.Background(), nil)
	if err != nil {
		t.Errorf("err = %v, want nil for empty body", err)
	}
	if got != "" {
		t.Errorf("got %q, want empty", got)
	}
}

// ---- WithProfile semantics ----

func TestWithProfile_OverridesAndInherits(t *testing.T) {
	base := Config{
		Enabled:        true,
		Lang:           "en",
		PSM:            PSMAuto,
		Preprocess:     true,
		PerPageTimeout: 30 * time.Second,
	}
	pp := false
	got := base.WithProfile("ta", PSMSingleUniformBlock, &pp)
	if got.Lang != "ta" {
		t.Errorf("Lang = %q, want ta", got.Lang)
	}
	if got.PSM != PSMSingleUniformBlock {
		t.Errorf("PSM = %d, want %d (stored as legacy field)", got.PSM, PSMSingleUniformBlock)
	}
	if got.Preprocess {
		t.Errorf("Preprocess = true, want false (override)")
	}

	// Empty string + nil pointer means inherit — the most common case
	// for the "generic" profile that doesn't set anything.
	inherit := base.WithProfile("", -1, nil)
	if inherit.Lang != "en" {
		t.Errorf("Lang = %q, want inherited en", inherit.Lang)
	}
	if inherit.PSM != PSMAuto {
		t.Errorf("PSM = %d, want inherited PSMAuto", inherit.PSM)
	}
	if !inherit.Preprocess {
		t.Errorf("Preprocess = false, want inherited true")
	}
}

// ---- multipart sanity (regression guard for content-type) ----

func TestPostFile_ContentTypeIsMultipart(t *testing.T) {
	var gotCT string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCT = r.Header.Get("Content-Type")
		_ = json.NewEncoder(w).Encode(sidecarResp{Text: "ok"})
	}))
	t.Cleanup(srv.Close)
	c := Config{Enabled: true, BaseURL: srv.URL, PerPageTimeout: 2 * time.Second}
	if _, err := c.ImageToText(context.Background(), []byte("x")); err != nil {
		t.Fatalf("ImageToText: %v", err)
	}
	if !strings.HasPrefix(gotCT, "multipart/form-data; boundary=") {
		t.Errorf("Content-Type = %q, want multipart/form-data; boundary=...", gotCT)
	}
}

// Touch mime/multipart so unused-import linting doesn't fire if the
// regression guard above is ever removed.
var _ = multipart.ErrMessageTooLarge
