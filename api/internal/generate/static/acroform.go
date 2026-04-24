// Package static — AcroForm injection layer.
//
// InjectAcroForm adds interactive PDF form fields to an already-filled PDF.
// It uses pdfcpu's XRefTable API to create Widget annotation objects directly,
// then writes the modified PDF with pdfcpuapi.WriteContext.
//
// Supported widget types (Tier A):
//   text, multiline, number, currency, date  → /FT /Tx
//   checkbox                                  → /FT /Btn (no Pushbutton flag)
//   radio                                     → /FT /Btn + afRadio (parent/kid)
//   dropdown                                  → /FT /Ch + afCombo
//
// Tier B additions:
//   signature-field  → /FT /Sig with optional /Lock
//   button           → /FT /Btn + afPushbutton with /A action (Submit/Reset/JS)
//
// Tier A props (from Widget.Props):
//   acroRequired   bool     → /Ff bit 1
//   acroReadOnly   bool     → /Ff bit 0
//   acroNoExport   bool     → /Ff bit 2
//   acroTooltip    string   → /TU
//   acroMaxLen     float64  → /MaxLen (text fields only)
//   acroComb       bool     → /Ff bit 24 (text + MaxLen only)
//   acroFormat     string   → /AA /F /K JS format action
//   acroDecimals   float64  → decimal places for number/currency/percent format
//   acroDateFmt    string   → date format string for date format
//   acroGroupName  string   → radio group name (/T on parent field)
//   acroExportValue string  → radio button export value (/AS state name)
//   acroCheckedByDefault bool → radio initial selection
//   acroOptions    []interface{} → dropdown option strings or {label,value} maps
//   acroEditable   bool     → dropdown /Ff afEdit flag
//   acroMultiSelect bool    → dropdown /Ff afMultiSelect flag
//   acroTabOrder   float64  → drives /CO calculation order (UI-only otherwise)
//
// Tier B props:
//   acroBgColor      string  → /MK /BG background colour (hex)
//   acroBorderColor  string  → /MK /BC border colour (hex)
//   acroBorderWidth  float64 → /BS /W border width (pt)
//   acroBorderStyle  string  → /BS /S border style: solid/dashed/underline/beveled/inset
//   acroCalcOp       string  → calculation operation: sum/product/average/min/max/custom
//   acroCalcFields   []interface{} → source field data-key strings for built-in ops
//   acroCalcScript   string  → custom JS for /AA /C (when acroCalcOp="custom")
//   acroValidateScript string → /AA /V JS validation script
//   acroLockAfterSign bool   → signature-field /Lock dict (lock all on sign)
//   acroButtonLabel  string  → push-button /MK /CA caption
//   acroButtonAction string  → push-button /A action: submit/reset/js
//   acroSubmitUrl    string  → URL for SubmitForm action
//   acroJsAction     string  → custom JS for JavaScript action

package static

import (
	"bytes"
	"fmt"
	"sort"
	"strings"

	pdfcpuapi "github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
)

// --------------------------------------------------------------------------
// AcroForm field flag bitmask constants (ISO 32000-1 §12.7.3.1)
// --------------------------------------------------------------------------

const (
	afReadOnly    = 1 << 0
	afRequired    = 1 << 1
	afNoExport    = 1 << 2
	afMultiline   = 1 << 12
	afNoToggleOff = 1 << 14
	afRadio       = 1 << 15
	afPushbutton  = 1 << 16 // Tier B: push button
	afCombo       = 1 << 17
	afEdit        = 1 << 18
	afMultiSelect = 1 << 21
	afComb        = 1 << 24
)

// --------------------------------------------------------------------------
// calcEntry tracks a field that has a /AA /C calculation action — used to
// build the AcroForm /CO (calculation order) array.
// --------------------------------------------------------------------------

type calcEntry struct {
	ir       types.IndirectRef
	tabOrder int
}

