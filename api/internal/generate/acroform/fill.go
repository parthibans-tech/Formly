package acroform

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/pdfcpu/pdfcpu/pkg/api"
)

// ValidationRule describes per-field validation constraints.
// Mirror of web/components/acroform/types.ts#ValidationRule.
type ValidationRule struct {
	Type       string   `json:"type,omitempty"`
	MinLength  *int     `json:"minLength,omitempty"`
	MaxLength  *int     `json:"maxLength,omitempty"`
	Pattern    string   `json:"pattern,omitempty"`
	Min        *float64 `json:"min,omitempty"`
	Max        *float64 `json:"max,omitempty"`
	MinDate    string   `json:"minDate,omitempty"`
	MaxDate    string   `json:"maxDate,omitempty"`
	Expression string   `json:"expression,omitempty"` // evaluated server-side when possible
	Message    string   `json:"message,omitempty"`
}

// Mapping describes how an input data key maps onto an AcroForm PDF field.
//
// Transform is a json.RawMessage to support both the legacy format
// (plain string op name, e.g. "uppercase") and the structured form
// (JSON object {"op":"...","params":{...}}) or a pipeline (JSON array).
// Decode via parseTransform / parseTransformPipeline.
type Mapping struct {
	DataKey    string          `json:"dataKey"`
	Default    string          `json:"default,omitempty"`
	Required   bool            `json:"required,omitempty"`
	Transform  json.RawMessage `json:"transform,omitempty"`
	Section    string          `json:"section,omitempty"`
	Flatten    *bool           `json:"flatten,omitempty"`
	Validation *ValidationRule `json:"validation,omitempty"`
	FillWhen   string          `json:"fillWhen,omitempty"`
}

// FieldSpec describes a known PDF form field (name + type) as extracted at upload time.
type FieldSpec struct {
	Name string
	Type string
}

// ValidationError is a single field-level failure.
type ValidationError struct {
	Field   string `json:"field"`
	DataKey string `json:"dataKey"`
	Message string `json:"message"`
}

// FillErrors aggregates multiple ValidationErrors so the server can report
// every problem in one response instead of failing on the first.
type FillErrors struct {
	Errors []ValidationError
}

func (e *FillErrors) Error() string {
	if e == nil || len(e.Errors) == 0 {
		return "validation failed"
	}
	parts := make([]string, 0, len(e.Errors))
	for _, ve := range e.Errors {
		parts = append(parts, fmt.Sprintf("%s: %s", ve.DataKey, ve.Message))
	}
	return "validation failed: " + strings.Join(parts, "; ")
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
	var errs []ValidationError

	for _, f := range fields {
		m := mappings[f.Name]
		if m.DataKey == "" {
			m.DataKey = f.Name
		}
		knownKeys[m.DataKey] = true

		// Conditional fill: skip entirely if fillWhen evaluates false.
		if m.FillWhen != "" && !evalFillWhen(m.FillWhen, input) {
			continue
		}

		raw, ok := input[m.DataKey]
		if !ok {
			if m.Required {
				msg := "required"
				if m.Validation != nil && m.Validation.Message != "" {
					msg = m.Validation.Message
				}
				errs = append(errs, ValidationError{Field: f.Name, DataKey: m.DataKey, Message: msg})
				continue
			}
			if m.Default != "" {
				raw = m.Default
			} else {
				continue
			}
		} else if m.Required && isEmptyValue(raw) {
			msg := "required"
			if m.Validation != nil && m.Validation.Message != "" {
				msg = m.Validation.Message
			}
			errs = append(errs, ValidationError{Field: f.Name, DataKey: m.DataKey, Message: msg})
			continue
		}

		// Run validation rule (if any) against the raw input.
		if m.Validation != nil {
			for _, vm := range validateValue(raw, m.Validation) {
				errs = append(errs, ValidationError{Field: f.Name, DataKey: m.DataKey, Message: vm})
			}
		}

		out[f.Name] = applyTransformPipeline(raw, parseTransformPipeline(m.Transform), input)
	}

	// Reject unknown keys so callers get fast feedback on typos.
	for k := range input {
		if !knownKeys[k] {
			errs = append(errs, ValidationError{Field: "", DataKey: k, Message: "unknown data key — not mapped to any field"})
		}
	}

	if len(errs) > 0 {
		return nil, &FillErrors{Errors: errs}
	}
	return out, nil
}

// isEmptyValue returns true for nil, "", whitespace-only strings, or empty slices/maps.
func isEmptyValue(v interface{}) bool {
	switch x := v.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(x) == ""
	case []interface{}:
		return len(x) == 0
	case map[string]interface{}:
		return len(x) == 0
	}
	return false
}

