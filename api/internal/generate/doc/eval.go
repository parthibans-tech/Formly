package doc

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/docforge/api/internal/i18n"
)

// scope is the data environment threaded through rendering. It tracks the
// parent data map plus any variables introduced by surrounding `repeat`
// blocks (either as top-level shadowing, or under an `as` alias).
//
// Why not just a plain map[string]interface{}?
//   - Repeat blocks can be nested; each level may shadow a key from an outer
//     scope. A linked-list of scopes makes the lookup order obvious.
//   - Aliased iteration (`{"as": "item"}`) needs to expose the iteration
//     value at a specific key without polluting the outer scope.
//   - Error messages can report the full resolution path when a key is
//     missing, which is critical for inline editor diagnostics.
type scope struct {
	parent *scope
	data   map[string]interface{}
	// alias, when non-empty, makes `data` visible only under that key in
	// addition to being merged for top-level lookups. This matches the
	// conventional `{{ range $x := … }}` pattern from Go templates but
	// without the clutter.
	alias string
}

// newRootScope wraps the caller-supplied data in a scope.
func newRootScope(data map[string]interface{}) *scope {
	if data == nil {
		data = map[string]interface{}{}
	}
	return &scope{data: data}
}

// push creates a child scope for an iteration / with-block. If alias is "",
// iteration-item fields are merged into the top-level lookup; if non-empty,
// the item is exposed only under that alias key.
func (s *scope) push(item map[string]interface{}, alias string) *scope {
	return &scope{parent: s, data: item, alias: alias}
}

// resolve walks a dotted path against the scope chain. Returns (value, true)
// when found, (nil, false) otherwise.
//
// Lookup order at each level:
//  1. If an alias is set and the first path segment matches, descend into
//     `data` starting from the second segment.
//  2. Otherwise, treat the entire path as a lookup into `data` at this
//     level.
//  3. If no match, ascend to the parent scope.
//
// This matches what authors expect from Go templates: inner scopes shadow
// outer ones, and `.item.name` vs `.name` both work inside a `range` block.
func (s *scope) resolve(path string) (interface{}, bool) {
	if path == "" || path == "." {
		return s.data, true
	}
	// Accept a leading "." as a convenience for authors who paste from the
	// Go-template world; it's a no-op here.
	path = strings.TrimPrefix(path, ".")
	segs := strings.Split(path, ".")

	for cur := s; cur != nil; cur = cur.parent {
		// Alias-first: .alias.field or just .alias to get the whole item.
		if cur.alias != "" && segs[0] == cur.alias {
			if len(segs) == 1 {
				return cur.data, true
			}
			if v, ok := walkPath(cur.data, segs[1:]); ok {
				return v, true
			}
			// Fall through — the alias was a prefix but the sub-path wasn't
			// found here, keep looking outward (rare but supports authors
			// writing .user.name when .user lives in an outer scope).
		}
		if v, ok := walkPath(cur.data, segs); ok {
			return v, true
		}
	}
	return nil, false
}

// walkPath descends a map/struct using the segment list. Missing keys or
// nil intermediate values short-circuit to (nil, false). Arrays are not
// indexable via this helper — use `repeat` for iteration instead.
func walkPath(root interface{}, segs []string) (interface{}, bool) {
	cur := root
	for _, seg := range segs {
		if cur == nil {
			return nil, false
		}
		switch v := cur.(type) {
		case map[string]interface{}:
			next, ok := v[seg]
			if !ok {
				return nil, false
			}
			cur = next
		default:
			// Fall back to reflection so we can walk struct fields when a
			// caller passes a typed struct (compute.Eval sometimes does).
			rv := reflect.ValueOf(cur)
			if rv.Kind() == reflect.Ptr {
				rv = rv.Elem()
			}
			if rv.Kind() == reflect.Struct {
				f := rv.FieldByName(seg)
				if !f.IsValid() {
					// Case-insensitive fallback for JSON-style keys.
					f = rv.FieldByNameFunc(func(n string) bool {
						return strings.EqualFold(n, seg)
					})
				}
				if !f.IsValid() {
					return nil, false
				}
				cur = f.Interface()
				continue
			}
			return nil, false
		}
	}
	return cur, true
}

