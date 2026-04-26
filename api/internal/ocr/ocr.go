// Package ocr is a thin wrapper around the `tesseract` CLI plus a
// PDF rasterizer (`pdftoppm` from poppler-utils) so the docchat
// "Summarize / Ask" feature can answer questions about scanned PDFs
// and image uploads.
//
// # Why a separate package
//
// OCR sits at a different cost tier than text extraction:
//
//   - Plain text / DOCX → microseconds, in-process.
//   - PDF text layer    → a few ms via ledongthuc/pdf, in-process.
//   - OCR               → seconds per page, two subprocess spawns
//                         (pdftoppm + tesseract), heavy CPU.
//
// Mixing those into the same Extractor seam would mean every embed
// pipeline silently starts OCR-ing every scanned PDF on next worker
// run — a serious capacity surprise. Keeping OCR in its own package
// behind an explicit `Config.Enabled` flag means operators opt in
// once, and only docchat (the immediate consumer) wires it up.
//
// # Why subprocess instead of CGO
//
// `gosseract` (CGO bindings to libtesseract) would be marginally
// faster and avoid a fork/exec, but:
//
//   - It pulls a CGO toolchain into a previously-pure-Go build,
//     breaking simple cross-compilation and macOS dev installs.
//   - Memory pressure: tesseract's heap is per-process, so a leak in
//     one OCR run doesn't accumulate across requests.
//   - The `tesseract` binary is what every Linux distro packages and
//     what every "tesseract OCR" doc on the internet documents — the
//     subprocess approach is the path of least operator surprise.
//
// We mirror docconvert's "shell out, bounded timeout, fail closed"
// idiom for the same reasons.
//
// # Operational requirements
//
// Production worker / api images need:
//
//	apt-get install -y tesseract-ocr poppler-utils
//
// For multi-language OCR, install the language pack
// (`tesseract-ocr-<lang>`) and set OCR_LANG accordingly.
package ocr

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
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
	// ErrTesseractMissing is returned when no tesseract binary is on
	// PATH despite the feature being enabled. Operators see this in
	// the api log on startup-time probe; the per-request error path
	// surfaces it as a 502 ai_error so users know it's a deployment
	// issue, not a content issue.
	ErrTesseractMissing = errors.New("ocr: tesseract binary not found in PATH")
	// ErrPdftoppmMissing — same idea for the rasterizer.
	ErrPdftoppmMissing = errors.New("ocr: pdftoppm binary not found in PATH")
)

// Tesseract page-segmentation mode constants. Names mirror tesseract's
// own --psm help so an operator reading OCR_PSM=6 in env can match it
// up with the documentation. We expose this as a tunable because the
// default (PSM 3, fully automatic) hedges across page types and tends
// to misread ID-card-shaped uniform text — switching to PSM 6 (single
// uniform block) lifts accuracy noticeably on PAN, Aadhaar, receipts.
const (
	PSMOSDOnly                       = 0  // orientation/script detection only, no OCR
	PSMAutoWithOSD                   = 1  // auto + OSD
	PSMAutoOnly                      = 2  // auto without OSD
	PSMAuto                          = 3  // default — auto without OSD, no full layout analysis
	PSMSingleColumn                  = 4
	PSMSingleVerticalBlock           = 5
	PSMSingleUniformBlock            = 6  // ID cards, receipts, single-block scans
	PSMSingleLine                    = 7
	PSMSingleWord                    = 8
	PSMSingleWordCircle              = 9
	PSMSingleChar                    = 10
	PSMSparseText                    = 11
	PSMSparseTextWithOSD             = 12
	PSMRawLineBypassHacks            = 13
)

