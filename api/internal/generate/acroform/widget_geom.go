package acroform

import (
	"log"
	"os"
	"strings"

	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
)

// widgetGeom holds per-widget geometry, flags, and identity recovered by
// walking /Annots. Tier C uses this as the PRIMARY extraction source so
// name + rect always originate from the same dict (no cross-API name-join
// risk).
type widgetGeom struct {
	rect     *Rect
	pageSize *Size
	page     int
	flags    int
	maxLen   int
	tooltip  string

	// Identity & payload — populated by extractWidgetGeom for Tier C.
	fieldType string
	value     string
	defVal    string
	options   []string
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
			// Lenient widget detection — some PDFs ship widgets without an
			// explicit /Subtype (or with it indirect). Fall back to
			// "has /Rect and either /FT (incl. inherited) or /T or /Parent".
			if !looksLikeWidget(xrt, annotDict) {
				continue
			}

			name := fullFieldName(xrt, annotDict)
			if name == "" {
				continue
			}

			g := widgetGeom{page: pageNr, pageSize: pageSize}
			g.rect = rectFromDict(xrt, annotDict)

			// Walk inherited Ff / MaxLen / TU from parent chain if not present locally.
			g.flags = inheritedInt(xrt, annotDict, "Ff")
			g.maxLen = inheritedInt(xrt, annotDict, "MaxLen")
			g.tooltip = inheritedString(xrt, annotDict, "TU")

			// Identity & payload — inherited from parent chain when needed.
			g.fieldType = inheritedName(xrt, annotDict, "FT")
			g.value = inheritedString(xrt, annotDict, "V")
			g.defVal = inheritedString(xrt, annotDict, "DV")
			g.options = inheritedOptions(xrt, annotDict)

			out[name] = g
		}
	}

	return out
}

