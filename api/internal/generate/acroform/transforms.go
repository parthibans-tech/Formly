package acroform

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Transform is a structured description of a value transformation applied to
// a PDF field's incoming data. A Transform with an empty Op is a no-op.
type Transform struct {
	Op     string                 `json:"op,omitempty"`
	Params map[string]interface{} `json:"params,omitempty"`
}

// parseTransform decodes a Mapping.Transform raw message into a Transform.
// The raw message may be:
//   - absent/null → {Op: "none"}
//   - a JSON string (legacy) → {Op: <string>}
//   - a JSON object → unmarshaled directly
func parseTransform(raw json.RawMessage) Transform {
	if len(raw) == 0 {
		return Transform{Op: "none"}
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "null" || trimmed == "" {
		return Transform{Op: "none"}
	}
	if trimmed[0] == '"' {
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			return Transform{Op: s}
		}
	}
	var t Transform
	if err := json.Unmarshal(raw, &t); err == nil {
		return t
	}
	return Transform{Op: "none"}
}

// applyTransformV2 applies the structured transform to a value. row is the
// full input map — used by ops like "template" and "concat" that reference
// other fields.
func applyTransformV2(v interface{}, t Transform, row map[string]interface{}) interface{} {
	s, isString := stringFromValue(v)

	switch strings.ToLower(t.Op) {
	case "", "none":
		return v
	case "uppercase":
		if isString {
			return strings.ToUpper(s)
		}
		return v
	case "lowercase":
		if isString {
			return strings.ToLower(s)
		}
		return v
	case "titlecase":
		if isString {
			return strings.Title(strings.ToLower(s))
		}
		return v
	case "trim":
		if isString {
			return strings.TrimSpace(s)
		}
		return v
	case "template":
		pattern, _ := t.Params["pattern"].(string)
		return renderTemplate(pattern, row)
	case "date-format":
		from, _ := t.Params["from"].(string)
		to, _ := t.Params["to"].(string)
		return formatDate(s, from, to)
	case "number-format":
		return formatNumber(v, t.Params)
	case "lookup":
		if mp, ok := t.Params["map"].(map[string]interface{}); ok {
			if out, ok := mp[s].(string); ok {
				return out
			}
		}
		if def, ok := t.Params["default"].(string); ok {
			return def
		}
		return s
	case "concat":
		fields, _ := t.Params["fields"].([]interface{})
		sep, _ := t.Params["sep"].(string)
		var parts []string
		for _, fld := range fields {
			if key, ok := fld.(string); ok {
				if val, present := row[key]; present {
					if str, ok2 := stringFromValue(val); ok2 {
						parts = append(parts, str)
					}
				}
			}
		}
		return strings.Join(parts, sep)
	case "substring":
		start := intParam(t.Params, "start", 0)
		end := intParam(t.Params, "end", -1)
		if !isString {
			return v
		}
		runes := []rune(s)
		if start < 0 {
			start = 0
		}
		if start > len(runes) {
			return ""
		}
		if end < 0 || end > len(runes) {
			end = len(runes)
		}
		if end < start {
			return ""
		}
		return string(runes[start:end])
	case "replace":
		pattern, _ := t.Params["pattern"].(string)
		replacement, _ := t.Params["replacement"].(string)
		if pattern == "" || !isString {
			return s
		}
		re, err := regexp.Compile(pattern)
		if err != nil {
			return s
		}
		return re.ReplaceAllString(s, replacement)
	case "boolean-label":
		truthy, _ := t.Params["truthy"].(string)
		falsy, _ := t.Params["falsy"].(string)
		if boolFromValue(v) {
			return truthy
		}
		return falsy
	}

	return v
}

// --- helpers ---

func stringFromValue(v interface{}) (string, bool) {
	switch x := v.(type) {
	case string:
		return x, true
	case fmt.Stringer:
		return x.String(), true
	case nil:
		return "", false
	default:
		return fmt.Sprint(v), false
	}
}

func boolFromValue(v interface{}) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		s := strings.ToLower(strings.TrimSpace(x))
		return s == "true" || s == "yes" || s == "on" || s == "1"
	case float64:
		return x != 0
	case int:
		return x != 0
	}
	return false
}

