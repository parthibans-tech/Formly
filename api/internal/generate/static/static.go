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
	"fmt"
	"image/png"
	"os"
	"strings"

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
	desc := fmt.Sprintf("points:%d, rot:%d, opacity:%.2f, pos:c, sc:1", size, angle, op)
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

	for i, p := range pages {
		pdf.AddPageFormat("P", fpdf.SizeType{Wd: p.W, Ht: p.H})
		pageNum := i + 1
		for _, wd := range widgets {
			if wd.Page != pageNum {
				continue
			}
			drawWidget(pdf, wd, p, data)
		}
	}

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func drawWidget(pdf *fpdf.Fpdf, wd Widget, p pageDim, data map[string]interface{}) {
	// Convert PDF space (bottom-left origin) to fpdf space (top-left origin) for drawing.
	topY := p.H - wd.Y - wd.H

	raw := lookup(data, wd.DataKey)
	value := fmt.Sprint(raw)

	props := wd.Props
	if props == nil {
		props = map[string]interface{}{}
	}
	fontSize := floatProp(props, "fontSize", 12)
	fontFamily := stringProp(props, "fontFamily", "Helvetica")
	color := stringProp(props, "color", "#111827")
	r, g, b := hexToRGB(color)
	pdf.SetTextColor(r, g, b)
	pdf.SetFont(fontFamily, "", fontSize)

	switch wd.Type {
	case "text", "number", "currency", "date", "":
		if value == "" {
			return
		}
		pdf.SetXY(wd.X, topY)
		pdf.CellFormat(wd.W, wd.H, value, "", 0, stringProp(props, "align", "L"), false, 0, "")
	case "multiline":
		pdf.SetXY(wd.X, topY)
		pdf.MultiCell(wd.W, fontSize*1.15, value, "", stringProp(props, "align", "L"), false)
	case "checkbox":
		checked := truthy(raw)
		pdf.SetDrawColor(r, g, b)
		pdf.Rect(wd.X, topY, wd.W, wd.H, "D")
		if checked {
			pdf.Line(wd.X+2, topY+2, wd.X+wd.W-2, topY+wd.H-2)
			pdf.Line(wd.X+wd.W-2, topY+2, wd.X+2, topY+wd.H-2)
		}
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
	default:
		// Unknown type: render as text so authors can see the raw value and fix it.
		pdf.SetXY(wd.X, topY)
		pdf.CellFormat(wd.W, wd.H, value, "", 0, "L", false, 0, "")
	}
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

	wm, err := pdfcpuapi.PDFWatermark(ovPath, "pos:c, sc:1 abs, opacity:1, rot:0", true, false, types.POINTS)
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

