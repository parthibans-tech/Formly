// Package pdfdecor applies post-render decoration to a generated PDF:
// watermarks (diagonal "DRAFT", repeating logos) and headers/footers
// (page numbers, branding strings, generation timestamps).
//
// The package is a thin facade over pdfcpu's stamp/watermark API. We
// own the JSON schema (so the rest of the codebase doesn't have to
// know about pdfcpu's `desc` mini-language) and the placeholder
// resolution rules (so `{{customerName}}` works the same way it does
// in output.filenameTemplate / folderPath).
//
// Order in the render pipeline:
//
//	render → fill fields → pdfdecor.Apply → pdfencrypt.Apply → upload
//
// Decoration MUST happen before encryption — pdfcpu refuses to stamp
// an encrypted PDF, and even if it could, the result would be
// rewritten and the integrator would have to know the password to
// post-process anything downstream.
//
// What lives here:
//
//   - One text watermark (single string, optional page selector,
//     diagonal/centered/corner positioning, opacity/rotation/font/
//     color tunables). Image watermarks are deferred to v2 — the JSON
//     schema reserves the field name so we don't break compatibility
//     when we add it.
//
//   - A header and a footer, each with three slots (left/center/right).
//     Slots are independent — empty slots produce no watermark.
//
//   - Placeholder resolution: `{{key}}` substitutes from the request
//     `data` payload, plus four built-ins:
//
//       {{page}}         current page number (1-indexed)
//       {{pages}}        total page count
//       {{generatedAt}}  RFC3339 timestamp at render time
//       {{date}}         YYYY-MM-DD shorthand for {{generatedAt}}
//
// What's intentionally NOT here:
//
//   - Per-page conditional sections / different headers per page. That
//     belongs at the template-mode layer (HTML / doc) where the source
//     can carry per-page logic. pdfdecor operates on already-rendered
//     bytes — it can't introspect the structure beyond page count.
//
//   - Image watermarks. Adding them means either fetching arbitrary
//     URLs (security review needed) or accepting Drive file IDs
//     (storage.Client wiring). The JSON schema reserves
//     `watermark.imageFileId` so a future PR can fill it in without a
//     breaking change.
package pdfdecor

import (
	"bytes"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	pdfcpuapi "github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
)

// Config is the parsed shape of config_json.decorations. All
// sub-blocks are optional — Apply returns the input bytes unchanged
// when every block is nil/empty.
type Config struct {
	Watermark *Watermark      `json:"watermark,omitempty"`
	Header    *HeaderFooter   `json:"header,omitempty"`
	Footer    *HeaderFooter   `json:"footer,omitempty"`
}

// Watermark describes a single repeating mark applied across the
// selected pages. Text-only for now — see package doc for the image
// roadmap.
type Watermark struct {
	// Text is the literal string to stamp. Supports `{{key}}` from
	// the request data plus the four built-ins documented at the
	// package level. An empty Text means "no watermark" — the entire
	// block is treated as absent.
	Text string `json:"text,omitempty"`

	// FontSize in points. Defaults to 48 — large enough to read on a
	// thumbnail, small enough not to overflow a Letter page when
	// rotated diagonally.
	FontSize int `json:"fontSize,omitempty"`

	// Color is "#RRGGBB" hex. Defaults to a mid-grey (#888888) so the
	// watermark is visible without dominating the page content.
	Color string `json:"color,omitempty"`

	// Opacity 0..1. 0 means invisible, 1 means fully opaque.
	// Defaults to 0.3 — typical for "DRAFT" overlays.
	Opacity float64 `json:"opacity,omitempty"`

	// Rotation in degrees. Ignored when Position == "diagonal" (the
	// diagonal mode computes its own rotation from page geometry).
	Rotation int `json:"rotation,omitempty"`

	// Position controls anchoring. One of:
	//
	//   "diagonal"   stretch from bottom-left to top-right (default
	//                for watermarks; what users mean by "DRAFT")
	//   "center"     centered, no rotation
	//   "top-left"   "top-center"   "top-right"
	//   "left"       "right"
	//   "bottom-left" "bottom-center" "bottom-right"
	//
	// Empty defaults to "diagonal".
	Position string `json:"position,omitempty"`

	// Pages is a pdfcpu page selector: "all" (default), "first",
	// "last", or a comma-separated mix of single pages and ranges
	// ("1,3-5,8"). Invalid selectors are rejected at Apply time so
	// the integrator gets a 400 instead of a silent no-op.
	Pages string `json:"pages,omitempty"`

	// OnTop controls draw order:
	//   true  → stamp (drawn over page content; can obscure text)
	//   false → watermark (drawn under content; visible only where
	//                      the page is otherwise blank)
	// Pointer so we can default to false (watermark mode) without
	// confusing it with "explicitly set to false".
	OnTop *bool `json:"onTop,omitempty"`

	// ImageFileID reserves the slot for v2 image watermarks. Setting
	// it today returns an "image watermarks not yet supported" error
	// rather than being silently ignored — that way integrators
	// using the schema can't accidentally ship a template they think
	// works.
	ImageFileID string `json:"imageFileId,omitempty"`
}