// evalCondition evaluates an if-block condition against the current scope.
//
// Error policy: a missing path resolves to nil, which means `defined`→false,
// `truthy`→false, `empty`→true, and comparisons→false. This mirrors Go
// templates' "missingkey=zero" option and keeps authors in control — an
// unresolved path never raises an error; it just takes the else branch.
func evalCondition(c *Condition, s *scope) bool {
	if c == nil {
		return false
	}
	left, _ := s.resolve(c.Left)
	switch c.Op {
	case CondDefined:
		return left != nil
	case CondTruthy:
		return isTruthy(left)
	case CondEmpty:
		return isEmpty(left)
	case CondEq:
		return compareEq(left, c.Right)
	case CondNe:
		return !compareEq(left, c.Right)
	case CondGt:
		return compareNum(left, c.Right) > 0
	case CondGe:
		return compareNum(left, c.Right) >= 0
	case CondLt:
		return compareNum(left, c.Right) < 0
	case CondLe:
		return compareNum(left, c.Right) <= 0
	}
	return false
}

// isTruthy matches the Go-template notion of truthiness so migrated
// templates behave identically: zero values of primitive kinds are false;
// empty collections are false; nil is false; everything else is true.
func isTruthy(v interface{}) bool {
	if v == nil {
		return false
	}
	switch x := v.(type) {
	case bool:
		return x
	case string:
		return x != ""
	case int:
		return x != 0
	case int64:
		return x != 0
	case float64:
		return x != 0
	case float32:
		return x != 0
	case []interface{}:
		return len(x) > 0
	case map[string]interface{}:
		return len(x) > 0
	}
	// Fall through via reflection for typed slices/structs.
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Slice, reflect.Array, reflect.Map:
		return rv.Len() > 0
	case reflect.Ptr, reflect.Interface:
		return !rv.IsNil()
	}
	return true
}

// isEmpty is the inverse of isTruthy for collection-ish values. Kept
// separate because string "0" is truthy-but-non-empty — authors asking for
// "show this when shipping address is blank" want empty-string to match.
func isEmpty(v interface{}) bool {
	if v == nil {
		return true
	}
	switch x := v.(type) {
	case string:
		return x == ""
	case []interface{}:
		return len(x) == 0
	case map[string]interface{}:
		return len(x) == 0
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Slice, reflect.Array, reflect.Map:
		return rv.Len() == 0
	}
	return false
}

// compareEq performs a type-aware equality test.
//
//   - If both sides parse as numbers, compare numerically (so `qty: 1` in
//     JSON matches `right: 1` regardless of int vs float wire encoding).
//   - Booleans compare by value.
//   - Otherwise fall back to string equality via fmt.Sprint.
func compareEq(a, b interface{}) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	if fa, ok := asFloat(a); ok {
		if fb, ok := asFloat(b); ok {
			return fa == fb
		}
	}
	if ba, ok := a.(bool); ok {
		if bb, ok := b.(bool); ok {
			return ba == bb
		}
	}
	return fmt.Sprint(a) == fmt.Sprint(b)
}

// compareNum returns -1 / 0 / +1 for a<b / a==b / a>b; falls back to
// lexicographic string comparison when either side isn't numeric.
func compareNum(a, b interface{}) int {
	fa, okA := asFloat(a)
	fb, okB := asFloat(b)
	if okA && okB {
		switch {
		case fa < fb:
			return -1
		case fa > fb:
			return 1
		default:
			return 0
		}
	}
	sa, sb := fmt.Sprint(a), fmt.Sprint(b)
	return strings.Compare(sa, sb)
}

// asFloat coerces the common numeric shapes seen from JSON / user input
// into a float64, so formatter + comparison logic doesn't have to repeat
// the type-switch ladder.
func asFloat(v interface{}) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int:
		return float64(x), true
	case int32:
		return float64(x), true
	case int64:
		return float64(x), true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return f, err == nil
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	}
	return 0, false
}

