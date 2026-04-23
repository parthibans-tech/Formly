// Package layout describes page-level rendering options shared by the HTML,
// Markdown, and Static generation modes. The concrete type is serialized into
// a template's config_json under the "pageLayout" key.
package layout

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Layout is the per-template page layout config. All fields are optional; zero
// values fall back to sensible defaults at render time.
type Layout struct {
	PageSize    string    `json:"pageSize,omitempty"`    // Letter | A4 | Legal | A3 | A5
	Orientation string    `json:"orientation,omitempty"` // portrait | landscape
	Margins     Margins   `json:"margins,omitempty"`     // inches
	Header      HFBlock   `json:"header,omitempty"`
	Footer      HFBlock   `json:"footer,omitempty"`
	PageNumbers PageNum   `json:"pageNumbers,omitempty"`
	Watermark   Watermark `json:"watermark,omitempty"`
}

// Margins are inches. Zero values default to 0.4in all around.
type Margins struct {
	Top    float64 `json:"top,omitempty"`
	Right  float64 `json:"right,omitempty"`
	Bottom float64 `json:"bottom,omitempty"`
	Left   float64 `json:"left,omitempty"`
}

// HFBlock is a header or footer. HTML is raw markup printed by Chromium. Unset
// or Enabled=false hides the block.
type HFBlock struct {
	Enabled bool   `json:"enabled,omitempty"`
	HTML    string `json:"html,omitempty"`
}

// PageNum describes automatic page numbering. When enabled, the Format string's
// {page} / {total} tokens are replaced by Chromium's built-in span classes.
type PageNum struct {
	Enabled  bool   `json:"enabled,omitempty"`
	Format   string `json:"format,omitempty"`   // e.g. "Page {page} of {total}"
	Position string `json:"position,omitempty"` // bottom-center | bottom-right | bottom-left
}

// Watermark describes an optional text watermark layered on every page.
type Watermark struct {
	Enabled  bool    `json:"enabled,omitempty"`
	Text     string  `json:"text,omitempty"`
	Opacity  float64 `json:"opacity,omitempty"`  // 0.0–1.0
	Angle    int     `json:"angle,omitempty"`    // degrees, e.g. -30
	FontSize int     `json:"fontSize,omitempty"` // px (default 120)
	Color    string  `json:"color,omitempty"`    // hex, default "#000000"
}

// FromConfig extracts the pageLayout object (if any) out of a template's raw
// config_json bytes. Returns nil if not present or malformed — callers should
// treat nil as "use defaults".
func FromConfig(cfg []byte) *Layout {
	if len(cfg) == 0 {
		return nil
	}
	var m struct {
		PageLayout *Layout `json:"pageLayout"`
	}
	if err := json.Unmarshal(cfg, &m); err != nil {
		return nil
	}
	return m.PageLayout
}

// PaperInches returns the (width, height) in inches for the given page size,
// honouring orientation. Unknown sizes fall back to Letter.
func (l *Layout) PaperInches() (w, h float64) {
	size := "Letter"
	if l != nil && l.PageSize != "" {
		size = l.PageSize
	}
	switch strings.ToLower(size) {
	case "a4":
		w, h = 8.2677, 11.6929
	case "legal":
		w, h = 8.5, 14
	case "a3":
		w, h = 11.6929, 16.5354
	case "a5":
		w, h = 5.8268, 8.2677
	default: // Letter
		w, h = 8.5, 11
	}
	if l != nil && strings.EqualFold(l.Orientation, "landscape") {
		w, h = h, w
	}
	return
}

// IsLandscape returns true if orientation is landscape.
func (l *Layout) IsLandscape() bool {
	return l != nil && strings.EqualFold(l.Orientation, "landscape")
}

// EffectiveMargins returns the margin in inches for each side, applying the
// default (0.4in) for any unset side.
func (l *Layout) EffectiveMargins() (top, right, bottom, left float64) {
	const def = 0.4
	if l == nil {
		return def, def, def, def
	}
	top, right, bottom, left = l.Margins.Top, l.Margins.Right, l.Margins.Bottom, l.Margins.Left
	if top <= 0 {
		top = def
	}
	if right <= 0 {
		right = def
	}
	if bottom <= 0 {
		bottom = def
	}
	if left <= 0 {
		left = def
	}
	return
}