// HeaderFooter describes a top or bottom decoration band with three
// independent slots. Each slot is its own pdfcpu watermark — that's
// how we get left / center / right alignment without manual text
// padding.
type HeaderFooter struct {
	// Left, Center, Right are the three slot strings. Each supports
	// the placeholder grammar described at the package level. Empty
	// strings skip that slot — a header with only a centered title
	// is `{ "center": "{{documentTitle}}" }`.
	Left   string `json:"left,omitempty"`
	Center string `json:"center,omitempty"`
	Right  string `json:"right,omitempty"`

	// FontSize in points. Defaults to 9 — small enough to feel like
	// running headers/footers, large enough to be legible.
	FontSize int `json:"fontSize,omitempty"`

	// Color is "#RRGGBB" hex. Defaults to #666666 (medium grey),
	// matching the convention that header/footer text should sit
	// below the visual weight of the body content.
	Color string `json:"color,omitempty"`

	// Margin in points from the top/bottom edge. Defaults to 18
	// (1/4 inch — the usual margin for printed page numbers).
	Margin int `json:"margin,omitempty"`

	// ShowOnFirstPage controls whether the first page gets the
	// header/footer. Defaults to true. Cover-page workflows
	// typically set this to false on the header.
	ShowOnFirstPage *bool `json:"showOnFirstPage,omitempty"`

	// Pages is a pdfcpu page selector — same grammar as
	// Watermark.Pages. Defaults to "all". When ShowOnFirstPage is
	// false AND Pages is unset, we synthesize "2-".
	Pages string `json:"pages,omitempty"`
}

// IsEnabled reports whether any block carries content worth applying.
// Cheap pre-check so the runner can skip the buffer round-trip on
// the common case (templates without decorations).
func (c Config) IsEnabled() bool {
	if c.Watermark != nil && (c.Watermark.Text != "" || c.Watermark.ImageFileID != "") {
		return true
	}
	if c.Header != nil && c.Header.hasAnyText() {
		return true
	}
	if c.Footer != nil && c.Footer.hasAnyText() {
		return true
	}
	return false
}

func (h HeaderFooter) hasAnyText() bool {
	return h.Left != "" || h.Center != "" || h.Right != ""
}

