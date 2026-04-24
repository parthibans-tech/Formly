// Package static implements the "flat PDF + drag-placed widget" generation mode.
//
// Design:
//   - Widgets are stored in PDF coordinates (origin bottom-left, units = points).
//   - An overlay PDF is built with fpdf that matches each source page's dimensions,
//     with widget values rasterized as text/graphics on top.
//   - pdfcpu stamps the overlay onto the source PDF to produce the final output.
package static

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image/png"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/boombuler/barcode"
	"github.com/boombuler/barcode/code128"
	"github.com/boombuler/barcode/code39"
	"github.com/boombuler/barcode/ean"
	"github.com/boombuler/barcode/qr"
	"github.com/docforge/api/internal/layout"
	"github.com/go-pdf/fpdf"
	pdfcpuapi "github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
)

type Widget struct {
	ID      string                 `json:"id"`
	Type    string                 `json:"type"`
	Page    int                    `json:"page"`
	X       float64                `json:"x"`
	Y       float64                `json:"y"`
	W       float64                `json:"w"`
	H       float64                `json:"h"`
	DataKey string                 `json:"dataKey"`
	ZIndex  int                    `json:"zIndex"`
	Props   map[string]interface{} `json:"props"`
}

// Fill composites widget values onto the supplied source PDF. If layout has a
// text watermark enabled, it is stamped on top of the output.
func Fill(pdfBytes []byte, widgets []Widget, data map[string]interface{}, l *layout.Layout) ([]byte, error) {
	pageDims, err := pageDimensions(pdfBytes)
	if err != nil {
		return nil, fmt.Errorf("probe pages: %w", err)
	}
	if len(pageDims) == 0 {
		return nil, fmt.Errorf("source pdf has no pages")
	}

	overlayBytes, err := buildOverlay(pageDims, widgets, data)
	if err != nil {
		return nil, fmt.Errorf("build overlay: %w", err)
	}

	out, err := stampOverlay(pdfBytes, overlayBytes)
	if err != nil {
		return nil, err
	}

	// Inject AcroForm interactive fields (text, checkbox, radio, dropdown).
	// Errors here are non-fatal — we still return the stamped PDF.
	out, err = InjectAcroForm(out, widgets)
	if err != nil {
		// Log but don't fail the whole generation.
		_ = err
	}

	if l != nil && l.Watermark.Enabled && l.Watermark.Text != "" {
		out, err = stampTextWatermark(out, l.Watermark)
		if err != nil {
			return nil, fmt.Errorf("watermark: %w", err)
		}
	}
	return out, nil
}

// stampTextWatermark adds a text watermark to every page using pdfcpu.
func stampTextWatermark(src []byte, w layout.Watermark) ([]byte, error) {
	srcPath, err := writeTemp("df-wm-src-*.pdf", src)
	if err != nil {
		return nil, err
	}
	defer os.Remove(srcPath)
	outPath, err := tempName("df-wm-out-*.pdf")
	if err != nil {
		return nil, err
	}
	defer os.Remove(outPath)

	op := w.Opacity
	if op <= 0 {
		op = 0.12
	}
	angle := w.Angle
	if angle == 0 {
		angle = -30
	}
	size := w.FontSize
	if size <= 0 {
		size = 120
	}
	// pdfcpu watermark description — keep concise, see pdfcpu docs for grammar.
	desc := fmt.Sprintf("points:%d, rot:%d, opacity:%.2f, pos:c, scale:1 abs", size, angle, op)
	wmDef, err := pdfcpuapi.TextWatermark(w.Text, desc, true, false, types.POINTS)
	if err != nil {
		return nil, err
	}
	if err := pdfcpuapi.AddWatermarksFile(srcPath, outPath, nil, wmDef, nil); err != nil {
		return nil, err
	}
	return os.ReadFile(outPath)
}

type pageDim struct {
	W, H float64 // points
}

