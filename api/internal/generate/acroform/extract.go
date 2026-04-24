package acroform

import (
	"bytes"
	"fmt"
	"log"
	"os"
	"sort"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

// debugf logs when ACROFORM_DEBUG=1 is set. Enable with:
//
//	ACROFORM_DEBUG=1 go run ./cmd/api
func debugf(format string, args ...any) {
	if os.Getenv("ACROFORM_DEBUG") == "1" {
		log.Printf("[acroform.Extract] "+format, args...)
	}
}

func fmtRect(r *Rect) string {
	if r == nil {
		return "nil"
	}
	return fmt.Sprintf("[x=%.1f y=%.1f w=%.1f h=%.1f]", r.X, r.Y, r.W, r.H)
}

func fmtSize(s *Size) string {
	if s == nil {
		return "nil"
	}
	return fmt.Sprintf("[w=%.1f h=%.1f]", s.W, s.H)
}

// Rect is a PDF user-space rectangle (bottom-left origin).
type Rect struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// Size is a page dimension (user-space).
type Size struct {
	W float64 `json:"w"`
	H float64 `json:"h"`
}

type Field struct {
	Name    string   `json:"name"`
	Type    string   `json:"type"`
	Page    int      `json:"page"`
	Default string   `json:"default,omitempty"`
	Value   string   `json:"value,omitempty"`
	Options []string `json:"options,omitempty"`
	Locked  bool     `json:"locked,omitempty"`

	// Geometry & metadata from walking /Annots.
	Rect        *Rect  `json:"rect,omitempty"`
	PageSize    *Size  `json:"pageSize,omitempty"`
	Flags       int    `json:"flags,omitempty"`
	MaxLen      int    `json:"maxLen,omitempty"`
	Tooltip     string `json:"tooltip,omitempty"`
	ReadOnly    bool   `json:"readOnly,omitempty"`
	Required    bool   `json:"required,omitempty"`
	Multiline   bool   `json:"multiline,omitempty"`
	Password    bool   `json:"password,omitempty"`
	Comb        bool   `json:"comb,omitempty"`
	Combo       bool   `json:"combo,omitempty"`
	MultiSelect bool   `json:"multiSelect,omitempty"`
}

// Extract parses a PDF and returns its AcroForm fields.
//
// Primary source: walking page /Annots for widgets (gives name + rect +
// flags + type all from the same dict — no cross-API join risk).
//
// Supplement: api.FormFields fills in Default/Value/Locked for any fields
// the primary walk missed (rare — mostly non-widget leaves).
//
// Returns an empty slice if the PDF has no form fields.
func Extract(data []byte) ([]Field, error) {
	rs := bytes.NewReader(data)

	// Primary — /Annots walk.
	geomByName := map[string]widgetGeom{}
	conf := model.NewDefaultConfiguration()
	conf.ValidationMode = model.ValidationRelaxed
	if ctx, ctxErr := api.ReadContext(rs, conf); ctxErr == nil && ctx != nil {
		// api.ReadContext leaves PageCount=0 until the page tree is walked.
		// Both walkers short-circuit on PageCount==0, so force it here.
		if ctx.XRefTable != nil {
			_ = ctx.XRefTable.EnsurePageCount()
			debugf("ctx ready: pages=%d", ctx.XRefTable.PageCount)
		}
		geomByName = extractWidgetGeom(ctx.XRefTable)
		debugf("/Annots walker found %d widgets", len(geomByName))
		for name, g := range geomByName {
			debugf("  annot: name=%q type=%q page=%d rect=%v pageSize=%v",
				name, g.fieldType, g.page, fmtRect(g.rect), fmtSize(g.pageSize))
		}

		// Fallback — if the page /Annots walk missed widgets (PDFs with
		// malformed /Annots references, or fields defined only in
		// /AcroForm/Fields), traverse the form tree directly and fill in
		// any names we didn't already get OR enrich entries missing rect/page.
		pageIdx, pageSizes := buildPageIndex(ctx.XRefTable)
		formGeom := walkAcroFormFields(ctx.XRefTable, pageIdx, pageSizes)
		debugf("/AcroForm/Fields walker found %d entries", len(formGeom))
		for name, g := range formGeom {
			existing, exists := geomByName[name]
			if !exists {
				geomByName[name] = g
				debugf("  form-added: name=%q type=%q page=%d rect=%v pageSize=%v",
					name, g.fieldType, g.page, fmtRect(g.rect), fmtSize(g.pageSize))
				continue
			}
			// Enrich: prefer whichever source has richer data.
			if existing.rect == nil && g.rect != nil {
				existing.rect = g.rect
				debugf("  form-enriched rect: name=%q", name)
			}
			if existing.page == 0 && g.page != 0 {
				existing.page = g.page
				debugf("  form-enriched page: name=%q page=%d", name, g.page)
			}
			if existing.pageSize == nil && g.pageSize != nil {
				existing.pageSize = g.pageSize
			}
			if existing.fieldType == "" && g.fieldType != "" {
				existing.fieldType = g.fieldType
			}
			geomByName[name] = existing
		}
	}

	// Supplement — pdfcpu's FormFields for DV/V/Locked that the walk doesn't carry.
	supplement := map[string]formFieldSupplement{}
	if _, seekErr := rs.Seek(0, 0); seekErr == nil {
		if ff, err := api.FormFields(rs, nil); err == nil {
			debugf("api.FormFields returned %d fields", len(ff))
			for _, f := range ff {
				page := 0
				if len(f.Pages) > 0 {
					page = f.Pages[0]
				}
				var opts []string
				if f.Opts != "" {
					opts = []string{f.Opts}
				}
				supplement[f.Name] = formFieldSupplement{
					typ:     fmt.Sprint(f.Typ),
					page:    page,
					def:     f.Dv,
					val:     f.V,
					options: opts,
					locked:  f.Locked,
				}
			}
		}
	}

	// Build fields, preferring primary walk data.
	names := make([]string, 0, len(geomByName))
	for name := range geomByName {
		names = append(names, name)
	}
	sort.Strings(names)

	out := make([]Field, 0, len(names))
	seen := map[string]bool{}
	for _, name := range names {
		g := geomByName[name]
		sup := supplement[name] // may be zero value

		field := Field{
			Name:    name,
			Type:    preferString(g.fieldType, sup.typ),
			Page:    firstNonZero(g.page, sup.page),
			Default: preferString(g.defVal, sup.def),
			Value:   preferString(g.value, sup.val),
			Options: preferOptions(g.options, sup.options),
			Locked:  sup.locked,
		}
		if g.rect != nil {
			field.Rect = g.rect
		}
		if g.pageSize != nil {
			field.PageSize = g.pageSize
		}
		field.Flags = g.flags
		field.MaxLen = g.maxLen
		field.Tooltip = g.tooltip
		field.ReadOnly = g.flags&(1<<0) != 0
		field.Required = g.flags&(1<<1) != 0
		field.Multiline = g.flags&(1<<12) != 0
		field.Password = g.flags&(1<<13) != 0
		field.Comb = g.flags&(1<<24) != 0
		field.Combo = g.flags&(1<<17) != 0
		field.MultiSelect = g.flags&(1<<21) != 0
		out = append(out, field)
		seen[name] = true
	}

	// Fallback: any supplement-only entries (non-widget leaf fields) become
	// fields without geometry — at least they're visible in the binding UI.
	supplementOnly := 0
	for name, sup := range supplement {
		if seen[name] {
			continue
		}
		supplementOnly++
		debugf("  supplement-only: name=%q page=%d (NO rect — won't render overlay)", name, sup.page)
		out = append(out, Field{
			Name:    name,
			Type:    sup.typ,
			Page:    sup.page,
			Default: sup.def,
			Value:   sup.val,
			Options: sup.options,
			Locked:  sup.locked,
		})
	}

	// Summary — count fields with/without rect so we can see at a glance
	// how many will render as overlays vs list-only.
	withRect, withoutRect := 0, 0
	for _, f := range out {
		if f.Rect != nil {
			withRect++
		} else {
			withoutRect++
		}
	}
	debugf("TOTAL: %d fields → %d with rect (render as overlay), %d without rect (list only), %d supplement-only",
		len(out), withRect, withoutRect, supplementOnly)

	return out, nil
}

type formFieldSupplement struct {
	typ     string
	page    int
	def     string
	val     string
	options []string
	locked  bool
}

func preferString(primary, fallback string) string {
	if primary != "" {
		return primary
	}
	return fallback
}

func preferOptions(primary, fallback []string) []string {
	if len(primary) > 0 {
		return primary
	}
	return fallback
}

func firstNonZero(a, b int) int {
	if a != 0 {
		return a
	}
	return b
}