// Apply runs the decoration pipeline. Returns the input bytes
// unchanged when nothing is configured (cheap no-op). On any pdfcpu
// error the partial output is discarded and the original input is
// preserved in the error message context.
func Apply(pdfBytes []byte, cfg Config, data map[string]interface{}) ([]byte, error) {
	if !cfg.IsEnabled() {
		return pdfBytes, nil
	}
	if len(pdfBytes) == 0 {
		return nil, errors.New("pdfdecor: empty input")
	}

	conf := model.NewDefaultConfiguration()
	conf.ValidationMode = model.ValidationRelaxed

	pageCount, err := pdfcpuapi.PageCount(bytes.NewReader(pdfBytes), conf)
	if err != nil {
		return nil, fmt.Errorf("pdfdecor: count pages: %w", err)
	}

	current := pdfBytes

	// 1) Watermark first so headers/footers render on top of it. We
	// reject image watermarks until v2 wires the storage lookup —
	// silent fallback would hide config bugs.
	if cfg.Watermark != nil {
		if cfg.Watermark.ImageFileID != "" {
			return nil, errors.New("pdfdecor: image watermarks (imageFileId) are not yet supported")
		}
		if strings.TrimSpace(cfg.Watermark.Text) != "" {
			next, err := applyTextWatermark(current, *cfg.Watermark, data, pageCount, conf)
			if err != nil {
				return nil, fmt.Errorf("pdfdecor: watermark: %w", err)
			}
			current = next
		}
	}

	// 2) Header & footer. Each region with text becomes 1–3 pdfcpu
	// stamp invocations (one per non-empty slot). Per-page rendering
	// is triggered automatically when the slot text references
	// `{{page}}` or `{{pages}}`.
	if cfg.Header != nil && cfg.Header.hasAnyText() {
		next, err := applyHeaderFooter(current, *cfg.Header, "header", data, pageCount, conf)
		if err != nil {
			return nil, fmt.Errorf("pdfdecor: header: %w", err)
		}
		current = next
	}
	if cfg.Footer != nil && cfg.Footer.hasAnyText() {
		next, err := applyHeaderFooter(current, *cfg.Footer, "footer", data, pageCount, conf)
		if err != nil {
			return nil, fmt.Errorf("pdfdecor: footer: %w", err)
		}
		current = next
	}

	return current, nil
}

// applyTextWatermark resolves placeholders that don't depend on page
// number, builds a pdfcpu Watermark struct, and stamps once across
// the selected pages. Page-dependent text (`{{page}}` / `{{pages}}`)
// in a watermark would force per-page stamping, which is overkill
// for the "DRAFT" use case — for that, use a footer slot instead.
func applyTextWatermark(pdfBytes []byte, w Watermark, data map[string]interface{}, pageCount int, conf *model.Configuration) ([]byte, error) {
	// Watermarks intentionally evaluate {{page}} / {{pages}} as if
	// they were on page 1. Per-page text belongs in headers/footers.
	text := resolvePlaceholders(w.Text, data, 1, pageCount)

	desc := buildWatermarkDesc(w)
	wm, err := pdfcpuapi.TextWatermark(text, desc, valueOrDefault(w.OnTop, false), false, types.POINTS)
	if err != nil {
		return nil, fmt.Errorf("text watermark: %w", err)
	}

	pages, err := normalizePageSelector(w.Pages, pageCount)
	if err != nil {
		return nil, err
	}

	var out bytes.Buffer
	if err := pdfcpuapi.AddWatermarks(bytes.NewReader(pdfBytes), &out, pages, wm, conf); err != nil {
		return nil, fmt.Errorf("apply watermark: %w", err)
	}
	return out.Bytes(), nil
}

// applyHeaderFooter stamps each non-empty slot of a header or footer
// region. Slots that reference `{{page}}` or `{{pages}}` get one
// stamp per page; static slots get one stamp covering all selected
// pages (much faster).
func applyHeaderFooter(pdfBytes []byte, hf HeaderFooter, region string, data map[string]interface{}, pageCount int, conf *model.Configuration) ([]byte, error) {
	slots := []struct {
		text     string
		position string // pdfcpu anchor abbrev
	}{
		{hf.Left, regionAnchor(region, "left")},
		{hf.Center, regionAnchor(region, "center")},
		{hf.Right, regionAnchor(region, "right")},
	}

	pages, err := resolveHeaderFooterPages(hf, pageCount)
	if err != nil {
		return nil, err
	}

	current := pdfBytes
	for _, s := range slots {
		if strings.TrimSpace(s.text) == "" {
			continue
		}
		next, err := stampSlot(current, s.text, s.position, hf, data, pages, pageCount, conf)
		if err != nil {
			return nil, err
		}
		current = next
	}
	return current, nil
}

