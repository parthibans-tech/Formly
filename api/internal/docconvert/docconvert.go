// Package docconvert wraps a LibreOffice (`soffice --headless`) invocation
// to turn Word / RTF / ODT / etc. into PDF. It is deliberately small —
// one function (Convert) that takes bytes in and returns bytes out — so
// the worker can call it from inside an asynq handler without dragging
// in a long-running daemon.
//
// Operational notes:
//
//   - LibreOffice must be installed in the worker's PATH (`soffice` or
//     `libreoffice`) or pointed at via the LIBREOFFICE_BIN env var.
//     Production deployments should bake it into the worker image
//     (`apt-get install -y libreoffice` on Debian/Ubuntu, `brew
//     install --cask libreoffice` on macOS dev).
//   - We spawn one process per conversion. That's slower than a UNO
//     bridge but avoids a stateful daemon, which simplifies retries
//     and crash recovery in a queue worker.
//   - DOCM/DOTM macros are NOT executed — `soffice --convert-to pdf`
//     ignores them. We surface a warning string ("macros stripped")
//     so the audit trail can record it but conversion itself succeeds.
//   - Apple Pages (`.pages`) and similar bundle formats are unsupported
//     by soffice; Convert returns ErrUnsupported and the caller marks
//     the file accordingly.

package docconvert

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// DefaultTimeout is the wall-clock budget for a single conversion.
// LibreOffice cold-starts in ~3-5s; large Word docs add up to 10s of
// rendering. 60s catches both without holding the worker hostage to
// runaway documents.
const DefaultTimeout = 60 * time.Second

// ErrUnsupported is returned for formats LibreOffice can't read
// (currently `.pages`). Callers should mark the file `unsupported`
// rather than retrying.
var ErrUnsupported = errors.New("docconvert: unsupported format")

// ErrSofficeMissing is returned when no `soffice` / `libreoffice`
// binary is on PATH. The worker treats this as an operational gap
// (not a per-file failure) so the file row stays `pending` and a
// later worker with the binary installed will pick it up on retry.
var ErrSofficeMissing = errors.New("docconvert: soffice binary not found in PATH")

// Result captures both the converted PDF and any soft warning we want
// to surface to the user (e.g. "macros stripped"). Warning is empty
// when the conversion is clean.
type Result struct {
	PDF     []byte
	Warning string
}

// IsConvertible reports whether a (mime, filename) pair should be
// routed through soffice. Both inputs are accepted because browsers
// often upload these formats with `application/octet-stream`, so
// extension-only is the most reliable signal.
func IsConvertible(mime, name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".doc", ".docx", ".docm",
		".dot", ".dotx", ".dotm",
		".rtf", ".odt", ".ott",
		".wps":
		return true
	}
	switch strings.ToLower(mime) {
	case
		"application/msword",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.ms-word.document.macroenabled.12",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.template",
		"application/vnd.ms-word.template.macroenabled.12",
		"application/rtf",
		"text/rtf",
		"application/vnd.oasis.opendocument.text":
		return true
	}
	return false
}

// IsExplicitlyUnsupported flags formats we accept the upload of (so
// users keep their original) but where soffice can't produce a usable
// preview. Today that's just `.pages` (Apple Pages) — soffice "opens"
// the bundle but renders only a placeholder PDF. Treat as unsupported
// at ingest time so we don't waste worker cycles trying.
func IsExplicitlyUnsupported(mime, name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	return ext == ".pages"
}

// IsMacroEnabled reports whether the source format carries macros that
// LibreOffice would silently strip during PDF conversion. Used to set
// the `macro_warning` flag on the converted file so admins can audit.
func IsMacroEnabled(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	return ext == ".docm" || ext == ".dotm"
}