// HeaderHTML returns the effective header template for Chromium's PrintToPDF.
// Returns an empty string if no header should be shown.
func (l *Layout) HeaderHTML() string {
	if l == nil || !l.Header.Enabled {
		return ""
	}
	body := l.Header.HTML
	if body == "" {
		return ""
	}
	return wrapHF(body, "")
}

// FooterHTML returns the effective footer template, merging page-number tokens
// if enabled. Returns an empty string if no footer should be shown.
func (l *Layout) FooterHTML() string {
	if l == nil {
		return ""
	}
	custom := ""
	if l.Footer.Enabled {
		custom = l.Footer.HTML
	}
	pageNumHTML := ""
	if l.PageNumbers.Enabled {
		format := l.PageNumbers.Format
		if format == "" {
			format = "{page} / {total}"
		}
		format = strings.ReplaceAll(format, "{page}", `<span class="pageNumber"></span>`)
		format = strings.ReplaceAll(format, "{total}", `<span class="totalPages"></span>`)
		pos := l.PageNumbers.Position
		if pos == "" {
			pos = "bottom-center"
		}
		pageNumHTML = fmt.Sprintf(
			`<div style="width:100%%; font-size:10px; color:#555; padding:0 10mm; %s">%s</div>`,
			positionCSS(pos), format,
		)
	}
	if custom == "" && pageNumHTML == "" {
		return ""
	}
	combined := custom + pageNumHTML
	return wrapHF(combined, "")
}

// DisplayHeaderFooter is true when Chromium should render either the header or
// the footer (or the page-number footer).
func (l *Layout) DisplayHeaderFooter() bool {
	if l == nil {
		return false
	}
	return (l.Header.Enabled && l.Header.HTML != "") ||
		(l.Footer.Enabled && l.Footer.HTML != "") ||
		l.PageNumbers.Enabled
}

// WatermarkCSS returns a <style>…</style> block to be injected into the rendered
// document's <head>. Empty string if no watermark.
func (l *Layout) WatermarkCSS() string {
	if l == nil || !l.Watermark.Enabled || l.Watermark.Text == "" {
		return ""
	}
	op := l.Watermark.Opacity
	if op <= 0 {
		op = 0.12
	}
	size := l.Watermark.FontSize
	if size <= 0 {
		size = 120
	}
	angle := l.Watermark.Angle
	if angle == 0 {
		angle = -30
	}
	color := l.Watermark.Color
	if color == "" {
		color = "#000000"
	}
	// Escape the text for use inside a CSS content: "" literal.
	text := strings.ReplaceAll(l.Watermark.Text, `\`, `\\`)
	text = strings.ReplaceAll(text, `"`, `\"`)
	return fmt.Sprintf(`
<style data-formly-watermark>
  body { position: relative; }
  body::before {
    content: "%s";
    position: fixed;
    top: 50%%;
    left: 50%%;
    transform: translate(-50%%, -50%%) rotate(%ddeg);
    font-size: %dpx;
    font-weight: 700;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: %s;
    opacity: %.2f;
    pointer-events: none;
    z-index: 9999;
    white-space: nowrap;
    user-select: none;
  }
</style>`, text, angle, size, color, op)
}

// positionCSS maps logical positions into flexbox alignment for the footer div.
func positionCSS(pos string) string {
	switch pos {
	case "bottom-left", "top-left":
		return "text-align:left;"
	case "bottom-right", "top-right":
		return "text-align:right;"
	default:
		return "text-align:center;"
	}
}

// wrapHF adds an outer font-size declaration so the Chromium header/footer
// templates pick up sensible defaults.
func wrapHF(body, extra string) string {
	return fmt.Sprintf(
		`<div style="font-family:Inter, system-ui, sans-serif; font-size:10px; color:#555; width:100%%; padding:0 10mm; %s">%s</div>`,
		extra, body,
	)
}