func intParam(params map[string]interface{}, key string, def int) int {
	if v, ok := params[key]; ok {
		switch x := v.(type) {
		case float64:
			return int(x)
		case int:
			return x
		case string:
			if n, err := strconv.Atoi(x); err == nil {
				return n
			}
		}
	}
	return def
}

func floatParam(params map[string]interface{}, key string, def float64) float64 {
	if v, ok := params[key]; ok {
		switch x := v.(type) {
		case float64:
			return x
		case int:
			return float64(x)
		case string:
			if n, err := strconv.ParseFloat(x, 64); err == nil {
				return n
			}
		}
	}
	return def
}

func boolParam(params map[string]interface{}, key string, def bool) bool {
	if v, ok := params[key]; ok {
		if b, ok := v.(bool); ok {
			return b
		}
	}
	return def
}

// renderTemplate expands {key} placeholders against the row map.
var tplRE = regexp.MustCompile(`\{([^}]+)\}`)

func renderTemplate(pattern string, row map[string]interface{}) string {
	return tplRE.ReplaceAllStringFunc(pattern, func(match string) string {
		key := strings.TrimSpace(match[1 : len(match)-1])
		if v, ok := row[key]; ok {
			s, _ := stringFromValue(v)
			return s
		}
		return ""
	})
}

// formatDate parses an input date according to 'from' and re-emits it per 'to'.
// Supports Go layouts plus a small set of friendly aliases.
func formatDate(in, from, to string) string {
	if in == "" {
		return ""
	}
	fromLayout := dateLayout(from)
	toLayout := dateLayout(to)
	t, err := time.Parse(fromLayout, in)
	if err != nil {
		// Try common fallback layouts.
		for _, layout := range []string{time.RFC3339, "2006-01-02", "2006-01-02T15:04:05Z07:00"} {
			if t, err = time.Parse(layout, in); err == nil {
				break
			}
		}
		if err != nil {
			return in
		}
	}
	return t.Format(toLayout)
}

func dateLayout(alias string) string {
	switch strings.ToLower(alias) {
	case "", "iso", "iso8601":
		return "2006-01-02"
	case "rfc3339":
		return time.RFC3339
	case "mm/dd/yyyy":
		return "01/02/2006"
	case "dd/mm/yyyy":
		return "02/01/2006"
	case "yyyy-mm-dd":
		return "2006-01-02"
	case "mm-dd-yyyy":
		return "01-02-2006"
	case "long":
		return "January 2, 2006"
	case "short":
		return "Jan 2, 2006"
	default:
		// Assume the caller passed a valid Go reference layout.
		return alias
	}
}

// formatNumber formats a numeric-ish value per decimal/thousands/prefix/suffix params.
func formatNumber(v interface{}, params map[string]interface{}) string {
	f, ok := toFloat(v)
	if !ok {
		s, _ := stringFromValue(v)
		return s
	}
	decimals := intParam(params, "decimals", 2)
	thousands := boolParam(params, "thousands", false)
	prefix, _ := params["prefix"].(string)
	suffix, _ := params["suffix"].(string)

	out := strconv.FormatFloat(f, 'f', decimals, 64)
	if thousands {
		out = addThousands(out)
	}
	return prefix + out + suffix
}

func toFloat(v interface{}) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case string:
		// Strip common currency symbols/commas before parsing.
		s := strings.TrimSpace(x)
		s = strings.ReplaceAll(s, ",", "")
		s = strings.TrimLeft(s, "$€£¥")
		if n, err := strconv.ParseFloat(s, 64); err == nil {
			return n, true
		}
	}
	return 0, false
}

func addThousands(s string) string {
	// Handle optional decimal part.
	neg := strings.HasPrefix(s, "-")
	if neg {
		s = s[1:]
	}
	intPart, fracPart := s, ""
	if dot := strings.IndexByte(s, '.'); dot != -1 {
		intPart = s[:dot]
		fracPart = s[dot:]
	}
	n := len(intPart)
	if n <= 3 {
		if neg {
			return "-" + intPart + fracPart
		}
		return intPart + fracPart
	}
	var out strings.Builder
	firstLen := n % 3
	if firstLen == 0 {
		firstLen = 3
	}
	out.WriteString(intPart[:firstLen])
	for i := firstLen; i < n; i += 3 {
		out.WriteByte(',')
		out.WriteString(intPart[i : i+3])
	}
	out.WriteString(fracPart)
	if neg {
		return "-" + out.String()
	}
	return out.String()
}