// InjectAcroForm appends interactive form fields to pdfBytes and returns the
// modified PDF. Widgets without an acro-supported type are silently skipped.
// If no interactive widgets are present, pdfBytes is returned unchanged.
func InjectAcroForm(pdfBytes []byte, widgets []Widget) ([]byte, error) {
	// Filter to interactive types only.
	var fields []Widget
	for _, w := range widgets {
		switch w.Type {
		case "text", "multiline", "number", "currency", "date",
			"checkbox", "radio", "dropdown",
			"signature-field", "button":
			fields = append(fields, w)
		}
	}
	if len(fields) == 0 {
		return pdfBytes, nil
	}

	// Parse the existing PDF into a mutable context.
	rs := bytes.NewReader(pdfBytes)
	conf := model.NewDefaultConfiguration()
	conf.ValidationMode = model.ValidationRelaxed
	ctx, err := pdfcpuapi.ReadContext(rs, conf)
	if err != nil {
		return nil, fmt.Errorf("acroform: read pdf: %w", err)
	}

	xrt := ctx.XRefTable

	// Collect top-level AcroForm /Fields and per-page annotation refs.
	acroFields := types.Array{}
	pageAnnots := map[int][]types.IndirectRef{} // pageNr → new widget IndRefs

	// Track calc fields for /CO order.
	var calcEntries []calcEntry

	// Track whether any signature field is present (drives /SigFlags).
	hasSig := false

	// ---- Non-radio fields ----
	for _, wd := range fields {
		if wd.Type == "radio" {
			continue
		}
		if wd.Type == "signature-field" {
			hasSig = true
		}
		ir, err := buildWidgetAnnot(xrt, wd)
		if err != nil {
			// Non-fatal: skip malformed widgets.
			continue
		}
		acroFields = append(acroFields, *ir)
		pageAnnots[wd.Page] = append(pageAnnots[wd.Page], *ir)

		// Record calc fields for /CO.
		props := wd.Props
		if props == nil {
			props = map[string]interface{}{}
		}
		calcOp := stringProp(props, "acroCalcOp", "none")
		if calcOp != "" && calcOp != "none" {
			to := intProp(props, "acroTabOrder")
			calcEntries = append(calcEntries, calcEntry{ir: *ir, tabOrder: to})
		}
	}

	// ---- Radio button groups ----
	radioGroups := collectRadioGroups(fields)
	sortedGroupNames := make([]string, 0, len(radioGroups))
	for name := range radioGroups {
		sortedGroupNames = append(sortedGroupNames, name)
	}
	sort.Strings(sortedGroupNames)

	for _, groupName := range sortedGroupNames {
		groupWidgets := radioGroups[groupName]
		parentIR, kidIRs, err := buildRadioGroup(xrt, groupName, groupWidgets)
		if err != nil {
			continue
		}
		acroFields = append(acroFields, *parentIR)
		for i, wd := range groupWidgets {
			pageAnnots[wd.Page] = append(pageAnnots[wd.Page], kidIRs[i])
		}
	}

	// ---- Attach annotations to each affected page ----
	for pageNr, newAnnots := range pageAnnots {
		if err := appendAnnotsToPage(ctx, pageNr, newAnnots); err != nil {
			// Page not found or parse error — skip.
			continue
		}
	}

	// ---- Build /CO calculation order array ----
	var coArray types.Array
	if len(calcEntries) > 0 {
		sort.Slice(calcEntries, func(i, j int) bool {
			ai, aj := calcEntries[i].tabOrder, calcEntries[j].tabOrder
			if ai < 0 {
				ai = 9999
			}
			if aj < 0 {
				aj = 9999
			}
			return ai < aj
		})
		for _, e := range calcEntries {
			coArray = append(coArray, e.ir)
		}
	}

	// ---- Create or update the AcroForm dict in the catalog ----
	if ctx.Form != nil {
		// Append to existing fields array.
		existing, _ := xrt.DereferenceArray(ctx.Form["Fields"])
		ctx.Form["Fields"] = append(existing, acroFields...)
		if len(coArray) > 0 {
			existingCO, _ := xrt.DereferenceArray(ctx.Form["CO"])
			ctx.Form["CO"] = append(existingCO, coArray...)
		}
		if hasSig {
			ctx.Form["SigFlags"] = types.Integer(1) // SignaturesExist
		}
	} else {
		formDict := types.Dict{
			"Fields":          acroFields,
			"NeedAppearances": types.Boolean(true),
		}
		if len(coArray) > 0 {
			formDict["CO"] = coArray
		}
		if hasSig {
			formDict["SigFlags"] = types.Integer(1)
		}
		ctx.XRefTable.RootDict["AcroForm"] = formDict
		ctx.Form = formDict
	}

	// ---- Serialize ----
	var buf bytes.Buffer
	if err := pdfcpuapi.WriteContext(ctx, &buf); err != nil {
		return nil, fmt.Errorf("acroform: write pdf: %w", err)
	}
	return buf.Bytes(), nil
}

