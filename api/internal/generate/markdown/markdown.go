// Package markdown implements the Markdown-to-PDF generation mode.
//
// The author writes Markdown with Go-template placeholders. On render we:
//  1. Run the template engine (reuses internal/generate/html's Substitute for
//     a consistent placeholder vocabulary and helper funcs)
//  2. Convert the resulting Markdown to HTML via goldmark (CommonMark + GFM)
//  3. Wrap in a minimal document shell with print-friendly styles
//  4. Render to PDF with the same Chromium pipeline used by html mode
package markdown

import (
	"bytes"
	"context"
	"fmt"

	ghtml "github.com/docforge/api/internal/generate/html"
	"github.com/docforge/api/internal/i18n"
	"github.com/docforge/api/internal/layout"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/renderer/html"
)

// ExtractPlaceholders delegates to the html extractor — the syntax is identical.
func ExtractPlaceholders(src string) []string {
	return ghtml.ExtractPlaceholders(src)
}

// mdParser is instantiated once. goldmark is safe for concurrent use.
var mdParser = goldmark.New(
	goldmark.WithExtensions(
		extension.GFM,
		extension.Footnote,
		extension.DefinitionList,
		extension.Typographer,
	),
	goldmark.WithParserOptions(parser.WithAutoHeadingID()),
	goldmark.WithRendererOptions(html.WithUnsafe()),
)

// ToHTML converts the Markdown source (already substituted) to HTML and wraps
// it in a minimal document shell suitable for Chromium.
func ToHTML(md string) (string, error) {
	var buf bytes.Buffer
	if err := mdParser.Convert([]byte(md), &buf); err != nil {
		return "", err
	}
	return wrapInDocument(buf.String()), nil
}

// Preview runs the template engine on the source and renders the resulting
// Markdown to HTML, then applies the layout's visual hints (watermark, header/
// footer bars) for iframe preview.
func Preview(src string, data map[string]interface{}, l *layout.Layout) (string, error) {
	return PreviewWithLocale(src, data, l, "", i18n.Config{})
}

// PreviewWithLocale is the locale-aware form of Preview.
//
// Returns best-effort HTML alongside any template-execute error so the
// designer can render a partial preview with a warning banner rather than
// blanking the pane on every minor template issue. See the matching contract
// in ghtml.SubstituteWithLocale for the error-policy rationale.
func PreviewWithLocale(src string, data map[string]interface{}, l *layout.Layout, locale string, i18nCfg i18n.Config) (string, error) {
	filled, substErr := ghtml.SubstituteWithLocale(src, data, locale, i18nCfg)
	// `filled` carries a best-effort render even when substErr != nil.
	html, mdErr := ToHTML(filled)
	if mdErr != nil {
		if substErr != nil {
			return "", fmt.Errorf("%w; markdown: %v", substErr, mdErr)
		}
		return "", mdErr
	}
	return ghtml.ApplyLayoutForPreview(html, l), substErr
}

// Render runs the full Markdown → HTML → PDF pipeline.
func Render(ctx context.Context, src string, data map[string]interface{}, l *layout.Layout) ([]byte, error) {
	return RenderWithLocale(ctx, src, data, l, "", i18n.Config{})
}

// RenderWithLocale is the locale-aware form of Render.
func RenderWithLocale(ctx context.Context, src string, data map[string]interface{}, l *layout.Layout, locale string, i18nCfg i18n.Config) ([]byte, error) {
	filled, err := ghtml.SubstituteWithLocale(src, data, locale, i18nCfg)
	if err != nil {
		return nil, fmt.Errorf("markdown substitute: %w", err)
	}
	rendered, err := ToHTML(filled)
	if err != nil {
		return nil, fmt.Errorf("markdown render: %w", err)
	}
	return ghtml.RenderHTML(ctx, rendered, l)
}

func wrapInDocument(body string) string {
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
  blockquote {
    margin: 1em 0;
    padding: 8px 16px;
    border-left: 3px solid #10b981;
    background: #f0fdfa;
    color: #555;
  }
  code {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    background: #f3f4f6;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 0.9em;
  }
  pre {
    background: #0f172a;
    color: #e2e8f0;
    padding: 14px 16px;
    border-radius: 6px;
    overflow-x: auto;
    font-size: 12.5px;
  }
  pre code { background: transparent; color: inherit; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #e5e7eb; padding: 8px 10px; text-align: left; }
  th { background: #f9fafb; }
  hr { border: 0; border-top: 1px solid #e5e7eb; margin: 2em 0; }
  a { color: #0d9488; }
  img { max-width: 100%; }
  ul, ol { padding-left: 1.5em; }
  @media print {
    body { padding: 24px; max-width: none; }
  }
</style>
</head>
<body>
` + body + `
</body>
</html>`
}
