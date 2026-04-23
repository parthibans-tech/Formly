package html

import (
	"bytes"
	"encoding/base64"
	"fmt"
	htmltemplate "html/template"
	"image"
	"image/png"
	"strings"

	"github.com/boombuler/barcode"
	"github.com/boombuler/barcode/code128"
	"github.com/boombuler/barcode/code39"
	"github.com/boombuler/barcode/ean"
	"github.com/boombuler/barcode/qr"
)

// qrcodeFunc renders a QR code for the given value as an inline PNG <img> tag.
// Usage:
//
//	{{ qrcode .url }}
//	{{ qrcode .url 200 }}         // custom size in px
//	{{ qrcode .url 200 "M" }}     // size + error-correction level (L|M|Q|H)
func qrcodeFunc(args ...interface{}) htmltemplate.HTML {
	if len(args) == 0 {
		return ""
	}
	value := fmt.Sprint(args[0])
	if value == "" {
		return errorImg("QR: empty value")
	}
	size := 180
	if len(args) > 1 {
		if n, ok := toInt(args[1]); ok && n > 0 {
			size = n
		}
	}
	level := qr.M
	if len(args) > 2 {
		if s, ok := args[2].(string); ok {
			switch strings.ToUpper(s) {
			case "L":
				level = qr.L
			case "Q":
				level = qr.Q
			case "H":
				level = qr.H
			}
		}
	}

	code, err := qr.Encode(value, level, qr.Auto)
	if err != nil {
		return errorImg("QR: " + err.Error())
	}
	scaled, err := barcode.Scale(code, size, size)
	if err != nil {
		return errorImg("QR scale: " + err.Error())
	}
	dataURI, err := pngDataURI(scaled)
	if err != nil {
		return errorImg("QR encode: " + err.Error())
	}
	return htmltemplate.HTML(fmt.Sprintf(
		`<img src="%s" alt="QR" width="%d" height="%d" style="image-rendering:pixelated;" />`,
		dataURI, size, size,
	))
}

// barcodeFunc renders a 1D barcode for the given value.
// Usage:
//
//	{{ barcode .sku }}                          // defaults: code128, 300x80
//	{{ barcode .sku "code128" }}
//	{{ barcode .sku "code128" 360 100 }}
//
// Supported kinds: code128 (default), code39, ean13, ean8.
func barcodeFunc(args ...interface{}) htmltemplate.HTML {
	if len(args) == 0 {
		return ""
	}
	value := fmt.Sprint(args[0])
	if value == "" {
		return errorImg("Barcode: empty value")
	}
	kind := "code128"
	if len(args) > 1 {
		if s, ok := args[1].(string); ok && s != "" {
			kind = strings.ToLower(s)
		}
	}
	width, height := 300, 80
	if len(args) > 2 {
		if n, ok := toInt(args[2]); ok && n > 0 {
			width = n
		}
	}
	if len(args) > 3 {
		if n, ok := toInt(args[3]); ok && n > 0 {
			height = n
		}
	}

	var code barcode.Barcode
	var err error
	switch kind {
	case "code39":
		code, err = code39.Encode(strings.ToUpper(value), true, true)
	case "ean13", "ean8":
		code, err = ean.Encode(value)
	default:
		code, err = code128.Encode(value)
	}
	if err != nil {
		return errorImg(kind + ": " + err.Error())
	}
	scaled, err := barcode.Scale(code, width, height)
	if err != nil {
		return errorImg("barcode scale: " + err.Error())
	}
	dataURI, err := pngDataURI(scaled)
	if err != nil {
		return errorImg("barcode encode: " + err.Error())
	}
	return htmltemplate.HTML(fmt.Sprintf(
		`<img src="%s" alt="%s" width="%d" height="%d" />`,
		dataURI, htmltemplate.HTMLEscapeString(kind), width, height,
	))
}

// signatureFunc wraps a signature image URL (or data URI) in a styled <img>.
// Usage:
//
//	{{ signature .signature.image }}
//	{{ signature .signature.image "John Doe" }}
//
// A missing URL renders a dashed placeholder so the layout doesn't collapse.
func signatureFunc(args ...interface{}) htmltemplate.HTML {
	if len(args) == 0 {
		return placeholderSignature("")
	}
	url := fmt.Sprint(args[0])
	if url == "" {
		name := ""
		if len(args) > 1 {
			name = fmt.Sprint(args[1])
		}
		return placeholderSignature(name)
	}
	alt := "Signature"
	if len(args) > 1 {
		alt = fmt.Sprint(args[1])
	}
	safeURL := htmltemplate.HTMLEscapeString(url)
	safeAlt := htmltemplate.HTMLEscapeString(alt)
	return htmltemplate.HTML(fmt.Sprintf(
		`<img src="%s" alt="%s" style="max-height:72px; max-width:240px; display:inline-block; object-fit:contain;" />`,
		safeURL, safeAlt,
	))
}

// imageFunc is a general helper for rendering an arbitrary image URL with a
// default max-size and rounded corners. Second arg is optional alt text.
func imageFunc(args ...interface{}) htmltemplate.HTML {
	if len(args) == 0 {
		return ""
	}
	url := fmt.Sprint(args[0])
	if url == "" {
		return ""
	}
	alt := ""
	if len(args) > 1 {
		alt = fmt.Sprint(args[1])
	}
	safeURL := htmltemplate.HTMLEscapeString(url)
	safeAlt := htmltemplate.HTMLEscapeString(alt)
	return htmltemplate.HTML(fmt.Sprintf(
		`<img src="%s" alt="%s" style="max-width:100%%; height:auto; border-radius:6px;" />`,
		safeURL, safeAlt,
	))
}

// -- internals --

func placeholderSignature(name string) htmltemplate.HTML {
	caption := "Signature"
	if name != "" {
		caption = htmltemplate.HTMLEscapeString(name)
	}
	return htmltemplate.HTML(fmt.Sprintf(
		`<span style="display:inline-block; min-width:200px; border-bottom:1px solid #999; padding:16px 0 2px; font-size:11px; color:#999; text-align:center;">%s</span>`,
		caption,
	))
}

func errorImg(msg string) htmltemplate.HTML {
	safe := htmltemplate.HTMLEscapeString(msg)
	return htmltemplate.HTML(fmt.Sprintf(
		`<span style="display:inline-block; padding:4px 8px; border:1px dashed #f00; color:#c00; font-size:11px;">%s</span>`,
		safe,
	))
}

// pngDataURI PNG-encodes an image.Image and returns a base64 data URI string.
func pngDataURI(img image.Image) (string, error) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}

func toInt(v interface{}) (int, bool) {
	switch x := v.(type) {
	case int:
		return x, true
	case int64:
		return int(x), true
	case float64:
		return int(x), true
	case float32:
		return int(x), true
	}
	return 0, false
}