// inheritedName walks the /Parent chain for a /Name key.
func inheritedName(xrt *model.XRefTable, dict types.Dict, key string) string {
	cur := dict
	for i := 0; i < 32 && cur != nil; i++ {
		if v, ok := cur[key]; ok {
			if n, ok2 := v.(types.Name); ok2 {
				return string(n)
			}
			// Dereference if indirect.
			if _, ok2 := v.(types.IndirectRef); ok2 && xrt != nil {
				if deref, err := xrt.Dereference(v); err == nil {
					if n, ok3 := deref.(types.Name); ok3 {
						return string(n)
					}
				}
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

// inheritedOptions walks the /Parent chain for an /Opt array. Each entry
// may be either a plain string (display value) or a 2-element array
// [exportValue, displayValue] — we return the display side.
func inheritedOptions(xrt *model.XRefTable, dict types.Dict) []string {
	cur := dict
	for i := 0; i < 32 && cur != nil; i++ {
		if raw, ok := cur["Opt"]; ok {
			arr, err := xrt.DereferenceArray(raw)
			if err == nil && arr != nil {
				out := make([]string, 0, len(arr))
				for _, item := range arr {
					switch v := item.(type) {
					case types.StringLiteral:
						out = append(out, strings.Trim(string(v), "()"))
					case types.HexLiteral:
						if b, err := v.Bytes(); err == nil {
							out = append(out, string(b))
						}
					case types.Array:
						// [export, display] — use display.
						if len(v) >= 2 {
							out = append(out, stringFromObj(xrt, v[1]))
						} else if len(v) == 1 {
							out = append(out, stringFromObj(xrt, v[0]))
						}
					}
				}
				return out
			}
		}
		parentObj, ok := cur["Parent"]
		if !ok {
			return nil
		}
		cur = dereferenceDict(xrt, parentObj)
	}
	return nil
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
//
// Uses xrt.DereferenceDict which actually parses the object stream if the
// xref entry's Object field is still nil (common right after api.ReadContext,
// before full validation has run). The prior implementation used xrt.Find +
// a type-assert which returned nil for any unparsed indirect ref — that's
// what caused /AcroForm dereference to fail on some PDFs.
func dereferenceDict(xrt *model.XRefTable, obj types.Object) types.Dict {
	if d, ok := obj.(types.Dict); ok {
		return d
	}
	if xrt == nil {
		return nil
	}
	d, err := xrt.DereferenceDict(obj)
	if err != nil {
		return nil
	}
	return d
}

// stringFromObj extracts a string from a StringLiteral / HexLiteral, dereferencing if needed.
func stringFromObj(xrt *model.XRefTable, obj types.Object) string {
	if _, isIR := obj.(types.IndirectRef); isIR && xrt != nil {
		deref, err := xrt.Dereference(obj)
		if err != nil {
			return ""
		}
		obj = deref
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

// rectFromDict extracts a PDF /Rect from a dict, handling three storage forms:
//  1. Direct types.Array in the dict (most common).
//  2. Indirect reference (types.IndirectRef) → resolved via xrt.Find.
//  3. Any other form → attempted via xrt.DereferenceArray as a final fallback.
//
// Returns nil when no valid 4-element array is found.
func rectFromDict(xrt *model.XRefTable, d types.Dict) *Rect {
	raw, ok := d["Rect"]
	if !ok {
		return nil
	}
	var arr types.Array
	if a, ok := raw.(types.Array); ok {
		arr = a
	}
	if len(arr) == 0 {
		// Indirect ref (or anything else) — let pdfcpu actually parse it.
		if a, err := xrt.DereferenceArray(raw); err == nil {
			arr = a
		}
	}
	if len(arr) < 4 {
		return nil
	}
	llx := floatFromObj(arr[0])
	lly := floatFromObj(arr[1])
	urx := floatFromObj(arr[2])
	ury := floatFromObj(arr[3])
	if urx < llx {
		llx, urx = urx, llx
	}
	if ury < lly {
		lly, ury = ury, lly
	}
	return &Rect{X: llx, Y: lly, W: urx - llx, H: ury - lly}
}

// looksLikeWidget returns true if the annot dict is plausibly a form widget.
// Accepts:
//   1. /Subtype /Widget (direct or indirect Name)
//   2. has /Rect and either /FT (own or inherited) or /T or /Parent
//
// This tolerates PDFs that omit /Subtype on merged field-widget dicts.
func looksLikeWidget(xrt *model.XRefTable, d types.Dict) bool {
	if subtype, ok := d["Subtype"].(types.Name); ok && string(subtype) == "Widget" {
		return true
	}
	if _, ok := d["Subtype"].(types.IndirectRef); ok && xrt != nil {
		if deref, err := xrt.Dereference(d["Subtype"]); err == nil {
			if n, ok2 := deref.(types.Name); ok2 && string(n) == "Widget" {
				return true
			}
		}
	}
	// Fallback heuristic.
	if _, hasRect := d["Rect"]; !hasRect {
		return false
	}
	if _, hasT := d["T"]; hasT {
		return true
	}
	if _, hasParent := d["Parent"]; hasParent {
		return true
	}
	if inheritedName(xrt, d, "FT") != "" {
		return true
	}
	return false
}

// walkAcroFormFields is a secondary source of widget geometry for PDFs that
// don't reference their widgets from page /Annots (or where the /Annots
// entries are malformed). Iterates /AcroForm/Fields recursively, visiting
// each field and its /Kids, collecting widgets with /Rect.
//
// `pageIndex` maps widget IndirectRef.ObjectNumber → page number so we can
// assign each widget to the right page without relying on /P back-pointers.
func walkAcroFormFields(xrt *model.XRefTable, pageIndex map[int]int, pageSizes map[int]*Size) map[string]widgetGeom {
	out := map[string]widgetGeom{}
	if xrt == nil {
		debugWalker("bail: xrt nil")
		return out
	}
	// xrt.RootDict may be nil when the catalog hasn't been walked yet;
	// xrt.Catalog() lazily populates it.
	root := xrt.RootDict
	if root == nil {
		cat, err := xrt.Catalog()
		if err != nil {
			debugWalker("bail: Catalog() error: %v", err)
			return out
		}
		root = cat
	}
	if root == nil {
		debugWalker("bail: root still nil after Catalog()")
		return out
	}
	debugWalker("root ok; keys=%v", dictKeyList(root))
	formRaw, ok := root["AcroForm"]
	if !ok {
		debugWalker("bail: root has no /AcroForm key")
		return out
	}
	debugWalker("root.AcroForm exists, type=%T", formRaw)
	formDict := dereferenceDict(xrt, formRaw)
	if formDict == nil {
		debugWalker("bail: /AcroForm dereference failed")
		return out
	}
	debugWalker("/AcroForm dict keys=%v", dictKeyList(formDict))
	fieldsRaw, ok := formDict["Fields"]
	if !ok {
		debugWalker("bail: /AcroForm has no /Fields key")
		return out
	}
	debugWalker("/Fields raw type=%T", fieldsRaw)
	fields, err := xrt.DereferenceArray(fieldsRaw)
	if err != nil {
		debugWalker("bail: DereferenceArray(/Fields) error: %v", err)
		return out
	}
	if fields == nil {
		debugWalker("bail: /Fields dereferenced to nil")
		return out
	}
	debugWalker("/Fields array len=%d", len(fields))
	for i, f := range fields {
		before := len(out)
		walkAcroField(xrt, f, "", pageIndex, pageSizes, out)
		debugWalker("  /Fields[%d] type=%T → +%d entries", i, f, len(out)-before)
	}
	return out
}

func debugWalker(format string, args ...any) {
	if os.Getenv("ACROFORM_DEBUG") == "1" {
		log.Printf("[acroform.walker] "+format, args...)
	}
}

func dictKeyList(d types.Dict) []string {
	keys := make([]string, 0, len(d))
	for k := range d {
		keys = append(keys, k)
	}
	return keys
}

// walkAcroField recurses through the /AcroForm/Fields tree. When it hits a
// terminal widget (leaf field with /Rect, or a /Kids entry that's itself a
// Widget annot), it records geometry + metadata under the full dotted name.
func walkAcroField(xrt *model.XRefTable, obj types.Object, parentPath string, pageIndex map[int]int, pageSizes map[int]*Size, out map[string]widgetGeom) {
	d := dereferenceDict(xrt, obj)
	if d == nil {
		return
	}

	// Compose name = parent + local /T.
	name := parentPath
	if t, ok := d["T"]; ok {
		if s := stringFromObj(xrt, t); s != "" {
			if name == "" {
				name = s
			} else {
				name = name + "." + s
			}
		}
	}

	// If there's a /Kids array, recurse. Kids are either sub-fields (have /T)
	// or widget annotations (no /T, just geometry + /Parent).
	if kidsRaw, ok := d["Kids"]; ok {
		kids, err := xrt.DereferenceArray(kidsRaw)
		if err == nil && kids != nil && len(kids) > 0 {
			for _, k := range kids {
				kd := dereferenceDict(xrt, k)
				if kd == nil {
					continue
				}
				// A kid with /T is a sub-field → recurse.
				if _, hasT := kd["T"]; hasT {
					walkAcroField(xrt, k, name, pageIndex, pageSizes, out)
					continue
				}
				// Otherwise treat as a terminal widget annotation under `name`.
				if ir, isIR := k.(types.IndirectRef); isIR {
					recordGeom(xrt, kd, name, ir, pageIndex, pageSizes, out)
				} else {
					recordGeom(xrt, kd, name, types.IndirectRef{}, pageIndex, pageSizes, out)
				}
			}
			return
		}
	}

	// No /Kids — this field IS its own widget (merged).
	if name == "" {
		return
	}
	if ir, isIR := obj.(types.IndirectRef); isIR {
		recordGeom(xrt, d, name, ir, pageIndex, pageSizes, out)
	} else {
		recordGeom(xrt, d, name, types.IndirectRef{}, pageIndex, pageSizes, out)
	}
}

func recordGeom(xrt *model.XRefTable, d types.Dict, name string, ir types.IndirectRef, pageIndex map[int]int, pageSizes map[int]*Size, out map[string]widgetGeom) {
	// Skip if we already have geometry for this name (first-seen wins — page
	// /Annots walk runs first and is usually more accurate).
	if _, seen := out[name]; seen {
		return
	}

	g := widgetGeom{}
	g.rect = rectFromDict(xrt, d)

	// Resolve page via IR → pageIndex.
	if ir.ObjectNumber.Value() != 0 {
		if p, ok := pageIndex[ir.ObjectNumber.Value()]; ok {
			g.page = p
			if ps := pageSizes[p]; ps != nil {
				g.pageSize = ps
			}
		}
	}
	// Fallback: /P back-pointer on the widget dict.
	if g.page == 0 {
		if pRaw, ok := d["P"]; ok {
			if pir, ok2 := pRaw.(types.IndirectRef); ok2 {
				if p, ok3 := pageIndex[pir.ObjectNumber.Value()]; ok3 {
					g.page = p
					if ps := pageSizes[p]; ps != nil {
						g.pageSize = ps
					}
				}
			}
		}
	}

	g.flags = inheritedInt(xrt, d, "Ff")
	g.maxLen = inheritedInt(xrt, d, "MaxLen")
	g.tooltip = inheritedString(xrt, d, "TU")
	g.fieldType = inheritedName(xrt, d, "FT")
	g.value = inheritedString(xrt, d, "V")
	g.defVal = inheritedString(xrt, d, "DV")
	g.options = inheritedOptions(xrt, d)

	out[name] = g
}

// buildPageIndex scans every page and returns two maps:
//
//	idx:   object-number → pageNr
//	       Includes BOTH the page-dict object number (for /P back-pointer lookups)
//	       AND every /Annots entry object number (for widget-IR lookups in
//	       walkAcroFormFields where the widget object appears in /Annots).
//
//	sizes: pageNr → page size.
func buildPageIndex(xrt *model.XRefTable) (map[int]int, map[int]*Size) {
	idx := map[int]int{}
	sizes := map[int]*Size{}
	if xrt == nil || xrt.PageCount == 0 {
		return idx, sizes
	}
	for pageNr := 1; pageNr <= xrt.PageCount; pageNr++ {
		pageIR, err := xrt.PageDictIndRef(pageNr)
		if err != nil || pageIR == nil {
			continue
		}
		// Page-dict obj number → pageNr (supports /P back-pointer in recordGeom).
		idx[pageIR.ObjectNumber.Value()] = pageNr

		pageDict, _, inherited, err := xrt.PageDict(pageNr, false)
		if err != nil || pageDict == nil {
			continue
		}
		if inherited != nil && inherited.MediaBox != nil {
			sizes[pageNr] = &Size{W: inherited.MediaBox.Width(), H: inherited.MediaBox.Height()}
		}

		// Also index every /Annots entry obj number → pageNr so that widget
		// IndirectRefs found during walkAcroFormFields resolve to the right page.
		if annotsRaw, ok := pageDict["Annots"]; ok {
			if annots, err2 := xrt.DereferenceArray(annotsRaw); err2 == nil {
				for _, a := range annots {
					if air, ok2 := a.(types.IndirectRef); ok2 {
						idx[air.ObjectNumber.Value()] = pageNr
					}
				}
			}
		}
	}
	return idx, sizes
}
