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
	"regexp"
	"strings"
	"time"

	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"
)

// ExtractPlaceholders pulls unique top-level placeholder names out of an HTML
// source. Supports simple `{{name}}`, `{{customer.email}}` patterns (dot path).
// Ignores Go-template actions (if/range/with) for MVP; those still work at render
// time but aren't shown in the mapping panel.
func ExtractPlaceholders(src string) []string {
	re := regexp.MustCompile(`\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}`)
	matches := re.FindAllStringSubmatch(src, -1)
	seen := map[string]bool{}
	out := []string{}
	for _, m := range matches {
		name := m[1]
		// Skip template control words that sometimes look like identifiers.
		switch name {
		case "if", "end", "else", "range", "with", "template", "block", "define":
			continue
		}
		// Dot path: use the whole path as the data key.
		if _, ok := seen[name]; !ok {
			seen[name] = true
			out = append(out, name)
		}
	}
	return out
}

// Substitute executes the HTML as a Go html/template against data.
// Falls back to a plain regex replacement if the template has syntax errors,
// so authors aren't blocked by unfamiliar Go-template constructs.
func Substitute(src string, data map[string]interface{}) (string, error) {
	t, err := htmltemplate.New("doc").Funcs(defaultFuncs()).Parse(src)
	if err != nil {
		return regexSubstitute(src, data), nil
	}
	var buf bytes.Buffer
	if err := t.Execute(&buf, data); err != nil {
		return regexSubstitute(src, data), nil
	}
	return buf.String(), nil
}

// regexSubstitute is a best-effort fallback that replaces `{{key}}` and `{{a.b}}`
// without evaluating Go template actions.
func regexSubstitute(src string, data map[string]interface{}) string {
	re := regexp.MustCompile(`\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}`)
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
		"formatDate": func(v interface{}, layout string) string {
			s := fmt.Sprint(v)
			t, err := time.Parse(time.RFC3339, s)
			if err != nil {
				t, err = time.Parse("2006-01-02", s)
				if err != nil {
					return s
				}
			}
			return t.Format(layout)
		},
	}
}

// Render executes substitution and prints the result to PDF via headless Chromium.
// A fresh BrowserContext is created per render to prevent state leakage between jobs.
func Render(ctx context.Context, src string, data map[string]interface{}) ([]byte, error) {
	finalHTML, err := Substitute(src, data)
	if err != nil {
		return nil, fmt.Errorf("substitute: %w", err)
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

	tctx, cancelT := context.WithTimeout(browserCtx, 30*time.Second)
	defer cancelT()

	var pdf []byte
	err = chromedp.Run(tctx,
		chromedp.ActionFunc(func(ctx context.Context) error {
			// Seed an about:blank frame, then overwrite its content.
			frameTree, err := page.GetFrameTree().Do(ctx)
			if err != nil {
				return err
			}
			return page.SetDocumentContent(frameTree.Frame.ID, finalHTML).Do(ctx)
		}),
		chromedp.WaitReady("body", chromedp.ByQuery),
		chromedp.ActionFunc(func(ctx context.Context) error {
			data, _, err := page.PrintToPDF().
				WithPrintBackground(true).
				WithMarginTop(0.4).WithMarginBottom(0.4).
				WithMarginLeft(0.4).WithMarginRight(0.4).
				Do(ctx)
			pdf = data
			return err
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("chromium render: %w", err)
	}
	return pdf, nil
}
