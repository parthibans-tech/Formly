// Package html implements the HTML-to-PDF generation mode.
//
// Substitution runs in Go (stdlib html/template) so that user data is HTML-escaped
// and Chromium only ever sees finalized markup. Rendering uses chromedp driving a
// locally-discovered Chromium binary. In production, swap to a remote pool via
// chromedp.NewRemoteAllocator.
package html

import (
	"bytes"
	"context"
	"fmt"
	htmltemplate "html/template"
	"log/slog"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"text/template/parse"
	"time"

	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"
	"github.com/docforge/api/internal/i18n"
	"github.com/docforge/api/internal/layout"
)

// defaultRenderTimeout is the wall-clock budget for a single Chromium
// render (launch + navigation + print-to-pdf). 60s is generous for the
// typical single-page document and still well under the 90s HTTP
// request ceiling. Override via CHROMIUM_RENDER_TIMEOUT=<seconds> when
// running on a slow host or rendering very heavy templates.
const defaultRenderTimeout = 60 * time.Second

// renderTimeout resolves the effective render budget. Parses the env
// override as an integer number of seconds; falls back to the default
// on parse failure or missing value so a typo can't break production.
func renderTimeout() time.Duration {
	if s := os.Getenv("CHROMIUM_RENDER_TIMEOUT"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
	}
	return defaultRenderTimeout
}

// ExtractPlaceholders returns the unique top-level field names referenced by
// the template source. Dotted paths at the root (e.g. `customer.email`) are
// preserved. Fields referenced inside a `range`/`with` scope are NOT returned
// as top-level placeholders — they belong to the parent scope.
//
// If the template has syntax errors we fall back to the regex extractor so
// the UI stays responsive while the author types.
func ExtractPlaceholders(src string) []string {
	s, err := ExtractSchema(src)
	if err != nil {
		return regexExtract(src)
	}
	out := append([]string{}, s.Fields...)
	for _, l := range s.Loops {
		out = append(out, l.Path)
	}
	// de-dupe while preserving order
	seen := map[string]bool{}
	uniq := out[:0]
	for _, n := range out {
		if seen[n] {
			continue
		}
		seen[n] = true
		uniq = append(uniq, n)
	}
	sort.Strings(uniq)
	return uniq
}

// LoopInfo describes a single `range` or `with` scope.
type LoopInfo struct {
	Path   string   // top-level path being iterated / scoped
	Fields []string // field names referenced inside the scope (relative)
}

// Schema is the structured result of AST-walking a template.
type Schema struct {
	Fields []string   // top-level fields (sorted, unique)
	Loops  []LoopInfo // ranges + withs (unique by Path)
}

// ExtractSchema parses the template and walks its AST to collect referenced
// fields grouped by scope.
func ExtractSchema(src string) (Schema, error) {
	var empty Schema
	// parse.Parse is the lowest-level Go template parser; we reuse the same
	// set of left/right delimiters and functions that html/template uses.
	trees, err := parse.Parse("doc", src, "", "", builtinFuncsForParse())
	if err != nil {
		return empty, err
	}
	tree := trees["doc"]
	if tree == nil || tree.Root == nil {
		return empty, nil
	}
	w := &walker{
		fields: map[string]bool{},
		loops:  map[string][]string{},
	}
	w.walk(tree.Root, nil)
	s := Schema{}
	for f := range w.fields {
		s.Fields = append(s.Fields, f)
	}
	sort.Strings(s.Fields)
	for path, fields := range w.loops {
		sort.Strings(fields)
		s.Loops = append(s.Loops, LoopInfo{Path: path, Fields: fields})
	}
	sort.Slice(s.Loops, func(i, j int) bool { return s.Loops[i].Path < s.Loops[j].Path })
	return s, nil
}

// walker recursively walks the AST, tracking the current scope chain (a list
// of top-level paths entered by `range` / `with`).
type walker struct {
	fields map[string]bool     // top-level field references (not inside any scope)
	loops  map[string][]string // scopePath -> list of relative field references
}