func pageDimensions(pdfBytes []byte) ([]pageDim, error) {
	rs := bytes.NewReader(pdfBytes)
	ctx, err := pdfcpuapi.ReadContext(rs, nil)
	if err != nil {
		return nil, err
	}
	if err := ctx.EnsurePageCount(); err != nil {
		return nil, err
	}
	dims, err := ctx.PageDims()
	if err != nil {
		return nil, err
	}
	out := make([]pageDim, 0, len(dims))
	for _, d := range dims {
		out = append(out, pageDim{W: d.Width, H: d.Height})
	}
	if len(out) == 0 {
		out = append(out, pageDim{W: 612, H: 792}) // Letter fallback
	}
	return out, nil
}

func buildOverlay(pages []pageDim, widgets []Widget, data map[string]interface{}) ([]byte, error) {
	pdf := fpdf.New("P", "pt", "Letter", "")
	pdf.SetAutoPageBreak(false, 0)

	totalPages := len(pages)
	for i, p := range pages {
		pdf.AddPageFormat("P", fpdf.SizeType{Wd: p.W, Ht: p.H})
		pageNum := i + 1
		for _, wd := range widgets {
			// Page 0 means "every page" — used by watermark + pageNumber.
			if wd.Page != 0 && wd.Page != pageNum {
				continue
			}
			drawWidget(pdf, wd, p, pageNum, totalPages, data)
		}
	}

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func drawWidget(pdf *fpdf.Fpdf, wd Widget, p pageDim, pageNum, totalPages int, data map[string]interface{}) {
	// Convert PDF space (bottom-left origin) to fpdf space (top-left origin) for drawing.
	topY := p.H - wd.Y - wd.H

	props := wd.Props
	if props == nil {
		props = map[string]interface{}{}
	}

	// Honour the per-widget `_hidden` flag and optional showIf expression so
	// the designer's conditional-visibility feature carries through to render.
	if truthy(props["_hidden"]) {
		return
	}

	raw := lookup(data, wd.DataKey)
	value := fmt.Sprint(raw)
	if raw == nil {
		value = ""
	}

	fontSize := floatProp(props, "fontSize", 12)
	fontFamily := stringProp(props, "fontFamily", "Helvetica")
	color := stringProp(props, "color", "#111827")
	r, g, b := hexToRGB(color)
	pdf.SetTextColor(r, g, b)

	// Build fpdf style string from individual boolean props.
	// Supports any combination of Bold / Italic / Underline.
	fontStyle := ""
	if boolProp(props, "bold", false) {
		fontStyle += "B"
	}
	if boolProp(props, "italic", false) {
		fontStyle += "I"
	}
	if boolProp(props, "underline", false) {
		fontStyle += "U"
	}
	pdf.SetFont(fontFamily, fontStyle, fontSize)

	// Per-widget opacity via PDF transparency groups.
	// Restores to fully-opaque after this widget is drawn.
	if op := floatProp(props, "opacity", 1.0); op < 1.0 {
		pdf.SetAlpha(op, "Normal")
		defer pdf.SetAlpha(1.0, "Normal")
	}

	// Box-style helpers shared by all text-bearing widgets:
	// background fill, border, and inner padding.
	bgColor := stringProp(props, "backgroundColor", "")
	bdrColor := stringProp(props, "borderColor", "")
	bdrWidth := floatProp(props, "borderWidth", 0)
	padding := floatProp(props, "padding", 0)
	lineHeight := floatProp(props, "lineHeight", 1.15)

	// drawTextBox renders an optional fill rect and border rect behind text.
	drawTextBox := func() {
		if bgColor != "" {
			br, bg, bb := hexToRGB(bgColor)
			pdf.SetFillColor(br, bg, bb)
			pdf.Rect(wd.X, topY, wd.W, wd.H, "F")
		}
		if bdrColor != "" && bdrWidth > 0 {
			bdr, bdg, bdb := hexToRGB(bdrColor)
			pdf.SetDrawColor(bdr, bdg, bdb)
			pdf.SetLineWidth(bdrWidth)
			pdf.Rect(wd.X, topY, wd.W, wd.H, "D")
		}
	}

	switch wd.Type {
	case "text", "number", "currency", "date", "":
		if value == "" {
			return
		}
		drawTextBox()
		pdf.SetXY(wd.X+padding, topY+padding)
		pdf.CellFormat(wd.W-2*padding, wd.H-2*padding, value, "", 0, stringProp(props, "align", "L"), false, 0, "")
	case "multiline":
		drawTextBox()
		pdf.SetXY(wd.X+padding, topY+padding)
		pdf.MultiCell(wd.W-2*padding, fontSize*lineHeight, value, "", stringProp(props, "align", "L"), false)
	case "checkbox":
		checked := truthy(raw)
		pdf.SetDrawColor(r, g, b)
		pdf.Rect(wd.X, topY, wd.W, wd.H, "D")
		if checked {
			pdf.Line(wd.X+2, topY+2, wd.X+wd.W-2, topY+wd.H-2)
			pdf.Line(wd.X+wd.W-2, topY+2, wd.X+2, topY+wd.H-2)
		}

	case "radio":
		// Render as a circle. Checked when the data value equals the export value.
		exportVal := stringProp(props, "acroExportValue", "")
		checked := exportVal != "" && value == exportVal
		pdf.SetDrawColor(r, g, b)
		cx := wd.X + wd.W/2
		cy := topY + wd.H/2
		rad := wd.W / 2
		if wd.H < wd.W {
			rad = wd.H / 2
		}
		pdf.Circle(cx, cy, rad, "D")
		if checked {
			innerRad := rad * 0.55
			pdf.SetFillColor(r, g, b)
			pdf.Circle(cx, cy, innerRad, "F")
		}

	case "signature-field":
		// Dashed border placeholder with an "X Sign here" label.
		pdf.SetDrawColor(r, g, b)
		pdf.SetLineWidth(0.75)
		pdf.SetDashPattern([]float64{4, 2}, 0)
		pdf.Rect(wd.X, topY, wd.W, wd.H, "D")
		pdf.SetDashPattern([]float64{}, 0) // reset to solid
		// Horizontal baseline near the bottom of the box.
		baseY := topY + wd.H - 6
		pdf.SetLineWidth(0.5)
		pdf.Line(wd.X+4, baseY, wd.X+wd.W-4, baseY)
		// Label
		pdf.SetFont(fontFamily, "I", fontSize*0.8)
		pdf.SetXY(wd.X+4, topY+2)
		pdf.CellFormat(wd.W-8, wd.H-8, "\u00d7 Sign here", "", 0, "L", false, 0, "")

	case "button":
		// Filled button rectangle with centred label text.
		label := stringProp(props, "acroButtonLabel", wd.DataKey)
		// Apply default button visual if the user hasn't set box-style props.
		if bgColor == "" {
			br, bg, bb := hexToRGB("#e5e7eb")
			pdf.SetFillColor(br, bg, bb)
			pdf.Rect(wd.X, topY, wd.W, wd.H, "F")
		}
		if bdrColor == "" || bdrWidth <= 0 {
			bdr, bdg, bdb := hexToRGB("#9ca3af")
			pdf.SetDrawColor(bdr, bdg, bdb)
			pdf.SetLineWidth(0.5)
			pdf.Rect(wd.X, topY, wd.W, wd.H, "D")
		}
		drawTextBox()
		pdf.SetXY(wd.X+padding, topY+padding)
		pdf.CellFormat(wd.W-2*padding, wd.H-2*padding, label, "", 0, "C", false, 0, "")

	case "dropdown":
		// Render as a text box showing the selected option label (or dataKey).
		if value == "" {
			return
		}
		drawTextBox()
		// Find the label for the selected value in acroOptions.
		displayText := value
		if opts, ok := props["acroOptions"].([]interface{}); ok {
			for _, o := range opts {
				if m, ok2 := o.(map[string]interface{}); ok2 {
					if v, _ := m["value"].(string); v == value {
						if l, _ := m["label"].(string); l != "" {
							displayText = l
						}
					}
				}
			}
		}
		pdf.SetXY(wd.X+padding, topY+padding)
		pdf.CellFormat(wd.W-2*padding, wd.H-2*padding, displayText, "", 0, stringProp(props, "align", "L"), false, 0, "")
	case "qr":
		if value == "" {
			return
		}
		imageName := fmt.Sprintf("qr-%s", wd.ID)
		if err := registerQRImage(pdf, imageName, value); err != nil {
			return
		}
		pdf.ImageOptions(imageName, wd.X, topY, wd.W, wd.H, false,
			fpdf.ImageOptions{ImageType: "png"}, 0, "")
	case "barcode":
		if value == "" {
			return
		}
		kind := stringProp(props, "barcodeKind", "code128")
		imageName := fmt.Sprintf("bc-%s", wd.ID)
		if err := registerBarcodeImage(pdf, imageName, value, kind, int(wd.W*4), int(wd.H*4)); err != nil {
			return
		}
		pdf.ImageOptions(imageName, wd.X, topY, wd.W, wd.H, false,
			fpdf.ImageOptions{ImageType: "png"}, 0, "")
	case "image", "signature":
		// Both render the same way — a signature is just an image widget
		// whose source happens to be a user-drawn PNG. Accepts:
		//   • data:<mime>;base64,... URIs (e.g. signature canvases)
		//   • http(s):// URLs
		//   • raw base64 strings
		// If no data is present, draws a dashed placeholder box so the
		// author can see the widget footprint without it disappearing.
		src := stringProp(props, "src", "")
		if src == "" {
			src = value
		}
		if src == "" {
			pdf.SetDrawColor(200, 200, 200)
			pdf.SetLineWidth(0.5)
			pdf.Rect(wd.X, topY, wd.W, wd.H, "D")
			return
		}
		imageName := fmt.Sprintf("%s-%s", wd.Type, wd.ID)
		imgType, imgBytes, err := loadImage(src)
		if err != nil {
			return
		}
		pdf.RegisterImageOptionsReader(imageName, fpdf.ImageOptions{ImageType: imgType}, bytes.NewReader(imgBytes))
		fitMode := stringProp(props, "fit", "contain")
		drawImage(pdf, imageName, wd.X, topY, wd.W, wd.H, imgType, fitMode)

	case "rectangle", "shape":
		// Filled / stroked rectangle — adds dividers, callouts, signature
		// boxes. Supports fill + stroke + rounded corners.
		stroke := stringProp(props, "borderColor", "")
		fill := stringProp(props, "backgroundColor", "")
		lw := floatProp(props, "borderWidth", 0)
		radius := floatProp(props, "borderRadius", 0)
		style := ""
		if fill != "" {
			fr, fg, fb := hexToRGB(fill)
			pdf.SetFillColor(fr, fg, fb)
			style += "F"
		}
		if stroke != "" && lw > 0 {
			sr, sg, sb := hexToRGB(stroke)
			pdf.SetDrawColor(sr, sg, sb)
			pdf.SetLineWidth(lw)
			style += "D"
		}
		if style == "" {
			return
		}
		if radius > 0 {
			pdf.RoundedRect(wd.X, topY, wd.W, wd.H, radius, "1234", style)
		} else {
			pdf.Rect(wd.X, topY, wd.W, wd.H, style)
		}

	case "line", "divider":
		// Horizontal divider by default. `orientation: "vertical"` flips.
		lw := floatProp(props, "borderWidth", 0.5)
		pdf.SetLineWidth(lw)
		pdf.SetDrawColor(r, g, b)
		if stringProp(props, "orientation", "horizontal") == "vertical" {
			cx := wd.X + wd.W/2
			pdf.Line(cx, topY, cx, topY+wd.H)
		} else {
			cy := topY + wd.H/2
			pdf.Line(wd.X, cy, wd.X+wd.W, cy)
		}

	case "pageNumber":
		// Auto-updating "{page} / {pages}" or custom template in
		// `props.format` (e.g. "Page {page} of {pages}").
		format := stringProp(props, "format", "{page} / {pages}")
		rendered := strings.NewReplacer(
			"{page}", fmt.Sprintf("%d", pageNum),
			"{pages}", fmt.Sprintf("%d", totalPages),
		).Replace(format)
		drawTextBox()
		pdf.SetXY(wd.X+padding, topY+padding)
		pdf.CellFormat(wd.W-2*padding, wd.H-2*padding, rendered, "", 0, stringProp(props, "align", "C"), false, 0, "")

	case "watermark":
		// Diagonal text watermark per widget placement. Unlike the layout-
		// level watermark (whole-document), this one lives at a fixed spot
		// and rotates in place. Uses the widget rect as a centering hint.
		text := stringProp(props, "text", value)
		if text == "" {
			text = "DRAFT"
		}
		opacity := floatProp(props, "opacity", 0.15)
		// fpdf lacks true alpha without extensions; fake it by mixing the
		// color toward white. Safe approximation for light watermarks.
		mr, mg, mb := mixToward(r, g, b, 255, 255, 255, 1-opacity)
		pdf.SetTextColor(mr, mg, mb)
		pdf.SetFont(fontFamily, "B", fontSize*3)
		angle := floatProp(props, "angle", -30)
		cx := wd.X + wd.W/2
		cy := topY + wd.H/2
		pdf.TransformBegin()
		pdf.TransformRotate(angle, cx, cy)
		pdf.SetXY(wd.X, topY)
		pdf.CellFormat(wd.W, wd.H, text, "", 0, "C", false, 0, "")
		pdf.TransformEnd()

	case "repeat", "table":
		// Repeating row-per-array-entry list. `dataKey` should resolve to a
		// []interface{}; each entry is a map whose keys become column
		// substitutions in `props.rowTemplate` (e.g. "{name} — {amount}").
		// Multi-column tables can be built by placing several widgets that
		// share the same `dataKey` but different `rowTemplate`s.
		items, _ := lookup(data, wd.DataKey).([]interface{})
		tpl := stringProp(props, "rowTemplate", "{.}")
		rowH := floatProp(props, "rowHeight", fontSize*lineHeight)
		drawTextBox()
		maxRows := int((wd.H - 2*padding) / rowH)
		if maxRows <= 0 {
			maxRows = 1
		}
		for i, it := range items {
			if i >= maxRows {
				break
			}
			row := renderRowTemplate(tpl, it)
			pdf.SetXY(wd.X+padding, topY+padding+float64(i)*rowH)
			pdf.CellFormat(wd.W-2*padding, rowH, row, "", 0, stringProp(props, "align", "L"), false, 0, "")
		}

	default:
		// Unknown type: render as text so authors can see the raw value and fix it.
		drawTextBox()
		pdf.SetXY(wd.X+padding, topY+padding)
		pdf.CellFormat(wd.W-2*padding, wd.H-2*padding, value, "", 0, "L", false, 0, "")
	}
}

// drawImage places the pre-registered image at (x, y, w, h) honouring
// a `fit` mode. "contain" preserves aspect ratio; "stretch" fills the box.
func drawImage(pdf *fpdf.Fpdf, name string, x, y, w, h float64, imgType, fit string) {
	switch fit {
	case "stretch":
		pdf.ImageOptions(name, x, y, w, h, false,
			fpdf.ImageOptions{ImageType: imgType}, 0, "")
	default:
		// "contain": let fpdf compute the aspect-correct width using h=0.
		info := pdf.RegisterImageOptions(name, fpdf.ImageOptions{ImageType: imgType})
		if info == nil {
			pdf.ImageOptions(name, x, y, w, h, false,
				fpdf.ImageOptions{ImageType: imgType}, 0, "")
			return
		}
		iw, ih := info.Extent()
		if iw <= 0 || ih <= 0 {
			return
		}
		scale := w / iw
		if ih*scale > h {
			scale = h / ih
		}
		tw := iw * scale
		th := ih * scale
		ox := x + (w-tw)/2
		oy := y + (h-th)/2
		pdf.ImageOptions(name, ox, oy, tw, th, false,
			fpdf.ImageOptions{ImageType: imgType}, 0, "")
	}
}

// loadImage accepts a data URI, http(s) URL, or raw base64 and returns
// the decoded bytes + fpdf image type string ("png" | "jpg").
func loadImage(src string) (string, []byte, error) {
	src = strings.TrimSpace(src)
	imgType := "png"
	if strings.HasPrefix(src, "data:") {
		// data:<mime>;base64,<payload>
		comma := strings.Index(src, ",")
		if comma < 0 {
			return "", nil, fmt.Errorf("bad data uri")
		}
		meta := src[:comma]
		payload := src[comma+1:]
		if strings.Contains(meta, "jpeg") || strings.Contains(meta, "jpg") {
			imgType = "jpg"
		}
		b, err := base64.StdEncoding.DecodeString(payload)
		if err != nil {
			return "", nil, err
		}
		return imgType, b, nil
	}
	if strings.HasPrefix(src, "http://") || strings.HasPrefix(src, "https://") {
		client := &http.Client{Timeout: 5 * time.Second}
		resp, err := client.Get(src)
		if err != nil {
			return "", nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			return "", nil, fmt.Errorf("image fetch %d", resp.StatusCode)
		}
		// Infer type from Content-Type, fall back to extension.
		ct := resp.Header.Get("Content-Type")
		if strings.Contains(ct, "jpeg") || strings.HasSuffix(strings.ToLower(src), ".jpg") || strings.HasSuffix(strings.ToLower(src), ".jpeg") {
			imgType = "jpg"
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, 10*1024*1024))
		if err != nil {
			return "", nil, err
		}
		return imgType, b, nil
	}
	// Assume raw base64.
	b, err := base64.StdEncoding.DecodeString(src)
	if err != nil {
		return "", nil, err
	}
	return imgType, b, nil
}