// validateValue returns human-readable error messages for a rule violation.
// Empty values pass — callers handle "required" separately.
func validateValue(v interface{}, r *ValidationRule) []string {
	if r == nil {
		return nil
	}
	if isEmptyValue(v) {
		return nil
	}
	var out []string
	add := func(msg string) {
		if r.Message != "" {
			out = append(out, r.Message)
		} else {
			out = append(out, msg)
		}
	}

	// Type check.
	switch strings.ToLower(r.Type) {
	case "":
		// no type check
	case "string":
		if _, ok := v.(string); !ok {
			add("must be a string")
		}
	case "number":
		if _, ok := toFloat(v); !ok {
			add("must be a number")
		}
	case "boolean":
		if !isBooleanLike(v) {
			add("must be true or false")
		}
	case "date":
		if !isDateLike(v) {
			add("must be a valid date")
		}
	case "email":
		s, _ := stringFromValue(v)
		if !emailRE.MatchString(s) {
			add("must be a valid email")
		}
	case "url":
		s, _ := stringFromValue(v)
		if _, err := url.ParseRequestURI(s); err != nil {
			add("must be a valid URL (include https://)")
		}
	}

	// String constraints.
	if s, ok := v.(string); ok {
		if r.MinLength != nil && len(s) < *r.MinLength {
			add(fmt.Sprintf("must be at least %d characters", *r.MinLength))
		}
		if r.MaxLength != nil && len(s) > *r.MaxLength {
			add(fmt.Sprintf("must be at most %d characters", *r.MaxLength))
		}
		if r.Pattern != "" {
			if re, err := regexp.Compile(r.Pattern); err == nil {
				if !re.MatchString(s) {
					add("does not match the required pattern")
				}
			}
		}
	}

	// Number constraints.
	if r.Min != nil || r.Max != nil {
		if n, ok := toFloat(v); ok {
			if r.Min != nil && n < *r.Min {
				add(fmt.Sprintf("must be ≥ %v", *r.Min))
			}
			if r.Max != nil && n > *r.Max {
				add(fmt.Sprintf("must be ≤ %v", *r.Max))
			}
		}
	}

	// Date constraints.
	if r.MinDate != "" || r.MaxDate != "" {
		if t, ok := parseDate(v); ok {
			if r.MinDate != "" {
				if mn, e := time.Parse("2006-01-02", r.MinDate); e == nil && t.Before(mn) {
					add("must be on or after " + r.MinDate)
				}
			}
			if r.MaxDate != "" {
				if mx, e := time.Parse("2006-01-02", r.MaxDate); e == nil && t.After(mx) {
					add("must be on or before " + r.MaxDate)
				}
			}
		}
	}

	// Expression — best-effort server-side eval (same <path> <op> <literal> grammar).
	if r.Expression != "" {
		row := map[string]interface{}{"$value": v}
		if ok := evalFillWhen(r.Expression, row); !ok {
			add("does not satisfy the custom rule")
		}
	}

	return out
}

var emailRE = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

func isBooleanLike(v interface{}) bool {
	switch x := v.(type) {
	case bool:
		return true
	case string:
		s := strings.ToLower(strings.TrimSpace(x))
		return s == "true" || s == "false" || s == "yes" || s == "no" || s == "on" || s == "off" || s == "1" || s == "0"
	case float64, int, int64:
		return true
	}
	return false
}

func isDateLike(v interface{}) bool {
	_, ok := parseDate(v)
	return ok
}

func parseDate(v interface{}) (time.Time, bool) {
	s, ok := stringFromValue(v)
	if !ok || s == "" {
		return time.Time{}, false
	}
	layouts := []string{
		"2006-01-02",
		"2006-01-02T15:04:05Z07:00",
		time.RFC3339,
		"01/02/2006",
		"02/01/2006",
	}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// evalFillWhen is a minimal Go port of web/lib/schema-utils.ts#evalShowIf.
// Grammar: <path> <op> <literal>  (ops: === == !== != > < >= <=)
// Returns true on empty/parse failure so the field is not accidentally skipped.
var fillWhenRE = regexp.MustCompile(`^([\w.$]+)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$`)

func evalFillWhen(expr string, data map[string]interface{}) bool {
	e := strings.TrimSpace(expr)
	if e == "" {
		return true
	}
	m := fillWhenRE.FindStringSubmatch(e)
	if m == nil {
		return true
	}
	lhs := resolveDataPath(data, m[1])
	rhs := parseLiteral(strings.TrimSpace(m[3]))

	switch m[2] {
	case "===", "==":
		return looseEqual(lhs, rhs)
	case "!==", "!=":
		return !looseEqual(lhs, rhs)
	case ">":
		a, b, ok := numericPair(lhs, rhs)
		return ok && a > b
	case "<":
		a, b, ok := numericPair(lhs, rhs)
		return ok && a < b
	case ">=":
		a, b, ok := numericPair(lhs, rhs)
		return ok && a >= b
	case "<=":
		a, b, ok := numericPair(lhs, rhs)
		return ok && a <= b
	}
	return true
}

func resolveDataPath(data map[string]interface{}, path string) interface{} {
	if path == "" {
		return data
	}
	parts := strings.Split(path, ".")
	var cur interface{} = data
	for _, p := range parts {
		if cur == nil {
			return nil
		}
		m, ok := cur.(map[string]interface{})
		if !ok {
			return nil
		}
		cur = m[p]
	}
	return cur
}

func parseLiteral(s string) interface{} {
	if (strings.HasPrefix(s, `"`) && strings.HasSuffix(s, `"`)) ||
		(strings.HasPrefix(s, `'`) && strings.HasSuffix(s, `'`)) {
		if len(s) >= 2 {
			return s[1 : len(s)-1]
		}
		return ""
	}
	switch s {
	case "true":
		return true
	case "false":
		return false
	case "null":
		return nil
	}
	if n, ok := toFloat(s); ok {
		return n
	}
	return s
}

func looseEqual(a, b interface{}) bool {
	if a == nil || b == nil {
		return a == b
	}
	as, aIsStr := a.(string)
	bs, bIsStr := b.(string)
	if aIsStr && bIsStr {
		return as == bs
	}
	// Compare as numbers when possible.
	if af, aok := toFloat(a); aok {
		if bf, bok := toFloat(b); bok {
			return af == bf
		}
	}
	// Compare as booleans.
	if ab, ok := a.(bool); ok {
		if bb, ok2 := b.(bool); ok2 {
			return ab == bb
		}
	}
	// Fallback: string comparison.
	asStr, _ := stringFromValue(a)
	bsStr, _ := stringFromValue(b)
	return asStr == bsStr
}

func numericPair(a, b interface{}) (float64, float64, bool) {
	af, aok := toFloat(a)
	bf, bok := toFloat(b)
	return af, bf, aok && bok
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