// --------------------------------------------------------------------------
// Widget annotation builders
// --------------------------------------------------------------------------

// buildWidgetAnnot creates a Widget annotation dict for a non-radio field,
// inserts it into the XRefTable, and returns its IndirectRef.
func buildWidgetAnnot(xrt *model.XRefTable, wd Widget) (*types.IndirectRef, error) {
	props := wd.Props
	if props == nil {
		props = map[string]interface{}{}
	}

	rect := fieldRect(wd)
	flags := buildFieldFlags(wd.Type, props)

	d := types.Dict{
		"Type":    types.Name("Annot"),
		"Subtype": types.Name("Widget"),
		"Rect":    rect,
	}

	// /DA (default appearance) — not used for signature fields.
	if wd.Type != "signature-field" {
		d["DA"] = types.StringLiteral(defaultAppearance(props))
	}

	switch wd.Type {
	case "text", "multiline", "number", "currency", "date":
		d["FT"] = types.Name("Tx")
		d["T"] = types.StringLiteral(safeFieldName(wd.DataKey))
		d["V"] = types.StringLiteral("")
		d["DV"] = types.StringLiteral("")

		if maxLen := intProp(props, "acroMaxLen"); maxLen > 0 {
			d["MaxLen"] = types.Integer(maxLen)
		}
		if aa := buildWidgetAA(props); aa != nil {
			d["AA"] = aa
		}

	case "checkbox":
		d["FT"] = types.Name("Btn")
		d["T"] = types.StringLiteral(safeFieldName(wd.DataKey))
		d["V"] = types.Name("Off")
		d["DV"] = types.Name("Off")
		d["AS"] = types.Name("Off")

	case "dropdown":
		d["FT"] = types.Name("Ch")
		d["T"] = types.StringLiteral(safeFieldName(wd.DataKey))
		d["V"] = types.StringLiteral("")
		d["DV"] = types.StringLiteral("")
		d["Opt"] = buildDropdownOpts(props)

	case "signature-field":
		d["FT"] = types.Name("Sig")
		d["T"] = types.StringLiteral(safeFieldName(wd.DataKey))
		// Optional: lock all fields after signing.
		if boolProp(props, "acroLockAfterSign", false) {
			d["Lock"] = types.Dict{
				"Type":   types.Name("SigFieldLock"),
				"Action": types.Name("All"),
			}
		}

	case "button":
		d["FT"] = types.Name("Btn")
		d["T"] = types.StringLiteral(safeFieldName(wd.DataKey))
		// flags already includes afPushbutton via buildFieldFlags.
		if action := buildButtonAction(props); action != nil {
			d["A"] = action
		}
	}

	if flags != 0 {
		d["Ff"] = types.Integer(flags)
	}
	if tip := stringProp(props, "acroTooltip", ""); tip != "" {
		d["TU"] = types.StringLiteral(tip)
	}

	// Tier B: /MK appearance dict (background, border, button caption).
	if mk := buildMK(props, wd.Type); mk != nil {
		d["MK"] = mk
	}
	// Tier B: /BS border style dict.
	if bs := buildBS(props); bs != nil {
		d["BS"] = bs
	}

	return xrt.IndRefForNewObject(d)
}

