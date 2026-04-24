package acroform

import (
	"strings"

	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
)

// widgetGeom holds per-widget geometry and flags recovered by walking /Annots.
type widgetGeom struct {
	rect     *Rect
	pageSize *Size
	page     int
	flags    int
	maxLen   int
	tooltip  string
}

// extractWidgetGeom walks each page's /Annots, picks entries with
// /Subtype /Widget, and returns a map keyed by the widget's full dotted
// field name (walking /Parent → /T chain).
func extractWidgetGeom(xrt *model.XRefTable) map[string]widgetGeom {
	out := map[string]widgetGeom{}
	if xrt == nil {
		return out
	}
	if xrt.PageCount == 0 {
		return out
	}

	for pageNr := 1; pageNr <= xrt.PageCount; pageNr++ {
		pageDict, _, inherited, err := xrt.PageDict(pageNr, false)
		if err != nil || pageDict == nil {
			continue
		}

		var pageSize *Size
		if inherited != nil && inherited.MediaBox != nil {
			pageSize = &Size{W: inherited.MediaBox.Width(), H: inherited.MediaBox.Height()}
		}

		annotsRaw, ok := pageDict["Annots"]
		if !ok {
			continue
		}
		annots, err := xrt.DereferenceArray(annotsRaw)
		if err != nil || annots == nil {
			continue
		}

		for _, annotObj := range annots {
			annotDict := dereferenceDict(xrt, annotObj)
			if annotDict == nil {
				continue
			}
			subtype, _ := annotDict["Subtype"].(types.Name)
			if string(subtype) != "Widget" {
				continue
			}

			name := fullFieldName(xrt, annotDict)
			if name == "" {
				continue
			}

			g := widgetGeom{page: pageNr, pageSize: pageSize}

			if rectArr, ok := annotDict["Rect"].(types.Array); ok && len(rectArr) >= 4 {
				llx := floatFromObj(rectArr[0])
				lly := floatFromObj(rectArr[1])
				urx := floatFromObj(rectArr[2])
				ury := floatFromObj(rectArr[3])
				if urx < llx {
					llx, urx = urx, llx
				}
				if ury < lly {
					lly, ury = ury, lly
				}
				g.rect = &Rect{X: llx, Y: lly, W: urx - llx, H: ury - lly}
			}

			// Walk inherited Ff / MaxLen / TU from parent chain if not present locally.
			g.flags = inheritedInt(xrt, annotDict, "Ff")
			g.maxLen = inheritedInt(xrt, annotDict, "MaxLen")
			g.tooltip = inheritedString(xrt, annotDict, "TU")

			out[name] = g
		}
	}

	return out
}

// fullFieldName walks /Parent → /T to build the full dotted field name.
func fullFieldName(xrt *model.XRefTable, dict types.Dict) string {
	var parts []string
	cur := dict
	// Max depth guard to avoid cycles.
	for i := 0; i < 32 && cur != nil; i++ {
		if t, ok := cur["T"]; ok {
			if s := stringFromObj(xrt, t); s != "" {
				parts = append([]string{s}, parts...)
			}
		}
		parentObj, ok := cur["Parent"]
		if !ok {
			break
		}
		cur = dereferenceDict(xrt, parentObj)
	}
	return strings.Join(parts, ".")
}

// inheritedInt returns the int value of key, walking /Parent if missing locally.
func inheritedInt(xrt *model.XRefTable, dict types.Dict, key string) int {
	cur := dict
	for i := 0; i < 32 && cur != nil; i++ {
		if v, ok := cur[key]; ok {
			if n, nerr := xrt.DereferenceInteger(v); nerr == nil && n != nil {
				return n.Value()
			}
			if n, ok2 := v.(types.Integer); ok2 {
				return n.Value()
			}
		}
		parentObj, ok := cur["Parent"]
		if !ok {
			return 0
		}
		cur = dereferenceDict(xrt, parentObj)
	}
	return 0
}

// inheritedString returns a string value, walking /Parent chain.
func inheritedString(xrt *model.XRefTable, dict types.Dict, key string) string {
	cur := dict
	for i := 0; i < 32 && cur != nil; i++ {
		if v, ok := cur[key]; ok {
			if s := stringFromObj(xrt, v); s != "" {
				return s
			}
		}
		parentObj, ok := cur["Parent"]
		if !ok {
			return ""
		}
		cur = dereferenceDict(xrt, parentObj)
	}
	return ""
}

// dereferenceDict resolves any object (direct or indirect) to a types.Dict.
func dereferenceDict(xrt *model.XRefTable, obj types.Object) types.Dict {
	if d, ok := obj.(types.Dict); ok {
		return d
	}
	if ir, ok := obj.(types.IndirectRef); ok {
		entry, ok := xrt.Find(ir.ObjectNumber.Value())
		if !ok || entry == nil {
			return nil
		}
		if d, ok := entry.Object.(types.Dict); ok {
			return d
		}
	}
	return nil
}

// stringFromObj extracts a string from a StringLiteral / HexLiteral, dereferencing if needed.
func stringFromObj(xrt *model.XRefTable, obj types.Object) string {
	if ir, ok := obj.(types.IndirectRef); ok {
		entry, ok := xrt.Find(ir.ObjectNumber.Value())
		if !ok || entry == nil {
			return ""
		}
		obj = entry.Object
	}
	switch s := obj.(type) {
	case types.StringLiteral:
		return strings.Trim(string(s), "()")
	case types.HexLiteral:
		if b, err := s.Bytes(); err == nil {
			return string(b)
		}
		return s.Value()
	case types.Name:
		return string(s)
	}
	return ""
}

// floatFromObj coerces a pdfcpu number object to float64.
func floatFromObj(obj types.Object) float64 {
	switch n := obj.(type) {
	case types.Integer:
		return float64(n.Value())
	case types.Float:
		return n.Value()
	}
	return 0
}