func (w *walker) walk(node parse.Node, scope []string) {
	switch n := node.(type) {
	case *parse.ListNode:
		if n == nil {
			return
		}
		for _, c := range n.Nodes {
			w.walk(c, scope)
		}
	case *parse.ActionNode:
		for _, p := range fieldsInPipe(n.Pipe) {
			w.recordField(p, scope)
		}
	case *parse.IfNode:
		for _, p := range fieldsInPipe(n.Pipe) {
			w.recordField(p, scope)
		}
		w.walk(n.List, scope)
		if n.ElseList != nil {
			w.walk(n.ElseList, scope)
		}
	case *parse.RangeNode:
		// The pipe is the value being iterated (e.g. `.items`).
		scopePaths := fieldsInPipe(n.Pipe)
		var loopPath string
		if len(scopePaths) > 0 {
			loopPath = scopePaths[0]
			// Record the outer path so {{range .items}} surfaces `items`.
			w.recordField(loopPath, scope)
		}
		childScope := scope
		if loopPath != "" {
			childScope = append(append([]string{}, scope...), loopPath)
		}
		w.walk(n.List, childScope)
		if n.ElseList != nil {
			w.walk(n.ElseList, scope)
		}
	case *parse.WithNode:
		scopePaths := fieldsInPipe(n.Pipe)
		var loopPath string
		if len(scopePaths) > 0 {
			loopPath = scopePaths[0]
			w.recordField(loopPath, scope)
		}
		childScope := scope
		if loopPath != "" {
			childScope = append(append([]string{}, scope...), loopPath)
		}
		w.walk(n.List, childScope)
		if n.ElseList != nil {
			w.walk(n.ElseList, scope)
		}
	case *parse.TemplateNode:
		if n.Pipe != nil {
			for _, p := range fieldsInPipe(n.Pipe) {
				w.recordField(p, scope)
			}
		}
	}
}

func (w *walker) recordField(path string, scope []string) {
	if path == "" {
		return
	}
	if len(scope) == 0 {
		w.fields[path] = true
		return
	}
	parent := scope[len(scope)-1]
	w.loops[parent] = append(w.loops[parent], path)
}

// fieldsInPipe returns the dotted paths referenced by a pipeline.
// For each command, we look at field/chain/variable nodes. Variables (like $it)
// are skipped because they're loop-local.
func fieldsInPipe(pipe *parse.PipeNode) []string {
	if pipe == nil {
		return nil
	}
	var out []string
	for _, cmd := range pipe.Cmds {
		for _, arg := range cmd.Args {
			switch a := arg.(type) {
			case *parse.FieldNode:
				out = append(out, strings.Join(a.Ident, "."))
			case *parse.ChainNode:
				// .customer.email on the result of another expression; best effort.
				if len(a.Field) > 0 {
					out = append(out, strings.Join(a.Field, "."))
				}
			}
		}
	}
	return out
}

// Substitute executes the HTML as a Go html/template against data.
// Falls back to a plain regex replacement if the template has syntax errors,
// so authors aren't blocked by unfamiliar Go-template constructs.
func Substitute(src string, data map[string]interface{}) (string, error) {
	return SubstituteWithLocale(src, data, "", i18n.Config{})
}

// SubstituteWithLocale is the locale-aware form of Substitute. The `locale` is
// a BCP-47 tag (e.g. "en-US", "es-ES"). `i18nCfg` supplies the template's
// translation dictionaries so the `t` helper can look them up.
//
// Error policy:
//   - Parse error (syntax) → fall back to the bare-placeholder regex so an
//     author mid-typing still sees a best-effort preview. This is safe because
//     a parse failure means the template never ran, and the raw regex is the
//     most conservative substitution possible.
//   - Execute error (semantics — type mismatch, missing function, bad pipe)
//     → return the error. The previous behavior silently regex-fell-back,
//     which erased every control-flow (`{{ range }}`, `{{ if }}`) and piped
//     expression (`{{ .x | formatCurrency }}`) from the output, leaving a
//     half-rendered page that looked broken to authors with no indication
//     why. Surfacing the error lets the UI banner tell them exactly which
//     expression failed.
func SubstituteWithLocale(src string, data map[string]interface{}, locale string, i18nCfg i18n.Config) (string, error) {
	funcs := defaultFuncs()
	if locale != "" {
		// Override the generic formatters with locale-aware versions.
		// Both arg-orders supported — see formatCurrency/formatDate in
		// defaultFuncs() for the rationale.
		funcs["formatCurrency"] = func(a, b interface{}) string {
			value, code := splitValueAndCode(a, b)
			return i18n.FormatCurrency(locale, value, code)
		}
		funcs["formatNumber"] = func(a, b interface{}) string {
			value, decimals := splitValueAndDecimals(a, b)
			return i18n.FormatNumber(locale, value, decimals)
		}
		funcs["formatDate"] = func(a, b interface{}) string {
			value, layout := splitValueAndTimeLayout(a, b)
			return i18n.FormatDate(locale, value, layout)
		}
	}
	// Translation helper (always available; no-op if no translations configured).
	funcs["t"] = func(key string, args ...interface{}) string {
		return i18n.Translate(i18nCfg, locale, key, args...)
	}

	t, err := htmltemplate.New("doc").Funcs(funcs).Parse(src)
	if err != nil {
		// Author is mid-edit; best-effort render with the dumb regex.
		return regexSubstitute(src, data), nil
	}
	// `missingkey=zero` makes missing map keys render as the zero value
	// (empty string for scalars) instead of erroring. Combined with our
	// coercing comparators in defaultFuncs, this lets a partial-sample-
	// data preview render without Execute failures blanking the page.
	t = t.Option("missingkey=zero")
	var buf bytes.Buffer
	if err := t.Execute(&buf, data); err != nil {
		// Execute-time error (e.g. comparing incompatible types, missing
		// custom function). Return a best-effort render of bare
		// placeholders AND surface the error — blanking the preview on
		// every minor issue makes authoring feel broken. The handler
		// layer pairs this with a UI banner so the author sees which
		// expression failed.
		return regexSubstitute(src, data), fmt.Errorf("template execute: %w", err)
	}
	return buf.String(), nil
}

