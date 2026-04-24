package acroform

// Tier C — PDF structure editing.
//
// ApplyStructurePatches mutates the AcroForm structure of an existing PDF
// and returns the modified bytes. Supported ops:
//
//   update-rect     — move/resize a widget
//   rename          — change the field /T (leaf name)
//   delete          — remove widget from page /Annots and /AcroForm/Fields
//   add-text        — create a new text field at a given rect
//   update-props    — change /Ff flags, /MaxLen, /TU tooltip, /DV default, /Opt options
//
// All mutations operate on LIVE xref entries via xrt.Find(objNr), mirroring
// the pattern used by static/acroform.go (which is known to round-trip
// cleanly through pdfcpu's WriteContext).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	pdfcpuapi "github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
)

// AcroForm /Ff bit flags (ISO 32000-1 §12.7.3.1).
const (
	acroReadOnly    = 1 << 0
	acroRequired    = 1 << 1
	acroNoExport    = 1 << 2
	acroMultiline   = 1 << 12
	acroPassword    = 1 << 13
	acroNoToggleOff = 1 << 14
	acroRadio       = 1 << 15
	acroPushbutton  = 1 << 16
	acroCombo       = 1 << 17
	acroEdit        = 1 << 18
	acroMultiSelect = 1 << 21
	acroComb        = 1 << 24
)

// StructurePatch is a single mutation instruction. Exactly one of the
// variant fields should be populated (matched by Op).
type StructurePatch struct {
	Op      string           `json:"op"`
	Name    string           `json:"name,omitempty"`
	NewName string           `json:"newName,omitempty"`
	Page    int              `json:"page,omitempty"`
	Rect    *Rect            `json:"rect,omitempty"`
	Props   *PatchFieldProps `json:"props,omitempty"`
}

// PatchFieldProps holds optional property changes. nil pointer = no change;
// empty string = clear.
type PatchFieldProps struct {
	Flags        *int     `json:"flags,omitempty"`
	ReadOnly     *bool    `json:"readOnly,omitempty"`
	Required     *bool    `json:"required,omitempty"`
	Multiline    *bool    `json:"multiline,omitempty"`
	Password     *bool    `json:"password,omitempty"`
	MaxLen       *int     `json:"maxLen,omitempty"`
	Tooltip      *string  `json:"tooltip,omitempty"`
	Default      *string  `json:"default,omitempty"`
	Options      []string `json:"options,omitempty"`
	ClearOptions bool     `json:"clearOptions,omitempty"`
}

// ApplyStructurePatches applies a batch of structure patches to pdfBytes and
// returns the modified PDF. Patches are applied in order; an error in any
// patch aborts the batch.
func ApplyStructurePatches(pdfBytes []byte, patches []StructurePatch) ([]byte, error) {
	rs := bytes.NewReader(pdfBytes)
	conf := model.NewDefaultConfiguration()
	conf.ValidationMode = model.ValidationRelaxed
	// CRITICAL: use ReadAndValidate, not ReadContext.
	//
	// ReadContext does a MINIMAL parse — xref table + catalog ref only. It
	// leaves most indirect objects (including page content streams, font
	// dicts, and resource dicts) as raw, unparsed xref entries. When
	// WriteContext is then called, it can only serialize objects that are
	// live types.Object values in the xref cache — any unparsed entries get
	// dropped, corrupting the output PDF (content streams disappear; pages
	// render as empty grids).
	//
	// ReadAndValidate fully walks the PDF, parsing every referenced object
	// into the xref cache so WriteContext can round-trip the file intact.
	ctx, err := pdfcpuapi.ReadAndValidate(rs, conf)
	if err != nil {
		return nil, fmt.Errorf("acroform mutate: read pdf: %w", err)
	}

	for i, p := range patches {
		if err := applyOne(ctx, p); err != nil {
			return nil, fmt.Errorf("patch %d (%s %q): %w", i, p.Op, p.Name, err)
		}
	}

	var out bytes.Buffer
	if err := pdfcpuapi.WriteContext(ctx, &out); err != nil {
		return nil, fmt.Errorf("acroform mutate: write pdf: %w", err)
	}
	return out.Bytes(), nil
}

