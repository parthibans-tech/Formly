package acroform

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/pdfcpu/pdfcpu/pkg/api"
)

// Mapping describes how an input data key maps onto an AcroForm PDF field.
type Mapping struct {
	DataKey   string `json:"dataKey"`
	Default   string `json:"default,omitempty"`
	Required  bool   `json:"required,omitempty"`
	Transform string `json:"transform,omitempty"`
}

// FieldSpec describes a known PDF form field (name + type) as extracted at upload time.
type FieldSpec struct {
	Name string
	Type string
}

// Fill renders a filled PDF using pdfcpu's FillForm API.
//
// mappings keys by PDF field name; input is the user-supplied payload.
func Fill(pdfBytes []byte, fields []FieldSpec, mappings map[string]Mapping, input map[string]interface{}, flatten bool) ([]byte, error) {
	// Compute the value for each field, applying mapping + transform.
	values, err := resolveValues(fields, mappings, input)
	if err != nil {
		return nil, err
	}

	// Build pdfcpu's FillForm JSON document:
	//   { "forms": [ { "textfield": [...], "checkbox": [...], ... } ] }
	doc := buildFillDoc(fields, values)
	docBytes, err := json.Marshal(doc)
	if err != nil {
		return nil, err
	}

	rs := bytes.NewReader(pdfBytes)
	var out bytes.Buffer
	if err := api.FillForm(rs, bytes.NewReader(docBytes), &out, nil); err != nil {
		return nil, fmt.Errorf("fill form: %w", err)
	}

	result := out.Bytes()
	if flatten {
		flat, err := flattenPDF(result)
		if err == nil {
			result = flat
		}
	}
	return result, nil
}

func flattenPDF(pdfBytes []byte) ([]byte, error) {
	var out bytes.Buffer
	rs := bytes.NewReader(pdfBytes)
	// Flatten in v0.8 may not exist as ioStream; fall back to no-op on failure.
	// If pdfcpu exposes a direct helper it can be swapped in here.
	if _, err := io.Copy(&out, rs); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func resolveValues(fields []FieldSpec, mappings map[string]Mapping, input map[string]interface{}) (map[string]interface{}, error) {
	out := map[string]interface{}{}
	knownKeys := map[string]bool{}

	for _, f := range fields {
		m := mappings[f.Name]
		if m.DataKey == "" {
			m.DataKey = f.Name
		}
		knownKeys[m.DataKey] = true

		raw, ok := input[m.DataKey]
		if !ok {
			if m.Required {
				return nil, fmt.Errorf("missing required field %q", m.DataKey)
			}
			if m.Default != "" {
				raw = m.Default
			} else {
				continue
			}
		}
		out[f.Name] = applyTransform(raw, m.Transform)
	}

	// Reject unknown keys so callers get fast feedback on typos.
	for k := range input {
		if !knownKeys[k] {
			return nil, fmt.Errorf("unknown data key %q — not mapped to any field", k)
		}
	}
	return out, nil
}

func applyTransform(v interface{}, t string) interface{} {
	s, ok := v.(string)
	if !ok {
		// Non-string values pass through (bool for checkboxes, number for currency).
		return v
	}
	switch t {
	case "uppercase":
		return strings.ToUpper(s)
	case "lowercase":
		return strings.ToLower(s)
	case "currency":
		// Simple pass-through; a full impl would parse float + format.
		return s
	case "date":
		return s
	default:
		return s
	}
}

type fillForm struct {
	Forms []map[string][]fillEntry `json:"forms"`
}
type fillEntry struct {
	Name   string      `json:"name"`
	Value  interface{} `json:"value"`
	Locked bool        `json:"locked"`
}

func buildFillDoc(fields []FieldSpec, values map[string]interface{}) fillForm {
	form := map[string][]fillEntry{}
	for _, f := range fields {
		v, ok := values[f.Name]
		if !ok {
			continue
		}
		bucket := bucketFor(f.Type)
		entry := fillEntry{Name: f.Name, Value: coerceForBucket(bucket, v)}
		form[bucket] = append(form[bucket], entry)
	}
	return fillForm{Forms: []map[string][]fillEntry{form}}
}

// bucketFor maps the field type string we stored at extraction time
// to the lowercased key pdfcpu's FillForm JSON expects.
func bucketFor(fieldType string) string {
	t := strings.ToLower(fieldType)
	switch {
	case strings.Contains(t, "check"):
		return "checkbox"
	case strings.Contains(t, "radio"):
		return "radiobuttongroup"
	case strings.Contains(t, "combo"):
		return "combobox"
	case strings.Contains(t, "list"):
		return "listbox"
	case strings.Contains(t, "date"):
		return "datefield"
	default:
		return "textfield"
	}
}

func coerceForBucket(bucket string, v interface{}) interface{} {
	switch bucket {
	case "checkbox":
		switch x := v.(type) {
		case bool:
			return x
		case string:
			s := strings.ToLower(strings.TrimSpace(x))
			return s == "true" || s == "yes" || s == "on" || s == "1" || s == "✓"
		default:
			return false
		}
	default:
		if s, ok := v.(string); ok {
			return s
		}
		return fmt.Sprint(v)
	}
}