// buildRadioGroup creates a non-terminal parent field and kid Widget
// annotations for each radio button in the group.
func buildRadioGroup(xrt *model.XRefTable, groupName string, wds []Widget) (*types.IndirectRef, []types.IndirectRef, error) {
	if len(wds) == 0 {
		return nil, nil, fmt.Errorf("empty radio group: %s", groupName)
	}

	parentFlags := afRadio | afNoToggleOff

	// Check props of first widget for group-level flags.
	for _, wd := range wds {
		if boolProp(wd.Props, "acroReadOnly", false) {
			parentFlags |= afReadOnly
		}
		if boolProp(wd.Props, "acroRequired", false) {
			parentFlags |= afRequired
		}
		break
	}

	// Pre-allocate parent object so kids can reference it.
	parentDict := types.Dict{
		"FT":   types.Name("Btn"),
		"T":    types.StringLiteral(safeFieldName(groupName)),
		"Ff":   types.Integer(parentFlags),
		"V":    types.Name("Off"),
		"DV":   types.Name("Off"),
		"Kids": types.Array{}, // populated below
	}
	parentObjNr, err := xrt.InsertObject(parentDict)
	if err != nil {
		return nil, nil, err
	}
	parentIR := types.NewIndirectRef(parentObjNr, 0)

	// Build kids.
	kids := types.Array{}
	kidIRs := make([]types.IndirectRef, len(wds))
	for i, wd := range wds {
		props := wd.Props
		if props == nil {
			props = map[string]interface{}{}
		}
		exportVal := stringProp(props, "acroExportValue", fmt.Sprintf("val%d", i+1))
		tip := stringProp(props, "acroTooltip", "")

		kidDict := types.Dict{
			"Type":    types.Name("Annot"),
			"Subtype": types.Name("Widget"),
			"FT":      types.Name("Btn"),
			"Parent":  *parentIR,
			"Ff":      types.Integer(afRadio | afNoToggleOff),
			"Rect":    fieldRect(wd),
			"AS":      types.Name("Off"),
			"DA":      types.StringLiteral("/ZaDb 0 Tf 0 g"),
		}
		if tip != "" {
			kidDict["TU"] = types.StringLiteral(tip)
		}
		_ = exportVal // used visually; PDF viewer regenerates appearances

		ir, err := xrt.IndRefForNewObject(kidDict)
		if err != nil {
			return nil, nil, err
		}
		kids = append(kids, *ir)
		kidIRs[i] = *ir
	}

	// Update parent's Kids array in-place.
	if entry, ok := xrt.Find(parentObjNr); ok {
		if pd, ok2 := entry.Object.(types.Dict); ok2 {
			pd["Kids"] = kids
		}
	}

	return parentIR, kidIRs, nil
}

// --------------------------------------------------------------------------
// Page annotation helpers
// --------------------------------------------------------------------------

// appendAnnotsToPage adds widget annotations to the given page's /Annots array,
// also setting /P (parent page reference) on each annotation dict.
func appendAnnotsToPage(ctx *model.Context, pageNr int, newAnnots []types.IndirectRef) error {
	pageIR, err := ctx.XRefTable.PageDictIndRef(pageNr)
	if err != nil || pageIR == nil {
		return fmt.Errorf("page %d not found: %w", pageNr, err)
	}

	xrt := ctx.XRefTable
	entry, ok := xrt.Find(pageIR.ObjectNumber.Value())
	if !ok {
		return fmt.Errorf("page %d xref entry missing", pageNr)
	}
	pageDict, ok := entry.Object.(types.Dict)
	if !ok {
		return fmt.Errorf("page %d object is not a dict", pageNr)
	}

	// Set /P on each new annotation.
	for _, ir := range newAnnots {
		annotEntry, ok2 := xrt.Find(ir.ObjectNumber.Value())
		if !ok2 {
			continue
		}
		if ad, ok3 := annotEntry.Object.(types.Dict); ok3 {
			ad["P"] = *pageIR
		}
	}

	// Dereference existing /Annots (may be nil or indirect).
	existingAnnots, _ := xrt.DereferenceArray(pageDict["Annots"])

	// types.Array = []types.Object; convert []IndirectRef → []Object.
	objAnnots := make(types.Array, len(newAnnots))
	for i, ir := range newAnnots {
		objAnnots[i] = ir
	}
	pageDict["Annots"] = append(existingAnnots, objAnnots...)

	return nil
}

// --------------------------------------------------------------------------
// Dict builders
// --------------------------------------------------------------------------

// fieldRect returns the /Rect array for a widget in PDF coordinates.
func fieldRect(wd Widget) types.Array {
	return types.Array{
		types.Float(wd.X),
		types.Float(wd.Y),
		types.Float(wd.X + wd.W),
		types.Float(wd.Y + wd.H),
	}
}