func applyOne(ctx *model.Context, p StructurePatch) error {
	switch p.Op {
	case "update-rect":
		if p.Rect == nil {
			return fmt.Errorf("update-rect requires rect")
		}
		return updateFieldRect(ctx, p.Name, p.Page, *p.Rect)
	case "rename":
		if p.NewName == "" {
			return fmt.Errorf("rename requires newName")
		}
		return renameField(ctx, p.Name, p.NewName)
	case "delete":
		return deleteField(ctx, p.Name)
	case "add-text":
		if p.Rect == nil || p.Page <= 0 {
			return fmt.Errorf("add-text requires rect and page")
		}
		return addTextField(ctx, p.Name, p.Page, *p.Rect, p.Props)
	case "update-props":
		if p.Props == nil {
			return fmt.Errorf("update-props requires props")
		}
		return updateFieldProps(ctx, p.Name, *p.Props)
	default:
		return fmt.Errorf("unknown op %q", p.Op)
	}
}

// --------------------------------------------------------------------------
// Live page dict access — mirrors static/acroform.go#appendAnnotsToPage.
// --------------------------------------------------------------------------

// livePageDict returns the LIVE xref-backed page dict for pageNr, along with
// the page's IndirectRef (for setting /P on annotations). Mutations to the
// returned dict persist through WriteContext.
func livePageDict(ctx *model.Context, pageNr int) (types.Dict, *types.IndirectRef, error) {
	pageIR, err := ctx.XRefTable.PageDictIndRef(pageNr)
	if err != nil || pageIR == nil {
		return nil, nil, fmt.Errorf("page %d not found", pageNr)
	}
	entry, ok := ctx.XRefTable.Find(pageIR.ObjectNumber.Value())
	if !ok || entry == nil {
		return nil, nil, fmt.Errorf("page %d xref entry missing", pageNr)
	}
	if pd, ok := entry.Object.(types.Dict); ok {
		return pd, pageIR, nil
	}
	// Object not yet parsed — force pdfcpu to parse it into entry.Object.
	pd, err := ctx.XRefTable.DereferenceDict(*pageIR)
	if err != nil {
		return nil, nil, fmt.Errorf("page %d dereference: %w", pageNr, err)
	}
	if pd == nil {
		return nil, nil, fmt.Errorf("page %d object is not a dict", pageNr)
	}
	return pd, pageIR, nil
}

// liveDict resolves an IndirectRef to its live xref-backed Dict.
//
// If the xref entry's Object hasn't been parsed yet (common straight after
// api.ReadContext), we fall back to xrt.DereferenceDict which parses on
// demand and stores the result back in entry.Object — so the returned Dict
// is still the live, mutation-persistent one.
func liveDict(ctx *model.Context, ir types.IndirectRef) types.Dict {
	entry, ok := ctx.XRefTable.Find(ir.ObjectNumber.Value())
	if !ok || entry == nil {
		return nil
	}
	if d, ok := entry.Object.(types.Dict); ok {
		return d
	}
	// Force pdfcpu to parse the object into entry.Object.
	d, err := ctx.XRefTable.DereferenceDict(ir)
	if err != nil {
		return nil
	}
	return d
}

// --------------------------------------------------------------------------
// Widget location
// --------------------------------------------------------------------------

type widgetLoc struct {
	dict     types.Dict          // live widget dict
	ir       types.IndirectRef   // widget's indirect ref
	pageNr   int                 // page it lives on
	pageDict types.Dict          // live page dict
}

// findWidgetByName walks each page's /Annots and returns the first widget
// whose full dotted field name matches.
func findWidgetByName(ctx *model.Context, name string) (*widgetLoc, error) {
	xrt := ctx.XRefTable
	if xrt == nil || xrt.PageCount == 0 {
		return nil, fmt.Errorf("empty pdf")
	}

	for pageNr := 1; pageNr <= xrt.PageCount; pageNr++ {
		pd, _, err := livePageDict(ctx, pageNr)
		if err != nil || pd == nil {
			continue
		}
		annotsRaw, ok := pd["Annots"]
		if !ok {
			continue
		}
		annots, err := xrt.DereferenceArray(annotsRaw)
		if err != nil || annots == nil {
			continue
		}
		for _, annotObj := range annots {
			ir, isIR := annotObj.(types.IndirectRef)
			if !isIR {
				continue
			}
			ad := liveDict(ctx, ir)
			if ad == nil {
				continue
			}
			subtype, _ := ad["Subtype"].(types.Name)
			if string(subtype) != "Widget" {
				continue
			}
			if fullFieldName(xrt, ad) == name {
				return &widgetLoc{dict: ad, ir: ir, pageNr: pageNr, pageDict: pd}, nil
			}
		}
	}
	return nil, fmt.Errorf("field %q not found", name)
}