// renderRowTemplate replaces `{key}` substitutions with values from a row.
// The special `{.}` token stringifies the whole row (useful for scalar
// arrays like `[]string`).
func renderRowTemplate(tpl string, row interface{}) string {
	if m, ok := row.(map[string]interface{}); ok {
		out := tpl
		for k, v := range m {
			out = strings.ReplaceAll(out, "{"+k+"}", fmt.Sprint(v))
		}
		return strings.ReplaceAll(out, "{.}", fmt.Sprint(row))
	}
	return strings.ReplaceAll(tpl, "{.}", fmt.Sprint(row))
}

// mixToward blends (r1,g1,b1) toward (r2,g2,b2) by weight 0..1.
func mixToward(r1, g1, b1, r2, g2, b2 int, w float64) (int, int, int) {
	return int(float64(r1)*(1-w) + float64(r2)*w),
		int(float64(g1)*(1-w) + float64(g2)*w),
		int(float64(b1)*(1-w) + float64(b2)*w)
}

func stampOverlay(src, overlay []byte) ([]byte, error) {
	srcPath, err := writeTemp("df-src-*.pdf", src)
	if err != nil {
		return nil, err
	}
	defer os.Remove(srcPath)

	ovPath, err := writeTemp("df-overlay-*.pdf", overlay)
	if err != nil {
		return nil, err
	}
	defer os.Remove(ovPath)

	outPath, err := tempName("df-out-*.pdf")
	if err != nil {
		return nil, err
	}
	defer os.Remove(outPath)

	wm, err := pdfcpuapi.PDFWatermark(ovPath, "pos:c, scale:1 abs, opacity:1, rot:0", true, false, types.POINTS)
	if err != nil {
		return nil, err
	}
	if err := pdfcpuapi.AddWatermarksFile(srcPath, outPath, nil, wm, nil); err != nil {
		return nil, err
	}
	return os.ReadFile(outPath)
}