// iterItems normalizes a repeat-source value into a slice of per-iteration
// maps. Accepts:
//   - []interface{} of maps → each map is an iteration value
//   - []map[string]interface{} → same
//   - map[string]interface{} → single-item iteration (so a repeat over a
//     single object renders once — useful for reusing the same subtree
//     across presence/absence of nested data)
//   - nil / missing → zero iterations (no output, no error)
//
// Returns nil when the value isn't iterable; the caller treats that as "no
// iterations" silently to match Go-template `range` over missing paths.
func iterItems(v interface{}) []map[string]interface{} {
	if v == nil {
		return nil
	}
	switch x := v.(type) {
	case []interface{}:
		out := make([]map[string]interface{}, 0, len(x))
		for _, it := range x {
			if m, ok := it.(map[string]interface{}); ok {
				out = append(out, m)
				continue
			}
			// Primitive item: wrap it under "_" so authors can reference
			// `.` (the whole item) or a transformation that uses `_`.
			out = append(out, map[string]interface{}{"_": it})
		}
		return out
	case []map[string]interface{}:
		return x
	case map[string]interface{}:
		return []map[string]interface{}{x}
	}
	// Reflect fallback for typed slices.
	rv := reflect.ValueOf(v)
	if rv.Kind() != reflect.Slice && rv.Kind() != reflect.Array {
		return nil
	}
	out := make([]map[string]interface{}, 0, rv.Len())
	for i := 0; i < rv.Len(); i++ {
		it := rv.Index(i).Interface()
		if m, ok := it.(map[string]interface{}); ok {
			out = append(out, m)
		} else {
			out = append(out, map[string]interface{}{"_": it})
		}
	}
	return out
}

// formatField turns a resolved value into the string shown in rendered HTML.
//
// The formatter vocabulary is deliberately small: the common cases are
// covered by explicit, unambiguous shapes; anything unusual is `text` plus
// a `raw` block if the author really needs custom HTML.
//
// `locale` is the doc-level i18n locale, used as a fallback when the
// per-field format doesn't specify its own. `i18nCfg` is accepted for
// future use (currency-symbol overrides etc.); we carry it through so the
// public formatField signature doesn't change when we wire those in.
func formatField(v interface{}, f *FieldFormat, fallback string, locale string, _ i18n.Config) string {
	if v == nil {
		return fallback
	}
	// No format → textual default, best-effort for common primitives.
	if f == nil {
		return defaultStringify(v)
	}
	loc := f.Locale
	if loc == "" {
		loc = locale
	}
	switch f.Kind {
	case FormatText, "":
		return defaultStringify(v)
	case FormatNumber:
		n, ok := asFloat(v)
		if !ok {
			return defaultStringify(v)
		}
		decimals := 0
		if f.Decimals != nil {
			decimals = *f.Decimals
		}
		return i18n.FormatNumber(loc, n, decimals)
	case FormatCurrency:
		n, ok := asFloat(v)
		if !ok {
			return defaultStringify(v)
		}
		code := strings.ToUpper(strings.TrimSpace(f.Code))
		return i18n.FormatCurrency(loc, n, code)
	case FormatPercent:
		n, ok := asFloat(v)
		if !ok {
			return defaultStringify(v)
		}
		decimals := 0
		if f.Decimals != nil {
			decimals = *f.Decimals
		}
		// Accept either 0.15 or 15 — if the value is < 1 we assume it's a
		// proportion and multiply; otherwise treat it as already-in-percent.
		// This matches what most authors mean when they pick "percent".
		if math.Abs(n) <= 1 {
			n *= 100
		}
		return i18n.FormatNumber(loc, n, decimals) + "%"
	case FormatDate:
		t, ok := asTime(v)
		if !ok {
			return defaultStringify(v)
		}
		pattern := f.Pattern
		if pattern == "" {
			pattern = "2006-01-02"
		}
		return i18n.FormatDate(loc, t, pattern)
	}
	return defaultStringify(v)
}

// defaultStringify produces a reasonable string for a value without any
// explicit formatter. Floats drop trailing zeros when integer-valued so
// `amount: 19` doesn't render as `19.000000`.
func defaultStringify(v interface{}) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		if x == math.Trunc(x) && math.Abs(x) < 1e15 {
			return strconv.FormatInt(int64(x), 10)
		}
		return strconv.FormatFloat(x, 'f', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(x), 'f', -1, 32)
	case bool:
		if x {
			return "true"
		}
		return "false"
	case nil:
		return ""
	}
	return fmt.Sprint(v)
}

// asTime coerces common date shapes to time.Time. Accepts:
//   - time.Time (pass-through)
//   - RFC3339 string (most common JSON date encoding)
//   - "YYYY-MM-DD" string
//   - Unix seconds as number
func asTime(v interface{}) (time.Time, bool) {
	switch x := v.(type) {
	case time.Time:
		return x, true
	case string:
		for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05", "2006-01-02"} {
			if t, err := time.Parse(layout, x); err == nil {
				return t, true
			}
		}
	case float64:
		return time.Unix(int64(x), 0), true
	case int64:
		return time.Unix(x, 0), true
	case int:
		return time.Unix(int64(x), 0), true
	}
	return time.Time{}, false
}