// --------------------------------------------------------------------------
// update-rect
// --------------------------------------------------------------------------

func updateFieldRect(ctx *model.Context, name string, targetPage int, rect Rect) error {
	loc, err := findWidgetByName(ctx, name)
	if err != nil {
		return err
	}

	// Optional page move.
	if targetPage > 0 && targetPage != loc.pageNr {
		if err := moveWidgetToPage(ctx, loc, targetPage); err != nil {
			return err
		}
	}

	loc.dict["Rect"] = types.Array{
		types.Float(rect.X),
		types.Float(rect.Y),
		types.Float(rect.X + rect.W),
		types.Float(rect.Y + rect.H),
	}
	return nil
}

func moveWidgetToPage(ctx *model.Context, loc *widgetLoc, toPage int) error {
	// Remove from source page /Annots.
	if annotsRaw, ok := loc.pageDict["Annots"]; ok {
		annots, _ := ctx.XRefTable.DereferenceArray(annotsRaw)
		filtered := make(types.Array, 0, len(annots))
		for _, a := range annots {
			if other, isIR := a.(types.IndirectRef); isIR &&
				other.ObjectNumber.Value() == loc.ir.ObjectNumber.Value() {
				continue
			}
			filtered = append(filtered, a)
		}
		loc.pageDict["Annots"] = filtered
	}

	// Add to destination page /Annots.
	dstDict, dstIR, err := livePageDict(ctx, toPage)
	if err != nil {
		return err
	}
	var existing types.Array
	if raw, ok := dstDict["Annots"]; ok {
		existing, _ = ctx.XRefTable.DereferenceArray(raw)
	}
	dstDict["Annots"] = append(existing, loc.ir)

	// Update /P back-pointer on widget.
	if dstIR != nil {
		loc.dict["P"] = *dstIR
	}
	loc.pageNr = toPage
	loc.pageDict = dstDict
	return nil
}

// --------------------------------------------------------------------------
// rename (leaf /T only — parent chain is preserved)
// --------------------------------------------------------------------------

func renameField(ctx *model.Context, fullName, newLeaf string) error {
	loc, err := findWidgetByName(ctx, fullName)
	if err != nil {
		return err
	}
	parts := strings.Split(newLeaf, ".")
	loc.dict["T"] = types.StringLiteral(parts[len(parts)-1])
	return nil
}

// --------------------------------------------------------------------------
// delete
// --------------------------------------------------------------------------

func deleteField(ctx *model.Context, name string) error {
	loc, err := findWidgetByName(ctx, name)
	if err != nil {
		return err
	}
	xrt := ctx.XRefTable

	// Remove from page /Annots.
	if annotsRaw, ok := loc.pageDict["Annots"]; ok {
		annots, _ := xrt.DereferenceArray(annotsRaw)
		filtered := make(types.Array, 0, len(annots))
		for _, a := range annots {
			if other, isIR := a.(types.IndirectRef); isIR &&
				other.ObjectNumber.Value() == loc.ir.ObjectNumber.Value() {
				continue
			}
			filtered = append(filtered, a)
		}
		loc.pageDict["Annots"] = filtered
	}

	// Remove from /AcroForm/Fields (top level — parent chains aren't unwound here).
	if ctx.Form != nil {
		if fieldsRaw, ok := ctx.Form["Fields"]; ok {
			fields, _ := xrt.DereferenceArray(fieldsRaw)
			filtered := make(types.Array, 0, len(fields))
			for _, f := range fields {
				if other, isIR := f.(types.IndirectRef); isIR &&
					other.ObjectNumber.Value() == loc.ir.ObjectNumber.Value() {
					continue
				}
				filtered = append(filtered, f)
			}
			ctx.Form["Fields"] = filtered
		}
	}
	return nil
}

// --------------------------------------------------------------------------
// add-text
// --------------------------------------------------------------------------