// Convert runs LibreOffice headless and returns the rendered PDF. The
// `name` argument is used as the input file's on-disk name so soffice
// picks the right importer (the extension matters — content sniffing
// alone isn't enough for, e.g., DOCM).
func Convert(ctx context.Context, src []byte, name string) (*Result, error) {
	if IsExplicitlyUnsupported("", name) {
		return nil, ErrUnsupported
	}
	bin, err := findSoffice()
	if err != nil {
		return nil, err
	}

	// Per-conversion temp dir. Use a fresh user profile (-env:UserInstallation)
	// pointed at the same dir so concurrent worker calls don't race on
	// LibreOffice's lock file in ~/.config.
	tmp, err := os.MkdirTemp("", "docconvert-*")
	if err != nil {
		return nil, fmt.Errorf("mktemp: %w", err)
	}
	defer os.RemoveAll(tmp)

	inPath := filepath.Join(tmp, sanitizeName(name))
	if err := os.WriteFile(inPath, src, 0o600); err != nil {
		return nil, fmt.Errorf("write input: %w", err)
	}

	deadline, cancel := context.WithTimeout(ctx, DefaultTimeout)
	defer cancel()

	profile := filepath.Join(tmp, "profile")
	cmd := exec.CommandContext(deadline, bin,
		"--headless",
		"--norestore",
		"--nologo",
		"--nofirststartwizard",
		"-env:UserInstallation=file://"+profile,
		"--convert-to", "pdf",
		"--outdir", tmp,
		inPath,
	)
	cmd.Env = append(os.Environ(), "HOME="+tmp)

	out, runErr := cmd.CombinedOutput()
	if deadline.Err() != nil {
		return nil, fmt.Errorf("docconvert: timeout after %s: %s", DefaultTimeout, string(out))
	}
	if runErr != nil {
		return nil, fmt.Errorf("docconvert: soffice failed: %v: %s", runErr, string(out))
	}

	pdfPath := filepath.Join(tmp, replaceExt(filepath.Base(inPath), ".pdf"))
	pdfBytes, err := os.ReadFile(pdfPath)
	if err != nil {
		// Some soffice builds emit a slightly different stem (collapsing
		// spaces, normalising case). Fall back to the first .pdf in the
		// directory before giving up.
		entries, _ := os.ReadDir(tmp)
		for _, e := range entries {
			if strings.HasSuffix(strings.ToLower(e.Name()), ".pdf") {
				if pdfBytes, err = os.ReadFile(filepath.Join(tmp, e.Name())); err == nil {
					break
				}
			}
		}
		if err != nil {
			return nil, fmt.Errorf("docconvert: pdf not produced: %w (output: %s)", err, string(out))
		}
	}

	res := &Result{PDF: pdfBytes}
	if IsMacroEnabled(name) {
		res.Warning = "Macros were stripped during conversion."
	}
	return res, nil
}

// findSoffice resolves the LibreOffice binary. Honors LIBREOFFICE_BIN
// for ops who install it in non-standard locations. On macOS the cask
// installs to /Applications/LibreOffice.app/Contents/MacOS/soffice
// which isn't on PATH by default.
func findSoffice() (string, error) {
	if v := strings.TrimSpace(os.Getenv("LIBREOFFICE_BIN")); v != "" {
		if _, err := os.Stat(v); err == nil {
			return v, nil
		}
	}
	for _, name := range []string{"soffice", "libreoffice"} {
		if p, err := exec.LookPath(name); err == nil {
			return p, nil
		}
	}
	for _, p := range []string{
		"/Applications/LibreOffice.app/Contents/MacOS/soffice",
		"/usr/bin/soffice",
		"/usr/local/bin/soffice",
		"/opt/homebrew/bin/soffice",
	} {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	return "", ErrSofficeMissing
}

// sanitizeName keeps the extension intact (soffice needs it) while
// stripping path separators and other characters that would let an
// untrusted filename escape the temp dir.
func sanitizeName(name string) string {
	name = filepath.Base(name)
	if name == "" || name == "." || name == ".." {
		return "input.bin"
	}
	// Replace anything not-alnum/dot/dash/underscore with `_`.
	out := make([]rune, 0, len(name))
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '.' || r == '-' || r == '_':
			out = append(out, r)
		default:
			out = append(out, '_')
		}
	}
	return string(out)
}

func replaceExt(name, newExt string) string {
	old := filepath.Ext(name)
	if old == "" {
		return name + newExt
	}
	return strings.TrimSuffix(name, old) + newExt
}
