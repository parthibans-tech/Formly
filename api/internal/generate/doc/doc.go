package doc

import (
	"context"
	"fmt"

	ghtml "github.com/docforge/api/internal/generate/html"
	"github.com/docforge/api/internal/i18n"
	"github.com/docforge/api/internal/layout"
)

// Preview converts a stored doc envelope to HTML suitable for iframe preview
// and returns the result alongside any diagnostics. Mirrors the contract of
// ghtml.Preview / gmarkdown.Preview so the templates.go preview handler can
// dispatch uniformly.
//
// Returns best-effort HTML even when err != nil — a malformed envelope
// yields a friendly banner; a structurally-odd AST still produces a partial
// render with diagnostics attached.
func Preview(src string, data map[string]interface{}, l *layout.Layout) (string, []Diagnostic, error) {
	return PreviewWithLocale(src, data, l, "", i18n.Config{})
}

// PreviewWithLocale is the locale-aware form of Preview. The locale is
// threaded into the render context so field formatters respect it.
func PreviewWithLocale(src string, data map[string]interface{}, l *layout.Layout, locale string, i18nCfg i18n.Config) (string, []Diagnostic, error) {
	stored, err := ParseStoredDoc([]byte(src))
	if err != nil {
		// Malformed envelopes are unrecoverable — render an explanatory
		// placeholder so the iframe isn't blank, and surface the error.
		placeholder := fmt.Sprintf(
			`<div style="padding:24px;color:#b91c1c">Document failed to parse: %s</div>`,
			escapeForHTMLAttr(err.Error()),
		)
		return ghtml.ApplyLayoutForPreview(wrapInDocument(placeholder, ""), l), nil, err
	}
	ctx := &RenderContext{Locale: locale, I18n: i18nCfg}
	body, diags := RenderDoc(stored.Doc, data, ctx)
	return ghtml.ApplyLayoutForPreview(wrapInDocument(body, stored.ThemeCss), l), diags, nil
}

// Render runs the full AST → HTML → PDF pipeline. Mirrors ghtml.Render so
// the runner dispatch is a one-liner.
func Render(ctx context.Context, src string, data map[string]interface{}, l *layout.Layout) ([]byte, error) {
	return RenderWithLocale(ctx, src, data, l, "", i18n.Config{})
}

// RenderWithLocale is the locale-aware PDF renderer.
func RenderWithLocale(ctx context.Context, src string, data map[string]interface{}, l *layout.Layout, locale string, i18nCfg i18n.Config) ([]byte, error) {
	stored, err := ParseStoredDoc([]byte(src))
	if err != nil {
		return nil, fmt.Errorf("doc parse: %w", err)
	}
	rctx := &RenderContext{Locale: locale, I18n: i18nCfg}
	body, _ := RenderDoc(stored.Doc, data, rctx)
	return ghtml.RenderHTML(ctx, wrapInDocument(body, stored.ThemeCss), l)
}

// ExtractPlaceholders parses the envelope and returns the top-level field
// paths referenced by the doc. Matches the ghtml.ExtractPlaceholders
// signature so the UpdateSource handler can treat all three modes uniformly.
//
// On parse failure we return an empty slice rather than panicking — the
// save path should still succeed even if the doc is mid-edit and temporarily
// invalid, with the error surfaced via the preview endpoint.
func ExtractPlaceholders(src string) []string {
	stored, err := ParseStoredDoc([]byte(src))
	if err != nil || stored == nil {
		return []string{}
	}
	return ExtractFields(stored.Doc)
}

// wrapInDocument is the HTML shell used by both Preview and Render. Kept
// minimal and print-friendly; inherits the same visual-language the
// markdown mode uses, so docs and markdown feel consistent.
//
// themeCss, when non-empty, is injected AFTER the base stylesheet so
// per-template styles override the shell defaults. It's the author's
// starter-CSS captured at import time (or edited via the Theme drawer).
// We trust it because it's our own authored CSS — starter library input
// — and any author edits come from the designer UI, not user data.
func wrapInDocument(body string, themeCss string) string {
	theme := ""
	if themeCss != "" {
		// Wrap in a scoped <style> block. We don't sanitise — by the time
		// CSS reaches here it's authored template content, not user data.
		theme = "<style data-formly-theme>\n" + themeCss + "\n</style>"
	}
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: light; }
  body {
    font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #111;
    max-width: 760px;
    margin: 0 auto;
    padding: 48px;
    line-height: 1.65;
    font-size: 14px;
  }
  h1, h2, h3, h4 { line-height: 1.25; margin-top: 1.4em; }
  h1 { font-size: 28px; border-bottom: 2px solid #e5e7eb; padding-bottom: 6px; }
  h2 { font-size: 22px; }
  h3 { font-size: 18px; }
  p { margin: 0.6em 0; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #e5e7eb; padding: 8px 10px; text-align: left; }
  th { background: #f9fafb; }
  hr { border: 0; border-top: 1px solid #e5e7eb; margin: 2em 0; }
  a { color: #0d9488; }
  img { max-width: 100%; }
  ul, ol { padding-left: 1.5em; }
  /* Field markers are invisible by default — the designer injects its own
     highlight via overriding data-formly-field. */
  [data-formly-field] { background: transparent; }
  @media print {
    body { padding: 24px; max-width: none; }
  }
</style>
` + theme + `
</head>
<body>
` + body + `
</body>
</html>`
}

// escapeForHTMLAttr is a minimal escaper for the error-banner placeholder —
// using html.EscapeString pulls in the full html package at this call site,
// which we already do in render.go, but keeping the wrapping self-contained
// lets this file compile without cross-file coupling.
func escapeForHTMLAttr(s string) string {
	r := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '<':
			r = append(r, []byte("&lt;")...)
		case '>':
			r = append(r, []byte("&gt;")...)
		case '&':
			r = append(r, []byte("&amp;")...)
		case '"':
			r = append(r, []byte("&quot;")...)
		default:
			r = append(r, s[i])
		}
	}
	return string(r)
}
