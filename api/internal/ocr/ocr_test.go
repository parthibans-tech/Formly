package ocr

// Tests for the OCR package. The integration paths (PDFToText, ImageToText)
// shell out to real binaries — `tesseract` and `pdftoppm` — so they
// t.Skip when those aren't on PATH. Every CI / dev environment that
// has them installed will run the integration; everywhere else the
// pure-config tests still cover the env wiring + sentinel mapping.
//
// We do NOT vendor a tesseract binary fixture. The wider codebase's
// docconvert package follows the same pattern (skip on missing
// soffice), and this keeps the test fixture footprint tiny.

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestFromEnv_Defaults(t *testing.T) {
	// Save + restore env to avoid side-effects between tests.
	for _, k := range []string{"OCR_ENABLED", "OCR_LANG", "OCR_MAX_PAGES",
		"OCR_DPI", "OCR_PER_PAGE_TIMEOUT_SEC"} {
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
	t.Setenv("OCR_LANG", "eng+fra")
	t.Setenv("OCR_MAX_PAGES", "100")
	t.Setenv("OCR_DPI", "300")
	t.Setenv("OCR_PER_PAGE_TIMEOUT_SEC", "45")
	c := FromEnv()
	if !c.Enabled {
		t.Error("OCR_ENABLED=true did not set Enabled")
	}
	if c.Lang != "eng+fra" {
		t.Errorf("Lang = %q, want %q", c.Lang, "eng+fra")
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

func TestFromEnv_BogusValuesIgnored(t *testing.T) {
	// A typo'd OCR_DPI shouldn't crash startup or silently use 0 —
	// we keep the default and log nothing (Atoi error path).
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

func TestProbe_MissingTesseract(t *testing.T) {
	// Point at a definitely-non-existent path. We expect the bin lookup
	// to short-circuit because TesseractBin is set explicitly — but the
	// test's intent is to verify the sentinel is wired right when the
	// binary truly can't be resolved.
	c := Config{Enabled: true, TesseractBin: "", PdftoppmBin: "/nope/pdftoppm"}
	if _, err := exec.LookPath("tesseract"); err != nil {
		err := c.Probe()
		if !errors.Is(err, ErrTesseractMissing) {
			t.Errorf("Probe() = %v, want ErrTesseractMissing", err)
		}
		return
	}
	t.Skip("tesseract present on PATH — can't exercise the ErrTesseractMissing path here")
}

// ---- integration: skip when binaries are missing ---- //

func mustBin(t *testing.T, name string) string {
	t.Helper()
	p, err := exec.LookPath(name)
	if err != nil {
		t.Skipf("%s not on PATH — skipping integration", name)
	}
	return p
}

func TestImageToText_Integration(t *testing.T) {
	tess := mustBin(t, "tesseract")
	c := Config{
		Enabled:        true,
		Lang:           "eng",
		PerPageTimeout: 30 * time.Second,
		TesseractBin:   tess,
	}
	// Use tesseract's own bundled test image is overkill — instead we
	// generate one on the fly with `convert` (ImageMagick) when it's
	// available. If neither convert nor a fixture is present we skip.
	convert, err := exec.LookPath("convert")
	if err != nil {
		t.Skip("ImageMagick `convert` not on PATH — skipping image fixture generation")
	}
	tmp := t.TempDir()
	imgPath := tmp + "/hello.png"
	cmd := exec.Command(convert, "-size", "400x80", "xc:white",
		"-font", "Helvetica", "-pointsize", "32",
		"-fill", "black", "-gravity", "center",
		"-annotate", "+0+0", "Hello OCR",
		imgPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("convert failed: %v: %s", err, string(out))
	}
	body, err := os.ReadFile(imgPath)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	got, err := c.ImageToText(context.Background(), body)
	if err != nil {
		t.Fatalf("ImageToText: %v", err)
	}
	got = strings.ToLower(strings.TrimSpace(got))
	if !strings.Contains(got, "hello") {
		t.Errorf("expected 'hello' in OCR output, got %q", got)
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