// Config governs the OCR engine's behaviour. The zero value is
// "disabled" — call FromEnv to populate, or build manually.
type Config struct {
	Enabled bool

	// Lang is passed to tesseract -l. Default "eng". Multi-language
	// recognition uses "+": e.g. "eng+fra" reads English-and-French
	// pages. The corresponding language pack must be installed.
	Lang string

	// MaxPages caps how many pages of a PDF we'll OCR in a single
	// request. Defends against a 500-page scanned book pinning a
	// worker for an hour. Pages beyond the cap are silently dropped
	// and the caller surfaces a "first N pages only" disclosure.
	MaxPages int

	// DPI for pdftoppm rasterization. 200 is the empirical sweet spot
	// for tesseract — higher (300+) marginally improves accuracy on
	// small fonts but doubles per-page CPU; lower (150) is fine for
	// typed contracts but loses accuracy on hand-written or 8pt text.
	DPI int

	// PerPageTimeout caps a single tesseract invocation. Tesseract
	// occasionally pathologically loops on certain inputs; the
	// timeout breaks those cases without taking the whole request
	// down.
	PerPageTimeout time.Duration

	// PSM selects the tesseract page-segmentation mode (--psm). Default
	// 3 (PSMAuto). For ID cards / receipts / single-block scans, 6
	// (PSMSingleUniformBlock) consistently improves accuracy because
	// tesseract stops trying to detect non-existent columns/headers.
	// Set OCR_PSM=6 in env to flip it globally; future work could pick
	// PSM per MIME or run a dual-pass and keep the higher-confidence
	// output.
	PSM int

	// Preprocess enables an imagemagick preprocessing pass before
	// tesseract sees the image:
	//
	//   convert <in> -auto-orient -strip -deskew 40% -colorspace Gray
	//                -normalize -sharpen 0x1 <out>.png
	//
	// This is the single biggest accuracy lever on phone photos: the
	// deskew straightens up handheld snaps, grayscale + normalize fix
	// uneven lighting / faded prints, and the sharpen recovers small
	// glyphs (e.g. the leading "9183" of an Aadhaar number that often
	// gets read as "et eee" without it). Disabled when ImageMagick
	// isn't on PATH — Probe() doesn't fail in that case, we just
	// silently skip preprocessing.
	Preprocess bool

	// TesseractBin / PdftoppmBin / ImageMagickBin override the binary
	// lookup. Kept exposed for tests; production code leaves these
	// zero so we resolve via PATH.
	TesseractBin   string
	PdftoppmBin    string
	ImageMagickBin string
}

// Defaults populated by FromEnv when env vars are unset.
const (
	defaultLang           = "eng"
	defaultMaxPages       = 30
	defaultDPI            = 200
	defaultPerPageTimeout = 30 * time.Second
	defaultPSM            = PSMAuto
	// defaultPreprocess intentionally true: the imagemagick pass is
	// idempotent on clean inputs (auto-level + sharpen barely change
	// already-clean docs) but is a major win on phone photos. We
	// auto-disable at runtime if ImageMagick isn't installed, so
	// shipping with this on doesn't break deployments without it.
	defaultPreprocess = true
)