// Preview runs substitution and applies the layout's visual hints (watermark
// CSS, optional header/footer bars) so the iframe shows what the final PDF
// will look like.
//
// Returns best-effort HTML even when err != nil (an Execute-time error) so the
// designer UI can show the partial render alongside a clear error banner,
// rather than going blank on every minor template issue.
func Preview(src string, data map[string]interface{}, l *layout.Layout) (string, error) {
	filled, err := Substitute(src, data)
	return ApplyLayoutForPreview(filled, l), err
}

// PreviewWithLocale is the locale-aware form of Preview.
func PreviewWithLocale(src string, data map[string]interface{}, l *layout.Layout, locale string, i18nCfg i18n.Config) (string, error) {
	filled, err := SubstituteWithLocale(src, data, locale, i18nCfg)
	return ApplyLayoutForPreview(filled, l), err
}

// ApplyLayoutForPreview wraps the rendered HTML with layout approximations for
// browser preview. The PDF pipeline does not use this — it uses Chromium's own
// header/footer rendering — but the iframe does, so authors can see what
// their layout will look like while they edit.
func ApplyLayoutForPreview(htmlStr string, l *layout.Layout) string {
	if l == nil {
		return htmlStr
	}
	var injected strings.Builder
	if css := l.WatermarkCSS(); css != "" {
		injected.WriteString(css)
	}
	// Header/footer preview bars (fixed at top/bottom) — approximation only.
	if l.Header.Enabled && l.Header.HTML != "" {
		injected.WriteString(`<style data-formly-hf>
  .formly-preview-header {
    position: fixed; top: 0; left: 0; right: 0;
    padding: 6px 10mm; font-size: 10px; color: #555;
    background: rgba(255,255,255,.85); border-bottom: 1px dashed #ddd;
    z-index: 10000;
  }
</style>`)
	}
	if (l.Footer.Enabled && l.Footer.HTML != "") || l.PageNumbers.Enabled {
		injected.WriteString(`<style data-formly-hf>
  .formly-preview-footer {
    position: fixed; bottom: 0; left: 0; right: 0;
    padding: 6px 10mm; font-size: 10px; color: #555;
    background: rgba(255,255,255,.85); border-top: 1px dashed #ddd;
    z-index: 10000; display: flex;
  }
</style>`)
	}

	out := injectIntoHead(htmlStr, injected.String())

	// Append header/footer overlay divs after <body>.
	var bodyExtras strings.Builder
	if l.Header.Enabled && l.Header.HTML != "" {
		bodyExtras.WriteString(`<div class="formly-preview-header">`)
		bodyExtras.WriteString(l.Header.HTML)
		bodyExtras.WriteString(`</div>`)
	}
	if (l.Footer.Enabled && l.Footer.HTML != "") || l.PageNumbers.Enabled {
		bodyExtras.WriteString(`<div class="formly-preview-footer">`)
		if l.Footer.Enabled && l.Footer.HTML != "" {
			bodyExtras.WriteString(`<span style="flex:1">`)
			bodyExtras.WriteString(l.Footer.HTML)
			bodyExtras.WriteString(`</span>`)
		}
		if l.PageNumbers.Enabled {
			format := l.PageNumbers.Format
			if format == "" {
				format = "{page} / {total}"
			}
			// Preview uses literal "1" and "1" since there's no pagination in an iframe.
			format = strings.ReplaceAll(format, "{page}", "1")
			format = strings.ReplaceAll(format, "{total}", "1")
			pos := l.PageNumbers.Position
			if pos == "" {
				pos = "bottom-center"
			}
			style := "flex:1;" + positionCSSForPreview(pos)
			bodyExtras.WriteString(fmt.Sprintf(`<span style="%s">%s</span>`, style, format))
		}
		bodyExtras.WriteString(`</div>`)
	}
	if bodyExtras.Len() > 0 {
		out = injectAfterBody(out, bodyExtras.String())
	}
	return out
}