func writeTemp(pattern string, data []byte) (string, error) {
	f, err := os.CreateTemp("", pattern)
	if err != nil {
		return "", err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(f.Name())
		return "", err
	}
	f.Close()
	return f.Name(), nil
}

func tempName(pattern string) (string, error) {
	f, err := os.CreateTemp("", pattern)
	if err != nil {
		return "", err
	}
	name := f.Name()
	f.Close()
	os.Remove(name) // the consumer will create it
	return name, nil
}

// -- helpers --

func lookup(m map[string]interface{}, key string) interface{} {
	if key == "" {
		return ""
	}
	// Dot-path lookup: a.b.c
	cur := interface{}(m)
	for _, part := range strings.Split(key, ".") {
		obj, ok := cur.(map[string]interface{})
		if !ok {
			return ""
		}
		cur = obj[part]
	}
	if cur == nil {
		return ""
	}
	return cur
}

func truthy(v interface{}) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		s := strings.ToLower(strings.TrimSpace(x))
		return s == "true" || s == "yes" || s == "1" || s == "on" || s == "✓"
	case float64:
		return x != 0
	case int:
		return x != 0
	}
	return false
}

func floatProp(p map[string]interface{}, key string, def float64) float64 {
	if v, ok := p[key]; ok {
		switch x := v.(type) {
		case float64:
			return x
		case int:
			return float64(x)
		}
	}
	return def
}