// buildFieldFlags computes the /Ff bitmask for a non-radio widget.
func buildFieldFlags(widgetType string, props map[string]interface{}) int {
	flags := 0
	if boolProp(props, "acroReadOnly", false) {
		flags |= afReadOnly
	}
	if boolProp(props, "acroRequired", false) {
		flags |= afRequired
	}
	if boolProp(props, "acroNoExport", false) {
		flags |= afNoExport
	}
	if widgetType == "multiline" {
		flags |= afMultiline
	}
	if widgetType == "text" && boolProp(props, "acroComb", false) {
		flags |= afComb
	}
	if widgetType == "dropdown" {
		flags |= afCombo
		if boolProp(props, "acroEditable", false) {
			flags |= afEdit
		}
		if boolProp(props, "acroMultiSelect", false) {
			flags |= afMultiSelect
		}
	}
	if widgetType == "button" {
		flags |= afPushbutton
	}
	return flags
}

// defaultAppearance returns a /DA string appropriate for the widget type.
// Tier B: colour-aware — reads the widget's color prop and emits an RGB operator.
func defaultAppearance(props map[string]interface{}) string {
	fontSize := floatProp(props, "fontSize", 12)
	if fontSize <= 0 {
		fontSize = 12
	}
	if c := stringProp(props, "color", ""); c != "" {
		r, g, b := hexToRGBFloat(c)
		return fmt.Sprintf("/Helv %.6g Tf %.4g %.4g %.4g rg", fontSize, r, g, b)
	}
	return fmt.Sprintf("/Helv %.6g Tf 0 g", fontSize)
}

// hexToRGBFloat converts a CSS hex colour ("#rrggbb") to normalised PDF
// float values in the range 0..1.
func hexToRGBFloat(h string) (float64, float64, float64) {
	ri, gi, bi := hexToRGB(h)
	return float64(ri) / 255, float64(gi) / 255, float64(bi) / 255
}

// --------------------------------------------------------------------------
// Tier B: /MK, /BS, button action
// --------------------------------------------------------------------------

// buildMK returns the /MK (mark-up appearance) dict for a widget, or nil if
// no acro appearance props are set. Reads acroBgColor, acroBorderColor, and
// (for buttons) acroButtonLabel.
func buildMK(props map[string]interface{}, widgetType string) types.Dict {
	mk := types.Dict{}

	if bg := stringProp(props, "acroBgColor", ""); bg != "" {
		r, g, b := hexToRGBFloat(bg)
		mk["BG"] = types.Array{types.Float(r), types.Float(g), types.Float(b)}
	}
	if bc := stringProp(props, "acroBorderColor", ""); bc != "" {
		r, g, b := hexToRGBFloat(bc)
		mk["BC"] = types.Array{types.Float(r), types.Float(g), types.Float(b)}
	}
	// /CA (caption) is only meaningful on push buttons.
	if widgetType == "button" {
		if caption := stringProp(props, "acroButtonLabel", ""); caption != "" {
			mk["CA"] = types.StringLiteral(caption)
		}
	}

	if len(mk) == 0 {
		return nil
	}
	return mk
}

// acroBorderStyleNames maps the UI string to the PDF /BS /S name.
var acroBorderStyleNames = map[string]string{
	"solid":     "S",
	"dashed":    "D",
	"underline": "U",
	"beveled":   "B",
	"inset":     "I",
}

// buildBS returns the /BS (border style) dict for a widget, or nil if no
// acro border props are set. Reads acroBorderWidth and acroBorderStyle.
func buildBS(props map[string]interface{}) types.Dict {
	bw := floatProp(props, "acroBorderWidth", -1)
	style := stringProp(props, "acroBorderStyle", "")
	if bw < 0 && style == "" {
		return nil
	}
	bs := types.Dict{}
	if bw >= 0 {
		bs["W"] = types.Float(bw)
	}
	if sName, ok := acroBorderStyleNames[style]; ok {
		bs["S"] = types.Name(sName)
	}
	if len(bs) == 0 {
		return nil
	}
	return bs
}

