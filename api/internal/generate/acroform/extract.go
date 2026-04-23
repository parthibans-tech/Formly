package acroform

import (
	"bytes"
	"fmt"

	"github.com/pdfcpu/pdfcpu/pkg/api"
)

type Field struct {
	Name    string   `json:"name"`
	Type    string   `json:"type"`
	Page    int      `json:"page"`
	Default string   `json:"default,omitempty"`
	Value   string   `json:"value,omitempty"`
	Options []string `json:"options,omitempty"`
	Locked  bool     `json:"locked,omitempty"`
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
		out = append(out, Field{
			Name:    f.Name,
			Type:    fmt.Sprint(f.Typ),
			Page:    page,
			Default: f.Dv,
			Value:   f.V,
			Options: opts,
			Locked:  f.Locked,
		})
	}
	return out, nil
}