func addTextField(ctx *model.Context, name string, page int, rect Rect, props *PatchFieldProps) error {
	if name == "" {
		return fmt.Errorf("add-text requires a name")
	}
	xrt := ctx.XRefTable

	pageDict, pageIR, err := livePageDict(ctx, page)
	if err != nil {
		return err
	}

	flags := 0
	var maxLen int
	var tooltip, defval string
	if props != nil {
		if props.Flags != nil {
			flags = *props.Flags
		}
		if props.ReadOnly != nil && *props.ReadOnly {
			flags |= acroReadOnly
		}
		if props.Required != nil && *props.Required {
			flags |= acroRequired
		}
		if props.Multiline != nil && *props.Multiline {
			flags |= acroMultiline
		}
		if props.Password != nil && *props.Password {
			flags |= acroPassword
		}
		if props.MaxLen != nil {
			maxLen = *props.MaxLen
		}
		if props.Tooltip != nil {
			tooltip = *props.Tooltip
		}
		if props.Default != nil {
			defval = *props.Default
		}
	}

	d := types.Dict{
		"Type":    types.Name("Annot"),
		"Subtype": types.Name("Widget"),
		"FT":      types.Name("Tx"),
		"T":       types.StringLiteral(name),
		"V":       types.StringLiteral(defval),
		"DV":      types.StringLiteral(defval),
		"DA":      types.StringLiteral("/Helv 10 Tf 0 g"),
		"Rect": types.Array{
			types.Float(rect.X),
			types.Float(rect.Y),
			types.Float(rect.X + rect.W),
			types.Float(rect.Y + rect.H),
		},
	}
	if flags != 0 {
		d["Ff"] = types.Integer(flags)
	}
	if maxLen > 0 {
		d["MaxLen"] = types.Integer(maxLen)
	}
	if tooltip != "" {
		d["TU"] = types.StringLiteral(tooltip)
	}
	if pageIR != nil {
		d["P"] = *pageIR
	}

	ir, err := xrt.IndRefForNewObject(d)
	if err != nil {
		return fmt.Errorf("alloc widget object: %w", err)
	}

	// Attach to page /Annots (preserving existing entries).
	var existingAnnots types.Array
	if raw, ok := pageDict["Annots"]; ok {
		existingAnnots, _ = xrt.DereferenceArray(raw)
	}
	pageDict["Annots"] = append(existingAnnots, *ir)

	// Attach to /AcroForm/Fields.
	if ctx.Form == nil {
		form := types.Dict{
			"Fields":          types.Array{*ir},
			"NeedAppearances": types.Boolean(true),
		}
		ctx.XRefTable.RootDict["AcroForm"] = form
		ctx.Form = form
	} else {
		existing, _ := xrt.DereferenceArray(ctx.Form["Fields"])
		ctx.Form["Fields"] = append(existing, *ir)
		ctx.Form["NeedAppearances"] = types.Boolean(true)
	}
	return nil
}

// --------------------------------------------------------------------------
// update-props
// --------------------------------------------------------------------------

func updateFieldProps(ctx *model.Context, name string, props PatchFieldProps) error {
	loc, err := findWidgetByName(ctx, name)
	if err != nil {
		return err
	}
	ad := loc.dict

	curFlags := 0
	if f, ok := ad["Ff"].(types.Integer); ok {
		curFlags = f.Value()
	}

	setFlag := func(mask int, on bool) {
		if on {
			curFlags |= mask
		} else {
			curFlags &^= mask
		}
	}

	if props.Flags != nil {
		curFlags = *props.Flags
	}
	if props.ReadOnly != nil {
		setFlag(acroReadOnly, *props.ReadOnly)
	}
	if props.Required != nil {
		setFlag(acroRequired, *props.Required)
	}
	if props.Multiline != nil {
		setFlag(acroMultiline, *props.Multiline)
	}
	if props.Password != nil {
		setFlag(acroPassword, *props.Password)
	}
	if curFlags != 0 {
		ad["Ff"] = types.Integer(curFlags)
	} else {
		delete(ad, "Ff")
	}

	if props.MaxLen != nil {
		if *props.MaxLen > 0 {
			ad["MaxLen"] = types.Integer(*props.MaxLen)
		} else {
			delete(ad, "MaxLen")
		}
	}
	if props.Tooltip != nil {
		if *props.Tooltip == "" {
			delete(ad, "TU")
		} else {
			ad["TU"] = types.StringLiteral(*props.Tooltip)
		}
	}
	if props.Default != nil {
		ad["DV"] = types.StringLiteral(*props.Default)
	}
	if props.ClearOptions {
		delete(ad, "Opt")
	}
	if props.Options != nil {
		arr := make(types.Array, 0, len(props.Options))
		for _, s := range props.Options {
			arr = append(arr, types.StringLiteral(s))
		}
		ad["Opt"] = arr
	}
	return nil
}

// DecodePatches is a helper for HTTP handlers.
func DecodePatches(raw json.RawMessage) ([]StructurePatch, error) {
	var p []StructurePatch
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	return p, nil
}
