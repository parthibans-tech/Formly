// Package compute evaluates user-defined computed fields on top of the data
// payload, so templates can reference `{{ .subtotal }}` without repeating the
// sum() math in every mention. Evaluation uses expr-lang/expr — a safe,
// sandboxed DSL (no I/O, no reflection escape hatches).
package compute

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/expr-lang/expr"
	"github.com/expr-lang/expr/vm"
)

// Definition is a single computed field: `name` is the key exposed to the
// template, `expression` is the expr-lang source evaluated against the current
// environment.
type Definition struct {
	Name       string `json:"name"`
	Expression string `json:"expression"`
}

// FromConfig extracts the list of computed definitions (if any) from a
// template's config_json bytes.
func FromConfig(cfg []byte) []Definition {
	if len(cfg) == 0 {
		return nil
	}
	var wrapper struct {
		Computed []Definition `json:"computed"`
	}
	if err := json.Unmarshal(cfg, &wrapper); err != nil {
		return nil
	}
	return wrapper.Computed
}

// Eval walks the definitions in order, running each expression against the
// current environment (original data + any already-computed fields), and
// returns a new map merging data + computed values.
//
// Errors from individual expressions are captured and returned alongside a
// best-effort evaluated map so the caller (preview / generate) can still render
// as much as possible.
func Eval(defs []Definition, data map[string]interface{}) (map[string]interface{}, map[string]string) {
	out := make(map[string]interface{}, len(data)+len(defs))
	for k, v := range data {
		out[k] = v
	}
	errors := map[string]string{}
	for _, d := range defs {
		name := strings.TrimSpace(d.Name)
		if name == "" {
			continue
		}
		env := buildEnv(out)
		prog, err := expr.Compile(d.Expression, expr.Env(env), expr.AllowUndefinedVariables())
		if err != nil {
			errors[name] = "compile: " + err.Error()
			continue
		}
		val, err := runSafe(prog, env)
		if err != nil {
			errors[name] = "run: " + err.Error()
			continue
		}
		out[name] = val
	}
	return out, errors
}

// runSafe executes the compiled program and recovers from any panic expr
// itself doesn't catch (keeps the server robust against malformed user input).
func runSafe(prog *vm.Program, env map[string]interface{}) (result interface{}, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic: %v", r)
		}
	}()
	return expr.Run(prog, env)
}

// buildEnv merges user data with a curated set of helper functions that mirror
// the template helper vocabulary so authors don't context-switch between the
// two surfaces.
func buildEnv(data map[string]interface{}) map[string]interface{} {
	env := make(map[string]interface{}, len(data)+16)
	for k, v := range data {
		env[k] = v
	}

	// Numeric helpers — operate on []any of numbers or []map with a field.
	env["sum"] = sumAny
	env["avg"] = avgAny
	env["min_"] = minAny
	env["max_"] = maxAny
	env["len_"] = lenAny
	env["count"] = lenAny

	// String helpers.
	env["upper"] = strings.ToUpper
	env["lower"] = strings.ToLower
	env["trim"] = strings.TrimSpace

	// Date helpers.
	env["now"] = func() time.Time { return time.Now() }
	env["today"] = func() time.Time {
		t := time.Now()
		return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
	}
	env["parseDate"] = parseDate
	env["addDays"] = addDays
	env["diffDays"] = diffDays

	// Logical fallback.
	env["default_"] = func(def, v interface{}) interface{} {
		if v == nil {
			return def
		}
		if s, ok := v.(string); ok && s == "" {
			return def
		}
		return v
	}
	return env
}

// -- helpers ---------------------------------------------------------------

func sumAny(args ...interface{}) float64 {
	if len(args) == 0 {
		return 0
	}
	// sum([numbers])
	if len(args) == 1 {
		if slice, ok := toSlice(args[0]); ok {
			total := 0.0
			for _, v := range slice {
				if f, ok := toFloat(v); ok {
					total += f
				}
			}
			return total
		}
		if f, ok := toFloat(args[0]); ok {
			return f
		}
		return 0
	}
	// sum([maps], "field")
	if slice, ok := toSlice(args[0]); ok {
		if field, ok := args[1].(string); ok {
			total := 0.0
			for _, v := range slice {
				if m, ok := v.(map[string]interface{}); ok {
					if f, ok := toFloat(m[field]); ok {
						total += f
					}
				}
			}
			return total
		}
	}
	// sum(1, 2, 3)
	total := 0.0
	for _, a := range args {
		if f, ok := toFloat(a); ok {
			total += f
		}
	}
	return total
}

func avgAny(args ...interface{}) float64 {
	if len(args) == 0 {
		return 0
	}
	if len(args) == 1 {
		if slice, ok := toSlice(args[0]); ok && len(slice) > 0 {
			return sumAny(slice) / float64(len(slice))
		}
	}
	if len(args) == 2 {
		if slice, ok := toSlice(args[0]); ok && len(slice) > 0 {
			return sumAny(slice, args[1]) / float64(len(slice))
		}
	}
	return 0
}

func minAny(args ...interface{}) float64 {
	return extreme(args, true)
}

func maxAny(args ...interface{}) float64 {
	return extreme(args, false)
}

func extreme(args []interface{}, takeMin bool) float64 {
	if len(args) == 0 {
		return 0
	}
	var seen bool
	var best float64
	walk := func(v interface{}) {
		f, ok := toFloat(v)
		if !ok {
			return
		}
		if !seen {
			best = f
			seen = true
			return
		}
		if takeMin {
			if f < best {
				best = f
			}
		} else {
			if f > best {
				best = f
			}
		}
	}
	if len(args) == 1 {
		if slice, ok := toSlice(args[0]); ok {
			for _, v := range slice {
				walk(v)
			}
			return best
		}
	}
	for _, a := range args {
		walk(a)
	}
	return best
}

func lenAny(v interface{}) int {
	if s, ok := v.(string); ok {
		return len(s)
	}
	if slice, ok := toSlice(v); ok {
		return len(slice)
	}
	if m, ok := v.(map[string]interface{}); ok {
		return len(m)
	}
	return 0
}

func parseDate(s string) (time.Time, error) {
	for _, layout := range []string{
		time.RFC3339,
		"2006-01-02T15:04:05Z",
		"2006-01-02",
		"01/02/2006",
		"02/01/2006",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("unrecognized date format: %q", s)
}

func addDays(t time.Time, n int) time.Time {
	return t.AddDate(0, 0, n)
}

func diffDays(a, b time.Time) int {
	return int(a.Sub(b).Hours() / 24)
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
	case uint:
		return float64(x), true
	case uint64:
		return float64(x), true
	case string:
		var f float64
		if _, err := fmt.Sscanf(x, "%f", &f); err == nil {
			return f, true
		}
	}
	return 0, false
}

func toSlice(v interface{}) ([]interface{}, bool) {
	switch x := v.(type) {
	case []interface{}:
		return x, true
	case []map[string]interface{}:
		out := make([]interface{}, 0, len(x))
		for _, it := range x {
			out = append(out, it)
		}
		return out, true
	}
	return nil, false
}