// FromEnv builds a Config from environment variables:
//
//	OCR_ENABLED              "1"/"true" to enable
//	OCR_LANG                 tesseract -l value (default "eng")
//	OCR_MAX_PAGES            cap pages per PDF (default 30)
//	OCR_DPI                  pdftoppm DPI (default 200)
//	OCR_PER_PAGE_TIMEOUT_SEC per-page tesseract budget (default 30)
//	OCR_PSM                  tesseract --psm 0..13 (default 3; try 6
//	                         for ID cards / receipts)
//	OCR_PREPROCESS           "0"/"false" to disable the imagemagick
//	                         preprocessing pass (default on)
func FromEnv() Config {
	c := Config{
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
		if n, err := strconv.Atoi(v); err == nil && n >= 0 && n <= 13 {
			c.PSM = n
		}
	}
	if v := os.Getenv("OCR_PREPROCESS"); v != "" {
		// Explicit override (in either direction). Anything other than
		// the recognized truthy values turns it off, matching how
		// OCR_ENABLED parses.
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
// We return a value (not a pointer) because the rest of the package
// works on Config-by-value, and the override path runs once per
// /extract-text request — the copy is cheaper than the locking we'd
// need to share a mutable Config across goroutines.
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

// Probe verifies the configured binaries are present. Call once at
// startup to log a clear "OCR enabled but tesseract missing" message
// instead of failing the first request.
func (c Config) Probe() error {
	if !c.Enabled {
		return ErrDisabled
	}
	if _, err := c.tesseractPath(); err != nil {
		return err
	}
	if _, err := c.pdftoppmPath(); err != nil {
		return err
	}
	return nil
}

func (c Config) tesseractPath() (string, error) {
	if c.TesseractBin != "" {
		return c.TesseractBin, nil
	}
	p, err := exec.LookPath("tesseract")
	if err != nil {
		return "", ErrTesseractMissing
	}
	return p, nil
}

func (c Config) pdftoppmPath() (string, error) {
	if c.PdftoppmBin != "" {
		return c.PdftoppmBin, nil
	}
	p, err := exec.LookPath("pdftoppm")
	if err != nil {
		return "", ErrPdftoppmMissing
	}
	return p, nil
}

// imagemagickPath resolves the ImageMagick binary. ImageMagick 7 ships
// `magick` as the canonical entry point and `convert` as a back-compat
// shim; ImageMagick 6 only has `convert`. We prefer `magick` because
// IM6 is reaching end-of-life and `convert` collides with a Windows
// system utility — operators following modern docs install IM7. Falls
// back to `convert` if `magick` isn't found. When neither is on PATH
// we return ("", nil) — preprocessing is best-effort, never fatal.
func (c Config) imagemagickPath() (string, error) {
	if c.ImageMagickBin != "" {
		return c.ImageMagickBin, nil
	}
	if p, err := exec.LookPath("magick"); err == nil {
		return p, nil
	}
	if p, err := exec.LookPath("convert"); err == nil {
		return p, nil
	}
	return "", nil
}

// preprocessImage runs an imagemagick pipeline that materially improves
// tesseract accuracy on phone photos. The output is a normalized PNG
// at the same path with a ".pp.png" suffix; on any failure we return
// the original path so the caller falls back to vanilla OCR rather
// than 502'ing a request over a preprocessing hiccup.
//
// The pipeline (chosen empirically; each step is well-known in OCR
// docs):
//
//	-auto-orient    respect EXIF rotation (portrait phone photos)
//	-strip          drop EXIF/ICC after orientation is applied
//	-deskew 40%     correct up to ~40° of skew from a handheld snap
//	-colorspace Gray  3 channels of phone-camera color noise → 1
//	-normalize      stretch contrast to fill the dynamic range
//	-sharpen 0x1    gentle high-frequency boost; recovers small glyphs
//
// We deliberately don't binarize (-threshold) because tesseract 5's
// LSTM engine reads grayscale better than pre-binarized input — the
// engine does its own adaptive thresholding internally and an
// over-aggressive global threshold can wipe faint strokes.
func (c Config) preprocessImage(ctx context.Context, in string) string {
	if !c.Preprocess {
		return in
	}
	bin, _ := c.imagemagickPath()
	if bin == "" {
		return in
	}
	out := in + ".pp.png"
	pipeline := []string{
		"-auto-orient",
		"-strip",
		"-deskew", "40%",
		"-colorspace", "Gray",
		"-normalize",
		"-sharpen", "0x1",
	}
	// IM7 (`magick`) takes <input> directly; IM6 (`convert` shim)
	// also accepts that form, so a single arg shape works for both.
	args := append([]string{in}, append(pipeline, out)...)
	deadline, cancel := context.WithTimeout(ctx, c.PerPageTimeout)
	defer cancel()
	cmd := exec.CommandContext(deadline, bin, args...)
	if err := cmd.Run(); err != nil {
		// Best-effort: drop back to the original. Common causes are
		// HEIC inputs without libheif, animated GIFs, or a corrupt
		// upload. None of those are worth failing the OCR call over.
		return in
	}
	if _, err := os.Stat(out); err != nil {
		return in
	}
	return out
}

// PDFToText rasterizes each page with pdftoppm at the configured DPI,
// runs tesseract on each PNG in document order, and returns the
// concatenated plain text. Pages are processed sequentially — running
// them in parallel would cut wall time but multiplies CPU demand on
// a worker that's also serving other requests.
//
// On a partial failure (page 4 of 10 panics tesseract), we return what
// we got from pages 1–3 plus the error wrapped so the caller can
// decide whether to surface the partial answer or fail closed.
// docchat surfaces the partial because "first 3 pages of a 10-page
// scan" is still useful UX for "summarise this".
func (c Config) PDFToText(ctx context.Context, body []byte) (string, error) {
	if !c.Enabled {
		return "", ErrDisabled
	}
	if len(body) == 0 {
		return "", nil
	}
	tessBin, err := c.tesseractPath()
	if err != nil {
		return "", err
	}
	popBin, err := c.pdftoppmPath()
	if err != nil {
		return "", err
	}

	tmp, err := os.MkdirTemp("", "ocr-*")
	if err != nil {
		return "", fmt.Errorf("ocr mktemp: %w", err)
	}
	defer os.RemoveAll(tmp)

	inPath := filepath.Join(tmp, "in.pdf")
	if err := os.WriteFile(inPath, body, 0o600); err != nil {
		return "", fmt.Errorf("ocr write input: %w", err)
	}

	// Step 1: rasterize. pdftoppm writes <prefix>-1.png, <prefix>-2.png …
	// We cap with -l (last page) so even a 500-page input stops at
	// MaxPages — pdftoppm aborts cleanly if -l > NumPages, so we don't
	// need to peek the page count first.
	prefix := filepath.Join(tmp, "p")
	rasterCtx, cancel := context.WithTimeout(ctx, c.PerPageTimeout*time.Duration(max(1, c.MaxPages)))
	defer cancel()
	args := []string{"-png", "-r", strconv.Itoa(c.DPI),
		"-l", strconv.Itoa(c.MaxPages), inPath, prefix}
	rasterCmd := exec.CommandContext(rasterCtx, popBin, args...)
	if out, err := rasterCmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("ocr rasterize: %v: %s", err, string(out))
	}

	// Step 2: collect the produced PNGs in document order. pdftoppm's
	// numeric suffix is *not* zero-padded (p-1.png, p-10.png, p-2.png),
	// so we re-sort numerically rather than relying on lexicographic
	// readdir order — otherwise page 10 would slot in before page 2 in
	// the OCR output.
	entries, err := os.ReadDir(tmp)
	if err != nil {
		return "", fmt.Errorf("ocr readdir: %w", err)
	}
	type pageFile struct {
		path string
		num  int
	}
	var pages []pageFile
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasPrefix(name, "p-") || !strings.HasSuffix(name, ".png") {
			continue
		}
		numStr := strings.TrimSuffix(strings.TrimPrefix(name, "p-"), ".png")
		n, err := strconv.Atoi(numStr)
		if err != nil {
			continue
		}
		pages = append(pages, pageFile{filepath.Join(tmp, name), n})
	}
	sort.Slice(pages, func(i, j int) bool { return pages[i].num < pages[j].num })

	if len(pages) == 0 {
		// pdftoppm produced no images — likely a non-PDF or a
		// password-protected file. Treat as not-textual.
		return "", nil
	}

	// Step 3: OCR each page. Streaming PNG into tesseract via stdin
	// avoids one disk round-trip per page; the input we just wrote is
	// already on local tmpfs so stdin via os.Open is essentially free.
	var combined strings.Builder
	for _, p := range pages {
		text, err := c.ocrFile(ctx, tessBin, p.path)
		if err != nil {
			// Return what we have + wrapped error. docchat surfaces
			// the partial answer with a "OCR failed on page N" footer.
			return combined.String(), fmt.Errorf("ocr page %d: %w", p.num, err)
		}
		combined.WriteString(text)
		// Page break — gives the LLM a structural hint and keeps
		// "page 3 mentions X" answers possible.
		combined.WriteString("\n\n")
	}
	return combined.String(), nil
}