// stampSlot is the inner loop for header/footer slots. When the text
// is page-dependent, we walk the page list and stamp one watermark
// per page with the per-page resolved text. Otherwise a single stamp
// covers everything.
func stampSlot(pdfBytes []byte, text, position string, hf HeaderFooter, data map[string]interface{}, pages []string, pageCount int, conf *model.Configuration) ([]byte, error) {
	if !hasPagePlaceholder(text) {
		// Static slot — one stamp.
		desc := buildHeaderFooterDesc(hf, position)
		resolved := resolvePlaceholders(text, data, 1, pageCount)
		wm, err := pdfcpuapi.TextWatermark(resolved, desc, true, false, types.POINTS)
		if err != nil {
			return nil, fmt.Errorf("slot watermark: %w", err)
		}
		var out bytes.Buffer
		if err := pdfcpuapi.AddWatermarks(bytes.NewReader(pdfBytes), &out, pages, wm, conf); err != nil {
			return nil, fmt.Errorf("apply slot: %w", err)
		}
		return out.Bytes(), nil
	}

	// Page-dependent slot — one stamp per page in the selector.
	desc := buildHeaderFooterDesc(hf, position)
	current := pdfBytes
	pageNums, err := expandPageSelector(pages, pageCount)
	if err != nil {
		return nil, err
	}
	for _, pn := range pageNums {
		resolved := resolvePlaceholders(text, data, pn, pageCount)
		wm, err := pdfcpuapi.TextWatermark(resolved, desc, true, false, types.POINTS)
		if err != nil {
			return nil, fmt.Errorf("slot watermark p%d: %w", pn, err)
		}
		var out bytes.Buffer
		if err := pdfcpuapi.AddWatermarks(bytes.NewReader(current), &out, []string{strconv.Itoa(pn)}, wm, conf); err != nil {
			return nil, fmt.Errorf("apply slot p%d: %w", pn, err)
		}
		current = out.Bytes()
	}
	return current, nil
}

// resolveHeaderFooterPages translates ShowOnFirstPage + Pages into a
// pdfcpu selector list. The two interact in the obvious way: explicit
// Pages always wins; ShowOnFirstPage:false with no Pages becomes "2-".
func resolveHeaderFooterPages(hf HeaderFooter, pageCount int) ([]string, error) {
	if strings.TrimSpace(hf.Pages) != "" {
		return normalizePageSelector(hf.Pages, pageCount)
	}
	if hf.ShowOnFirstPage != nil && !*hf.ShowOnFirstPage && pageCount > 1 {
		return []string{"2-"}, nil
	}
	return nil, nil // nil → all pages
}

// buildWatermarkDesc serializes a Watermark struct into the
// comma-separated parameter string pdfcpu's TextWatermark wants. The
// shape matches pdfcpu's documented mini-language; defaults are
// applied here so the schema can keep zero-values meaningful.
func buildWatermarkDesc(w Watermark) string {
	parts := []string{
		"font:Helvetica",
		fmt.Sprintf("points:%d", intOrDefault(w.FontSize, 48)),
		fmt.Sprintf("opacity:%.2f", floatOrDefault(w.Opacity, 0.3)),
		fmt.Sprintf("color:%s", hexToPDFColor(w.Color, "#888888")),
	}

	switch strings.ToLower(strings.TrimSpace(w.Position)) {
	case "", "diagonal":
		// pdfcpu's "diagonal:1" stretches a single repetition from
		// bottom-left to top-right at the right rotation for the page
		// — exactly what users mean by a "DRAFT" overlay.
		parts = append(parts, "diagonal:1")
	default:
		parts = append(parts, fmt.Sprintf("position:%s", positionAbbrev(w.Position)))
		if w.Rotation != 0 {
			parts = append(parts, fmt.Sprintf("rot:%d", w.Rotation))
		}
		// Non-diagonal positions get a relative scale so a 48pt
		// watermark doesn't overflow when anchored to a corner.
		parts = append(parts, "scale:0.5 rel")
	}

	return strings.Join(parts, ", ")
}