func positionCSSForPreview(pos string) string {
	switch pos {
	case "bottom-left", "top-left":
		return "text-align:left;"
	case "bottom-right", "top-right":
		return "text-align:right;"
	default:
		return "text-align:center;"
	}
}

func injectAfterBody(src, fragment string) string {
	lower := strings.ToLower(src)
	idx := strings.Index(lower, "<body")
	if idx == -1 {
		return src + fragment
	}
	end := strings.Index(lower[idx:], ">")
	if end == -1 {
		return src + fragment
	}
	cut := idx + end + 1
	return src[:cut] + fragment + src[cut:]
}

// regexExtract is the legacy regex-based placeholder extractor; used only as a
// fallback when parsing fails.
func regexExtract(src string) []string {
	re := regexp.MustCompile(`\{\{\s*\.?([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}`)
	matches := re.FindAllStringSubmatch(src, -1)
	seen := map[string]bool{}
	out := []string{}
	for _, m := range matches {
		name := m[1]
		switch name {
		case "if", "end", "else", "range", "with", "template", "block", "define":
			continue
		}
		if !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// regexSubstitute is a best-effort fallback that replaces `{{key}}` and `{{a.b}}`
// without evaluating Go template actions.
func regexSubstitute(src string, data map[string]interface{}) string {
	re := regexp.MustCompile(`\{\{\s*\.?([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}`)
	return re.ReplaceAllStringFunc(src, func(match string) string {
		m := re.FindStringSubmatch(match)
		if len(m) < 2 {
			return match
		}
		v := lookup(data, m[1])
		if v == nil {
			return ""
		}
		return htmltemplate.HTMLEscapeString(fmt.Sprint(v))
	})
}

func lookup(m map[string]interface{}, path string) interface{} {
	cur := interface{}(m)
	for _, part := range strings.Split(path, ".") {
		obj, ok := cur.(map[string]interface{})
		if !ok {
			return nil
		}
		cur = obj[part]
	}
	return cur
}

func defaultFuncs() htmltemplate.FuncMap {
	return htmltemplate.FuncMap{
		"upper": strings.ToUpper,
		"lower": strings.ToLower,

		// formatDate accepts BOTH call styles, matching formatCurrency:
		//   {{ formatDate .paidAt "Jan 2, 2006" }}     — direct
		//   {{ .paidAt | formatDate "Jan 2, 2006" }}   — pipe (value last)
		// A Go time layout references the canonical moment
		// "Mon Jan 2 15:04:05 MST 2006", so we detect it by looking for
		// that signature (year 2006, month names, or "15:04"). Anything
		// else is treated as the value to format.
		"formatDate": func(a, b interface{}) string {
			value, layout := splitValueAndTimeLayout(a, b)
			s := fmt.Sprint(value)
			if s == "" {
				return ""
			}
			if tv, ok := value.(time.Time); ok {
				return tv.Format(layout)
			}
			t, err := time.Parse(time.RFC3339, s)
			if err != nil {
				t, err = time.Parse("2006-01-02", s)
				if err != nil {
					return s
				}
			}
			return t.Format(layout)
		},

		"formatCurrency": formatCurrency,
		"formatNumber":   formatNumber,

		"default": func(def, v interface{}) interface{} {
			if isZero(v) {
				return def
			}
			return v
		},

		"now": func() time.Time { return time.Now() },

		"sum": sumValues,

		"join": func(values interface{}, sep string) string {
			items := asStringSlice(values)
			return strings.Join(items, sep)
		},

		"contains": func(needle interface{}, haystack interface{}) bool {
			n := fmt.Sprint(needle)
			for _, v := range asStringSlice(haystack) {
				if v == n {
					return true
				}
			}
			return false
		},

		// Rich media helpers.
		"qrcode":    qrcodeFunc,
		"barcode":   barcodeFunc,
		"signature": signatureFunc,
		"image":     imageFunc,
		"chart":     chartFunc,

		// Numeric / math.
		"round":    roundFunc,
		"ceil":     ceilFunc,
		"floor":    floorFunc,
		"abs":      absFunc,
		"add":      func(a, b interface{}) float64 { af, _ := asFloat(a); bf, _ := asFloat(b); return af + bf },
		"sub":      func(a, b interface{}) float64 { af, _ := asFloat(a); bf, _ := asFloat(b); return af - bf },
		"mul":      func(a, b interface{}) float64 { af, _ := asFloat(a); bf, _ := asFloat(b); return af * bf },
		"div":      func(a, b interface{}) float64 { af, _ := asFloat(a); bf, _ := asFloat(b); if bf == 0 { return 0 }; return af / bf },

		// Numeric comparators that override Go's strict built-ins. Go's
		// html/template built-in gt/lt/eq/ne requires matching Kind — so
		// `gt .qty 1` fails when .qty is float64 (JSON default) and 1 is
		// int, or when .qty is a string like "2". Previously, a single
		// failure here cascaded: Execute errored, we silently regex-
		// fellback, and every pipe / range / if in the entire template
		// disappeared from the output. Coercing through asFloat keeps
		// these forgiving for common JSON-typed data; falls through to
		// string comparison when either side isn't numeric.
		"gt": compareCoerced(func(a, b float64) bool { return a > b }, func(a, b string) bool { return a > b }),
		"ge": compareCoerced(func(a, b float64) bool { return a >= b }, func(a, b string) bool { return a >= b }),
		"lt": compareCoerced(func(a, b float64) bool { return a < b }, func(a, b string) bool { return a < b }),
		"le": compareCoerced(func(a, b float64) bool { return a <= b }, func(a, b string) bool { return a <= b }),
		"eq": compareCoerced(func(a, b float64) bool { return a == b }, func(a, b string) bool { return a == b }),
		"ne": compareCoerced(func(a, b float64) bool { return a != b }, func(a, b string) bool { return a != b }),

		// String / text.
		"ordinal":    ordinalFunc,
		"pluralize":  pluralizeFunc,
		"truncate":   truncateFunc,
		"capitalize": capitalizeFunc,
		"titleCase":  titleCaseFunc,
		"slug":       slugFunc,
		"replace":    func(s, old, new string) string { return strings.ReplaceAll(s, old, new) },
		"split":      func(s, sep string) []string { return strings.Split(s, sep) },

		// Date math.
		"today": func() time.Time {
			t := time.Now()
			return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
		},
		"addDays": func(t time.Time, n int) time.Time { return t.AddDate(0, 0, n) },
	}
}

// builtinFuncsForParse mirrors defaultFuncs() but maps each name to a sentinel
// — parse.Parse only needs to know the name exists so `{{ x | formatCurrency }}`
// syntax validates. Values are not executed at parse time.
func builtinFuncsForParse() map[string]any {
	f := map[string]any{}
	for name := range defaultFuncs() {
		f[name] = func() string { return "" }
	}
	// `t` is registered only on the locale-aware path but templates can still
	// reference it at parse time — stub it out so extraction doesn't choke.
	f["t"] = func() string { return "" }
	return f
}

// isZero returns true for values that should trigger `default`'s fallback.
func isZero(v interface{}) bool {
	if v == nil {
		return true
	}
	switch x := v.(type) {
	case string:
		return x == ""
	case bool:
		return !x
	case float64:
		return x == 0
	case int:
		return x == 0
	case []interface{}:
		return len(x) == 0
	case map[string]interface{}:
		return len(x) == 0
	}
	return false
}

// compareCoerced builds a 2-arg template func that first tries to compare both
// values as float64 (coercing int/float/string-numeric), falling back to
// comparing their string representations. Used to replace Go's strict
// built-in comparators (gt/lt/eq/...) which require identical reflect.Kind
// and fail loudly on the JSON-typed data most authors work with.
func compareCoerced(nums func(a, b float64) bool, strs func(a, b string) bool) func(a, b interface{}) bool {
	return func(a, b interface{}) bool {
		if af, aok := asFloat(a); aok {
			if bf, bok := asFloat(b); bok {
				return nums(af, bf)
			}
		}
		return strs(fmt.Sprint(a), fmt.Sprint(b))
	}
}

// asFloat converts common JSON-decoded number types to float64.
func asFloat(v interface{}) (float64, bool) {
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
		f, err := strconv.ParseFloat(x, 64)
		if err == nil {
			return f, true
		}
	}
	return 0, false
}

// sumValues supports three call shapes:
//
//	{{ sum .numbers }}           — sum a []number
//	{{ sum .items "amount" }}    — sum a []map by field
//	{{ sum 1 2 3 }}              — sum literal args
func sumValues(args ...interface{}) float64 {
	if len(args) == 0 {
		return 0
	}
	// Case 1: single slice argument
	if len(args) == 1 {
		if slice, ok := args[0].([]interface{}); ok {
			total := 0.0
			for _, v := range slice {
				if f, ok := asFloat(v); ok {
					total += f
				}
			}
			return total
		}
		if f, ok := asFloat(args[0]); ok {
			return f
		}
		return 0
	}
	// Case 2: slice + field name
	if slice, ok := args[0].([]interface{}); ok {
		if field, ok2 := args[1].(string); ok2 {
			total := 0.0
			for _, v := range slice {
				if m, ok3 := v.(map[string]interface{}); ok3 {
					if f, ok4 := asFloat(m[field]); ok4 {
						total += f
					}
				}
			}
			return total
		}
	}
	// Case 3: literal args
	total := 0.0
	for _, a := range args {
		if f, ok := asFloat(a); ok {
			total += f
		}
	}
	return total
}

// asStringSlice coerces common inputs to a slice of strings.
func asStringSlice(v interface{}) []string {
	switch x := v.(type) {
	case []string:
		return x
	case []interface{}:
		out := make([]string, 0, len(x))
		for _, it := range x {
			out = append(out, fmt.Sprint(it))
		}
		return out
	case string:
		return []string{x}
	}
	return nil
}

// formatCurrency formats a value as a currency string. Uses a minimal
// built-in formatter (no CLDR dep) — good enough for USD/EUR/GBP/INR/JPY.
//
// Accepts BOTH Go-template call conventions:
//
//	{{ formatCurrency .amount "USD" }}   — direct call, value first
//	{{ .amount | formatCurrency "USD" }} — pipe, value is last arg
//
// Pipe semantics in Go templates put the piped value as the FINAL argument,
// so the second form resolves to `formatCurrency("USD", .amount)` — the
// reverse of the static signature. We previously declared
// `formatCurrency(v, code string)`, so pipe calls crashed inside
// html/template's reflect dispatch with `expected string; got float64`,
// which bubbled up to Execute and (silently) erased the entire pipe/range
// portion of the rendered template via the regex fallback. Accepting two
// `interface{}` args and auto-detecting which one is the currency code
// makes both styles work transparently. Currency codes are short
// all-uppercase ASCII, so the detection is unambiguous.
func formatCurrency(a, b interface{}) string {
	value, code := splitValueAndCode(a, b)
	f, ok := asFloat(value)
	if !ok {
		return fmt.Sprint(value)
	}
	code = strings.ToUpper(code)
	sym := currencySymbol(code)
	decimals := 2
	if code == "JPY" || code == "KRW" {
		decimals = 0
	}
	return sym + formatWithCommas(f, decimals)
}

// splitValueAndCode disambiguates (value, code) vs (code, value) by
// recognising a currency code (2–4 all-uppercase ASCII letters). Falls
// back to (a, b) when nothing looks like a code.
func splitValueAndCode(a, b interface{}) (value interface{}, code string) {
	if s, ok := b.(string); ok && looksLikeCurrencyCode(s) {
		return a, s
	}
	if s, ok := a.(string); ok && looksLikeCurrencyCode(s) {
		return b, s
	}
	// Nothing looks like a code — legacy (value, codeStr) order.
	if s, ok := b.(string); ok {
		return a, s
	}
	return a, fmt.Sprint(b)
}

// looksLikeTimeLayout reports whether the string is a Go time format layout.
// Go's reference date is "Mon Jan 2 15:04:05 MST 2006" — any real layout
// includes at least one of those tokens, while a user's actual date value
// (e.g. "2026-04-24T10:00:00Z") does not.
func looksLikeTimeLayout(s string) bool {
	if s == "" {
		return false
	}
	// Cheap substring checks for the most common reference tokens.
	for _, tok := range []string{
		"2006", "Jan", "January", "Mon", "Monday",
		"15:04", "3:04", "PM", "MST",
	} {
		if strings.Contains(s, tok) {
			return true
		}
	}
	return false
}

func splitValueAndTimeLayout(a, b interface{}) (value interface{}, layout string) {
	if s, ok := b.(string); ok && looksLikeTimeLayout(s) {
		return a, s
	}
	if s, ok := a.(string); ok && looksLikeTimeLayout(s) {
		return b, s
	}
	// Neither looks like a layout — assume legacy (value, layoutStr) order.
	if s, ok := b.(string); ok {
		return a, s
	}
	return a, fmt.Sprint(b)
}

func looksLikeCurrencyCode(s string) bool {
	if len(s) < 2 || len(s) > 4 {
		return false
	}
	for _, r := range s {
		if r < 'A' || r > 'Z' {
			return false
		}
	}
	return true
}

// formatNumber formats a number with thousands separators and the given
// decimals. Accepts both direct-call and pipe forms:
//
//	{{ formatNumber .value 2 }}
//	{{ .value | formatNumber 2 }}
//
// When called with the pipe form the signature is effectively
// `(decimals, value)`, so we auto-detect which arg is numeric-as-count
// (int, small non-negative) vs the value to format.
func formatNumber(a, b interface{}) string {
	value, decimals := splitValueAndDecimals(a, b)
	f, ok := asFloat(value)
	if !ok {
		return fmt.Sprint(value)
	}
	if decimals < 0 {
		decimals = 0
	}
	return formatWithCommas(f, decimals)
}

// splitValueAndDecimals disambiguates (value, decimals) vs (decimals, value).
// A decimals arg is a small non-negative integer (0–8); when both args look
// numeric we prefer the LAST as the value (matches pipe semantics).
func splitValueAndDecimals(a, b interface{}) (value interface{}, decimals int) {
	af, aIsNum := asFloat(a)
	bf, bIsNum := asFloat(b)
	aIsDec := aIsNum && af == float64(int(af)) && af >= 0 && af <= 8
	bIsDec := bIsNum && bf == float64(int(bf)) && bf >= 0 && bf <= 8
	// Prefer legacy direct-call (value, decimals) when b looks like decimals.
	if bIsDec && !aIsDec {
		return a, int(bf)
	}
	if aIsDec && !bIsDec {
		return b, int(af)
	}
	// Both or neither look like decimals — fall back to pipe convention
	// where the value is the last arg.
	if aIsDec {
		return b, int(af)
	}
	if bIsDec {
		return a, int(bf)
	}
	return a, 2
}

func currencySymbol(code string) string {
	switch code {
	case "USD", "CAD", "AUD", "NZD", "SGD", "HKD":
		return "$"
	case "EUR":
		return "€"
	case "GBP":
		return "£"
	case "INR":
		return "₹"
	case "JPY", "CNY":
		return "¥"
	case "KRW":
		return "₩"
	}
	return code + " "
}

// formatWithCommas formats f with `decimals` digits after the point and a
// thousands separator in the integer part.
func formatWithCommas(f float64, decimals int) string {
	neg := f < 0
	if neg {
		f = -f
	}
	raw := strconv.FormatFloat(f, 'f', decimals, 64)
	intPart, fracPart, hasFrac := strings.Cut(raw, ".")
	var b strings.Builder
	if neg {
		b.WriteByte('-')
	}
	// Insert commas into intPart.
	n := len(intPart)
	for i, ch := range intPart {
		if i > 0 && (n-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(ch)
	}
	if hasFrac {
		b.WriteByte('.')
		b.WriteString(fracPart)
	}
	return b.String()
}

// Render executes substitution and prints the result to PDF via headless Chromium.
// A fresh BrowserContext is created per render to prevent state leakage between jobs.
func Render(ctx context.Context, src string, data map[string]interface{}, l *layout.Layout) ([]byte, error) {
	return RenderWithLocale(ctx, src, data, l, "", i18n.Config{})
}

// RenderWithLocale is the locale-aware form of Render.
func RenderWithLocale(ctx context.Context, src string, data map[string]interface{}, l *layout.Layout, locale string, i18nCfg i18n.Config) ([]byte, error) {
	finalHTML, err := SubstituteWithLocale(src, data, locale, i18nCfg)
	if err != nil {
		return nil, fmt.Errorf("substitute: %w", err)
	}
	return RenderHTML(ctx, finalHTML, l)
}

// RenderHTML is the Chromium half of Render — takes already-substituted HTML
// and prints it to PDF. Split out so other modes (e.g. markdown) can reuse the
// pipeline after their own substitution.
//
// Staging note
// ------------
// chromedp.NewContext is lazy: the browser target (tab) isn't created
// until the first chromedp.Run call, and even then Page.enable hasn't
// fired and the frame tree is empty. Calling page.GetFrameTree() +
// page.SetDocumentContent before a real navigation is the cause of the
// `DOM.documentUpdated when there's no top-level frame` warning and
// the subsequent hang — Chromium drops the document event because no
// frame owns it, so WaitReady("body") waits forever. The reliable
// pattern is to navigate to about:blank first (which materializes a
// frame + document), then swap the content in. We also split the
// render into its own chromedp.Run so per-phase timing is visible in
// the logs, which is how we'd have caught this sooner.
func RenderHTML(ctx context.Context, finalHTML string, l *layout.Layout) ([]byte, error) {
	// Inject watermark CSS into the document if configured.
	if css := l.WatermarkCSS(); css != "" {
		finalHTML = injectIntoHead(finalHTML, css)
	}

	// Allocator: prefers a local Chrome binary. For K8s, replace with
	// chromedp.NewRemoteAllocator(ctx, "ws://chromium-pool:9222").
	allocCtx, cancel := chromedp.NewExecAllocator(ctx,
		append(
			chromedp.DefaultExecAllocatorOptions[:],
			chromedp.NoSandbox,
			chromedp.DisableGPU,
			chromedp.Flag("headless", true),
		)...,
	)
	defer cancel()

	browserCtx, cancel2 := chromedp.NewContext(allocCtx)
	defer cancel2()

	tctx, cancelT := context.WithTimeout(browserCtx, renderTimeout())
	defer cancelT()

	paperW, paperH := l.PaperInches()
	mtop, mright, mbot, mleft := l.EffectiveMargins()
	showHF := l.DisplayHeaderFooter()
	headerTpl := l.HeaderHTML()
	footerTpl := l.FooterHTML()

	// Phase 1 — force the target to fully materialize with an
	// about:blank navigation. Everything after this can assume a real
	// top-level frame exists.
	t0 := time.Now()
	if err := chromedp.Run(tctx, chromedp.Navigate("about:blank")); err != nil {
		return nil, fmt.Errorf("chromium launch: %w", err)
	}
	tLaunch := time.Since(t0)

	// Phase 2 — swap the document content into the now-real frame and
	// wait for body to be attached. SetOuterHTML on the document can be
	// flaky for <!DOCTYPE>-bearing strings, but SetDocumentContent on
	// the top-level frame ID handles that cleanly.
	t1 := time.Now()
	err := chromedp.Run(tctx,
		chromedp.ActionFunc(func(ctx context.Context) error {
			frameTree, err := page.GetFrameTree().Do(ctx)
			if err != nil {
				return fmt.Errorf("get frame tree: %w", err)
			}
			if frameTree == nil || frameTree.Frame == nil {
				return fmt.Errorf("no top-level frame after about:blank")
			}
			return page.SetDocumentContent(frameTree.Frame.ID, finalHTML).Do(ctx)
		}),
		chromedp.WaitReady("body", chromedp.ByQuery),
	)
	if err != nil {
		return nil, fmt.Errorf("chromium set content: %w", err)
	}
	tContent := time.Since(t1)

	// Phase 3 — print to PDF.
	t2 := time.Now()
	var pdf []byte
	err = chromedp.Run(tctx,
		chromedp.ActionFunc(func(ctx context.Context) error {
			p := page.PrintToPDF().
				WithPrintBackground(true).
				WithPaperWidth(paperW).
				WithPaperHeight(paperH).
				WithMarginTop(mtop).
				WithMarginRight(mright).
				WithMarginBottom(mbot).
				WithMarginLeft(mleft).
				WithLandscape(l.IsLandscape()).
				WithDisplayHeaderFooter(showHF).
				WithHeaderTemplate(headerTpl).
				WithFooterTemplate(footerTpl).
				WithPreferCSSPageSize(false)
			data, _, err := p.Do(ctx)
			pdf = data
			return err
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("chromium print: %w", err)
	}
	tPrint := time.Since(t2)

	slog.Info("chromium render",
		"launch_ms", tLaunch.Milliseconds(),
		"content_ms", tContent.Milliseconds(),
		"print_ms", tPrint.Milliseconds(),
		"html_bytes", len(finalHTML),
		"pdf_bytes", len(pdf),
	)
	return pdf, nil
}

// injectIntoHead inserts the given HTML (typically a <style> block) right
// before </head>. If no </head> is present, it's prepended to the document.
func injectIntoHead(src, fragment string) string {
	idx := strings.Index(strings.ToLower(src), "</head>")
	if idx == -1 {
		return fragment + src
	}
	return src[:idx] + fragment + src[idx:]
}