// ImageToText runs tesseract directly on an image blob (PNG/JPEG/TIFF/
// anything tesseract reads). No rasterization step, no MaxPages cap
// (it's a single image by definition).
//
// Pipeline: write blob → preprocess (if enabled and ImageMagick is
// installed) → tesseract on the cleaned image. Preprocessing is
// best-effort: any failure quietly falls back to OCR'ing the raw
// upload, so a missing `magick`/`convert` binary doesn't break OCR.
func (c Config) ImageToText(ctx context.Context, body []byte) (string, error) {
	if !c.Enabled {
		return "", ErrDisabled
	}
	if len(body) == 0 {
		return "", nil
	}
	tessBin, err := c.tesseractPath()
	if err != nil {
		return "", err
	}
	tmp, err := os.MkdirTemp("", "ocr-img-*")
	if err != nil {
		return "", fmt.Errorf("ocr mktemp: %w", err)
	}
	defer os.RemoveAll(tmp)
	in := filepath.Join(tmp, "in.bin")
	if err := os.WriteFile(in, body, 0o600); err != nil {
		return "", fmt.Errorf("ocr write input: %w", err)
	}
	cleaned := c.preprocessImage(ctx, in)
	return c.ocrFile(ctx, tessBin, cleaned)
}

// ocrFile is the shared invocation:
//
//	tesseract <input> stdout -l <lang> --psm <N>
//
// We deliberately read stderr separately because tesseract chats to
// stderr ("Estimating resolution as 257", "Detected 8 diacritics") on
// every successful run — capturing it via CombinedOutput would
// pollute the extracted text.
func (c Config) ocrFile(ctx context.Context, bin, in string) (string, error) {
	deadline, cancel := context.WithTimeout(ctx, c.PerPageTimeout)
	defer cancel()
	lang := c.Lang
	if lang == "" {
		lang = defaultLang
	}
	psm := c.PSM
	if psm < 0 || psm > 13 {
		psm = defaultPSM
	}
	cmd := exec.CommandContext(deadline, bin,
		in, "stdout",
		"-l", lang,
		"--psm", strconv.Itoa(psm),
	)
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		if deadline.Err() != nil {
			return "", fmt.Errorf("tesseract timeout after %s: %s", c.PerPageTimeout, errb.String())
		}
		return "", fmt.Errorf("tesseract failed: %v: %s", err, errb.String())
	}
	return out.String(), nil
}