// buildHeaderFooterDesc is the slot equivalent: smaller font, no
// rotation, anchored to the requested corner with a vertical offset
// that pulls the text in from the page edge by `Margin` points.
func buildHeaderFooterDesc(hf HeaderFooter, position string) string {
	margin := intOrDefault(hf.Margin, 18)
	// Headers offset downward from the top edge (negative dy in
	// pdfcpu's bottom-up coordinate system, but the dy sign for top
	// anchors is "into the page"); footers offset upward from the
	// bottom edge. pdfcpu treats positive dy as moving away from the
	// anchored edge for both top* and bottom* anchors, so the same
	// positive value works for both bands.
	parts := []string{
		"font:Helvetica",
		fmt.Sprintf("points:%d", intOrDefault(hf.FontSize, 9)),
		fmt.Sprintf("color:%s", hexToPDFColor(hf.Color, "#666666")),
		fmt.Sprintf("position:%s", position),
		fmt.Sprintf("offset:0 %d", margin),
		"scale:1 abs",
		"rot:0",
		"opacity:1",
	}
	return strings.Join(parts, ", ")
}

// regionAnchor maps a (region, alignment) pair to pdfcpu's anchor
// abbreviation. We accept "header"/"footer" as region names because
// that's how the JSON schema names them; pdfcpu's terminology is
// "top"/"bottom" anchors.
func regionAnchor(region, align string) string {
	prefix := ""
	switch region {
	case "header":
		prefix = "t"
	case "footer":
		prefix = "b"
	}
	switch align {
	case "left":
		return prefix + "l"
	case "right":
		return prefix + "r"
	default:
		return prefix + "c"
	}
}

// positionAbbrev maps the JSON schema's spelled-out position values
// to pdfcpu's compact anchor codes. Anything we don't recognise
// falls through to "c" (center) — safer than crashing the render.
func positionAbbrev(p string) string {
	switch strings.ToLower(strings.TrimSpace(p)) {
	case "top-left":
		return "tl"
	case "top-center", "top":
		return "tc"
	case "top-right":
		return "tr"
	case "left":
		return "l"
	case "right":
		return "r"
	case "bottom-left":
		return "bl"
	case "bottom-center", "bottom":
		return "bc"
	case "bottom-right":
		return "br"
	default:
		return "c"
	}
}

// hexToPDFColor turns "#RRGGBB" into pdfcpu's "r g b" floats. Bad or
// empty input falls back to the supplied default — colour parsing is
// the kind of thing where a typo silently producing white text on
// white pages is worse than rendering grey.
func hexToPDFColor(hex, fallback string) string {
	clean := strings.TrimPrefix(strings.TrimSpace(hex), "#")
	if len(clean) != 6 {
		clean = strings.TrimPrefix(fallback, "#")
	}
	r, errR := strconv.ParseInt(clean[0:2], 16, 0)
	g, errG := strconv.ParseInt(clean[2:4], 16, 0)
	b, errB := strconv.ParseInt(clean[4:6], 16, 0)
	if errR != nil || errG != nil || errB != nil {
		clean = strings.TrimPrefix(fallback, "#")
		r, _ = strconv.ParseInt(clean[0:2], 16, 0)
		g, _ = strconv.ParseInt(clean[2:4], 16, 0)
		b, _ = strconv.ParseInt(clean[4:6], 16, 0)
	}
	return fmt.Sprintf("%.3f %.3f %.3f", float64(r)/255, float64(g)/255, float64(b)/255)
}

// placeholderRe matches `{{key}}` with optional surrounding
// whitespace, capturing just the key. Same shape as the one used by
// pathtpl so users get a single mental model across the product.
var placeholderRe = regexp.MustCompile(`\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}`)