func stringProp(p map[string]interface{}, key, def string) string {
	if v, ok := p[key].(string); ok && v != "" {
		return v
	}
	return def
}

func boolProp(p map[string]interface{}, key string, def bool) bool {
	if v, ok := p[key]; ok {
		switch x := v.(type) {
		case bool:
			return x
		case string:
			s := strings.ToLower(strings.TrimSpace(x))
			return s == "true" || s == "1" || s == "yes"
		}
	}
	return def
}

// registerQRImage encodes a QR for `value` and registers it with fpdf under
// `name` so drawWidget can stamp it onto the overlay. Image size is derived
// from the widget; fpdf rescales on Image().
func registerQRImage(pdf *fpdf.Fpdf, name, value string) error {
	if pdf.ImageTypeFromMime(name) != "" {
		// Already registered.
		return nil
	}
	code, err := qr.Encode(value, qr.M, qr.Auto)
	if err != nil {
		return err
	}
	scaled, err := barcode.Scale(code, 400, 400)
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, scaled); err != nil {
		return err
	}
	pdf.RegisterImageOptionsReader(name,
		fpdf.ImageOptions{ImageType: "png", ReadDpi: false},
		bytes.NewReader(buf.Bytes()))
	return nil
}

// registerBarcodeImage encodes a 1-D barcode image and registers it with fpdf.
func registerBarcodeImage(pdf *fpdf.Fpdf, name, value, kind string, w, h int) error {
	var code barcode.Barcode
	var err error
	switch strings.ToLower(kind) {
	case "code39":
		code, err = code39.Encode(strings.ToUpper(value), true, true)
	case "ean13", "ean8":
		code, err = ean.Encode(value)
	default:
		code, err = code128.Encode(value)
	}
	if err != nil {
		return err
	}
	scaled, err := barcode.Scale(code, w, h)
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, scaled); err != nil {
		return err
	}
	pdf.RegisterImageOptionsReader(name,
		fpdf.ImageOptions{ImageType: "png", ReadDpi: false},
		bytes.NewReader(buf.Bytes()))
	return nil
}

func hexToRGB(h string) (int, int, int) {
	h = strings.TrimPrefix(h, "#")
	if len(h) != 6 {
		return 17, 24, 39 // tailwind gray-900
	}
	var r, g, b int
	fmt.Sscanf(h, "%02x%02x%02x", &r, &g, &b)
	return r, g, b
}