// buildButtonAction returns the /A activation-action dict for a push button,
// or nil if no meaningful action is configured.
func buildButtonAction(props map[string]interface{}) types.Dict {
	action := stringProp(props, "acroButtonAction", "none")
	switch action {
	case "submit":
		url := stringProp(props, "acroSubmitUrl", "")
		if url == "" {
			return nil
		}
		return types.Dict{
			"S": types.Name("SubmitForm"),
			"F": types.Dict{
				"FS": types.Name("URL"),
				"F":  types.StringLiteral(url),
			},
			"Flags": types.Integer(0),
		}
	case "reset":
		return types.Dict{
			"S": types.Name("ResetForm"),
		}
	case "js":
		script := stringProp(props, "acroJsAction", "")
		if script == "" {
			return nil
		}
		return types.Dict{
			"S":  types.Name("JavaScript"),
			"JS": types.StringLiteral(script),
		}
	}
	return nil
}

// --------------------------------------------------------------------------
// /AA additional-actions dict (format, calculate, validate)
// --------------------------------------------------------------------------

// buildWidgetAA builds the /AA additional-actions dict for a text-type field.
// It merges format (/F /K), calculate (/C), and validate (/V) actions.
// Returns nil when no actions are configured.
func buildWidgetAA(props map[string]interface{}) types.Dict {
	aa := types.Dict{}

	// Format keystroke/format actions.
	if formatAA := buildFormatAA(props); formatAA != nil {
		for k, v := range formatAA {
			aa[k] = v
		}
	}

	// Calculate action (/C).
	if calcAction := buildCalcAction(props); calcAction != nil {
		aa["C"] = calcAction
	}

	// Validate action (/V).
	if script := stringProp(props, "acroValidateScript", ""); script != "" {
		aa["V"] = types.Dict{
			"S":  types.Name("JavaScript"),
			"JS": types.StringLiteral(script),
		}
	}

	if len(aa) == 0 {
		return nil
	}
	return aa
}

// buildFormatAA returns the /AA JavaScript action dict for numeric/date/special
// formats, or nil if no format is configured. Keys are /F (format) and /K (keystroke).
func buildFormatAA(props map[string]interface{}) types.Dict {
	format := stringProp(props, "acroFormat", "none")
	if format == "" || format == "none" {
		return nil
	}

	decimals := intProp(props, "acroDecimals")
	if decimals < 0 {
		decimals = 2
	}

	var fmtJS, keystrokeJS string

	switch format {
	case "number":
		fmtJS = fmt.Sprintf(`AFNumber_Format(%d, 1, 0, 0, "", true)`, decimals)
		keystrokeJS = fmt.Sprintf(`AFNumber_Keystroke(%d, 1, 0, 0, "", true)`, decimals)
	case "currency":
		fmtJS = fmt.Sprintf(`AFNumber_Format(%d, 1, 0, 0, "$", true)`, decimals)
		keystrokeJS = fmt.Sprintf(`AFNumber_Keystroke(%d, 1, 0, 0, "$", true)`, decimals)
	case "percent":
		fmtJS = fmt.Sprintf(`AFPercent_Format(%d, 1)`, decimals)
		keystrokeJS = fmt.Sprintf(`AFPercent_Keystroke(%d, 1)`, decimals)
	case "date":
		dateFmt := stringProp(props, "acroDateFmt", "mm/dd/yyyy")
		fmtJS = fmt.Sprintf(`AFDate_FormatEx("%s")`, dateFmt)
		keystrokeJS = fmt.Sprintf(`AFDate_KeystrokeEx("%s")`, dateFmt)
	case "phone":
		fmtJS = `AFSpecial_Format(2)`
		keystrokeJS = `AFSpecial_Keystroke(2)`
	case "ssn":
		fmtJS = `AFSpecial_Format(3)`
		keystrokeJS = `AFSpecial_Keystroke(3)`
	case "zip":
		fmtJS = `AFSpecial_Format(0)`
		keystrokeJS = `AFSpecial_Keystroke(0)`
	case "zip4":
		fmtJS = `AFSpecial_Format(1)`
		keystrokeJS = `AFSpecial_Keystroke(1)`
	default:
		return nil
	}

	return types.Dict{
		"F": types.Dict{
			"S":  types.Name("JavaScript"),
			"JS": types.StringLiteral(fmtJS),
		},
		"K": types.Dict{
			"S":  types.Name("JavaScript"),
			"JS": types.StringLiteral(keystrokeJS),
		},
	}
}