// resolvePlaceholders substitutes `{{key}}` against the request data
// plus the four built-ins (page, pages, generatedAt, date). Missing
// keys collapse to empty strings — same rule as pathtpl, which is
// what users already expect from output.filenameTemplate.
func resolvePlaceholders(s string, data map[string]interface{}, page, pageCount int) string {
	if !strings.Contains(s, "{{") {
		return s
	}
	now := time.Now().UTC()
	return placeholderRe.ReplaceAllStringFunc(s, func(match string) string {
		m := placeholderRe.FindStringSubmatch(match)
		if len(m) < 2 {
			return ""
		}
		key := m[1]
		switch key {
		case "page":
			return strconv.Itoa(page)
		case "pages":
			return strconv.Itoa(pageCount)
		case "generatedAt":
			return now.Format(time.RFC3339)
		case "date":
			return now.Format("2006-01-02")
		}
		if v, ok := data[key]; ok {
			return fmt.Sprintf("%v", v)
		}
		return ""
	})
}

// hasPagePlaceholder is the cheap check that decides whether a slot
// needs per-page rendering or can be stamped once for everything.
// Conservative on purpose — false positives just mean we do extra
// work, false negatives produce visibly wrong output.
func hasPagePlaceholder(s string) bool {
	return strings.Contains(s, "{{page}}") ||
		strings.Contains(s, "{{ page }}") ||
		strings.Contains(s, "{{pages}}") ||
		strings.Contains(s, "{{ pages }}")
}

// normalizePageSelector accepts a friendly string ("all", "first",
// "last", "1-3,5") and returns the pdfcpu page selector slice.
// "all" returns nil (pdfcpu's convention for "every page").
func normalizePageSelector(sel string, pageCount int) ([]string, error) {
	s := strings.TrimSpace(strings.ToLower(sel))
	switch s {
	case "", "all":
		return nil, nil
	case "first":
		return []string{"1"}, nil
	case "last":
		return []string{strconv.Itoa(pageCount)}, nil
	}
	// Otherwise treat it as a comma-separated pdfcpu selector. We
	// don't validate the grammar in depth — pdfcpu rejects malformed
	// selectors at AddWatermarks time with a clear error.
	parts := strings.Split(sel, ",")
	for i, p := range parts {
		parts[i] = strings.TrimSpace(p)
	}
	return parts, nil
}

// expandPageSelector turns the pdfcpu selector slice into an
// explicit list of page numbers. Used when a slot needs per-page
// rendering — pdfcpu's AddWatermarks selector can target a range,
// but the watermark text is the same for every selected page, so we
// have to drive the loop ourselves.
func expandPageSelector(sel []string, pageCount int) ([]int, error) {
	if len(sel) == 0 {
		out := make([]int, pageCount)
		for i := range out {
			out[i] = i + 1
		}
		return out, nil
	}
	seen := make(map[int]bool, pageCount)
	var out []int
	for _, raw := range sel {
		s := strings.TrimSpace(raw)
		if s == "" {
			continue
		}
		// Range "a-b" or "a-" (open-ended to last page).
		if strings.Contains(s, "-") {
			ab := strings.SplitN(s, "-", 2)
			startStr, endStr := strings.TrimSpace(ab[0]), strings.TrimSpace(ab[1])
			start, err := strconv.Atoi(startStr)
			if err != nil {
				return nil, fmt.Errorf("invalid page range %q", s)
			}
			end := pageCount
			if endStr != "" {
				end, err = strconv.Atoi(endStr)
				if err != nil {
					return nil, fmt.Errorf("invalid page range %q", s)
				}
			}
			if start < 1 {
				start = 1
			}
			if end > pageCount {
				end = pageCount
			}
			for p := start; p <= end; p++ {
				if !seen[p] {
					seen[p] = true
					out = append(out, p)
				}
			}
			continue
		}
		p, err := strconv.Atoi(s)
		if err != nil {
			return nil, fmt.Errorf("invalid page %q", s)
		}
		if p >= 1 && p <= pageCount && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out, nil
}

// intOrDefault and friends keep the desc-builder helpers terse.
func intOrDefault(v, def int) int {
	if v <= 0 {
		return def
	}
	return v
}

func floatOrDefault(v, def float64) float64 {
	if v <= 0 {
		return def
	}
	return v
}

func valueOrDefault[T any](p *T, def T) T {
	if p == nil {
		return def
	}
	return *p
}
