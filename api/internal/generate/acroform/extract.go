package acroform

import (
	"bytes"
	"fmt"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

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

// Extract parses a PDF from the given bytes and returns its AcroForm fields.
// Returns an empty slice if the PDF has no form fields or is not a form PDF.
func Extract(data []byte) ([]Field, error) {
	rs := bytes.NewReader(data)
	ff, err := api.FormFields(rs, nil)
	if err != nil {
		// Treat parse errors as "no fields" — not every PDF is an AcroForm.
		return []Field{}, nil
	}

	// Walk /Annots for geometry & flags; best-effort (ignore walk errors).
	geomByName := map[string]widgetGeom{}
	if _, seekErr := rs.Seek(0, 0); seekErr == nil {
		conf := model.NewDefaultConfiguration()
		conf.ValidationMode = model.ValidationRelaxed
		if ctx, ctxErr := api.ReadContext(rs, conf); ctxErr == nil && ctx != nil {
			geomByName = extractWidgetGeom(ctx.XRefTable)
		}
	}

	out := make([]Field, 0, len(ff))
	for _, f := range ff {
		page := 0
		if len(f.Pages) > 0 {
			page = f.Pages[0]
		}
		var opts []string
		if f.Opts != "" {
			opts = []string{f.Opts}
		}
		field := Field{
			Name:    f.Name,
			Type:    fmt.Sprint(f.Typ),
			Page:    page,
			Default: f.Dv,
			Value:   f.V,
			Options: opts,
			Locked:  f.Locked,
		}
		if g, ok := geomByName[f.Name]; ok {
			if g.rect != nil {
				field.Rect = g.rect
			}
			if g.pageSize != nil {
				field.PageSize = g.pageSize
			}
			if g.page > 0 && page == 0 {
				field.Page = g.page
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
		}
		out = append(out, field)
	}
	return out, nil
}