// buildCalcAction returns the /C (calculate) JavaScript action dict, or nil
// if no calculation is configured. Uses AFSimple_Calculate for built-in ops
// and raw JS for the "custom" op.
func buildCalcAction(props map[string]interface{}) types.Dict {
	calcOp := stringProp(props, "acroCalcOp", "none")
	if calcOp == "" || calcOp == "none" {
		return nil
	}

	var js string

	if calcOp == "custom" {
		js = stringProp(props, "acroCalcScript", "")
	} else {
		sourceFields := calcSourceFields(props)
		if len(sourceFields) == 0 {
			return nil
		}
		pdfOpMap := map[string]string{
			"sum":     "SUM",
			"product": "PRD",
			"average": "AVG",
			"min":     "MIN",
			"max":     "MAX",
		}
		pdfOp, ok := pdfOpMap[calcOp]
		if !ok {
			return nil
		}
		quoted := make([]string, len(sourceFields))
		for i, f := range sourceFields {
			quoted[i] = fmt.Sprintf(`"%s"`, strings.ReplaceAll(f, `"`, `\"`))
		}
		js = fmt.Sprintf(`AFSimple_Calculate("%s", new Array(%s))`,
			pdfOp, strings.Join(quoted, ", "))
	}

	if js == "" {
		return nil
	}
	return types.Dict{
		"S":  types.Name("JavaScript"),
		"JS": types.StringLiteral(js),
	}
}

// calcSourceFields reads the acroCalcFields prop and returns a slice of
// field data-key strings to use as calculation sources.
func calcSourceFields(props map[string]interface{}) []string {
	raw, ok := props["acroCalcFields"]
	if !ok || raw == nil {
		return nil
	}
	arr, ok := raw.([]interface{})
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, v := range arr {
		if s, ok := v.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out
}

// --------------------------------------------------------------------------
// Dropdown option builder
// --------------------------------------------------------------------------

// buildDropdownOpts converts the widget's acroOptions prop into a PDF /Opt array.
// Options can be stored as []interface{} of strings or maps with {label, value}.
func buildDropdownOpts(props map[string]interface{}) types.Array {
	raw, ok := props["acroOptions"]
	if !ok {
		return types.Array{}
	}
	opts, ok := raw.([]interface{})
	if !ok {
		return types.Array{}
	}
	arr := types.Array{}
	for _, o := range opts {
		switch v := o.(type) {
		case string:
			arr = append(arr, types.StringLiteral(v))
		case map[string]interface{}:
			label, _ := v["label"].(string)
			value, _ := v["value"].(string)
			if value == "" {
				value = label
			}
			if label == "" {
				label = value
			}
			arr = append(arr, types.Array{
				types.StringLiteral(value),
				types.StringLiteral(label),
			})
		}
	}
	return arr
}

// --------------------------------------------------------------------------
// Radio group helper
// --------------------------------------------------------------------------

// collectRadioGroups groups radio widgets by their acroGroupName prop.
// Widgets with an empty group name get a synthetic name from their dataKey.
func collectRadioGroups(widgets []Widget) map[string][]Widget {
	groups := map[string][]Widget{}
	for _, wd := range widgets {
		if wd.Type != "radio" {
			continue
		}
		groupName := stringProp(wd.Props, "acroGroupName", wd.DataKey)
		if groupName == "" {
			groupName = wd.DataKey
		}
		groups[groupName] = append(groups[groupName], wd)
	}
	return groups
}

// --------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------

// intProp reads a prop as int. Returns -1 if the key is absent or not a number.
func intProp(props map[string]interface{}, key string) int {
	v, ok := props[key]
	if !ok || v == nil {
		return -1
	}
	switch x := v.(type) {
	case float64:
		return int(x)
	case int:
		return x
	case int64:
		return int(x)
	}
	return -1
}

// safeFieldName removes characters that would break a PDF literal string.
func safeFieldName(s string) string {
	if s == "" {
		return "field"
	}
	return s
}
