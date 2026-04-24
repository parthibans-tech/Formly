package doc

import (
	"fmt"
	"html"
	"strings"

	"github.com/docforge/api/internal/i18n"
)

// RenderContext is the ambient state threaded through the walker. It's
// mutable in one direction only: we append to `diagnostics` during the walk.
// The caller receives the final list; a renderer never panics or aborts on
// a single bad node — we emit a best-effort placeholder and record the
// problem so the editor can surface it.
type RenderContext struct {
	Locale      string
	I18n        i18n.Config
	Diagnostics []Diagnostic
}

// Diagnostic is a non-fatal problem encountered during render. The editor
// uses `NodeID` to outline the offending element in red.
type Diagnostic struct {
	NodeID   string `json:"nodeId,omitempty"`
	Severity string `json:"severity"` // "error" | "warning"
	Message  string `json:"message"`
}

// RenderDoc walks an AST and returns the rendered HTML (<body>-inner only —
// the caller wraps in a document shell via wrapInDocument).
//
// The renderer never returns an error. Problems are captured as diagnostics
// and embedded as comments in the output HTML so they're visible in dev-tools
// but don't break the visual layout. This matches the "best-effort render"
// contract already established by the existing html / markdown packages.
func RenderDoc(d *Doc, data map[string]interface{}, ctx *RenderContext) (string, []Diagnostic) {
	if ctx == nil {
		ctx = &RenderContext{}
	}
	if d == nil {
		return "", ctx.Diagnostics
	}
	var sb strings.Builder
	scp := newRootScope(data)
	for _, b := range d.Content {
		renderBlock(&sb, b, scp, ctx)
	}
	return sb.String(), ctx.Diagnostics
}

// renderBlock dispatches on the block discriminator. Unknown kinds emit an
// HTML comment rather than silently disappearing, so authors don't lose
// content to typos in older docs.
func renderBlock(sb *strings.Builder, b Block, s *scope, ctx *RenderContext) {
	switch b.Kind {
	case BlockHeading:
		renderHeading(sb, b, s, ctx)
	case BlockParagraph:
		renderParagraph(sb, b, s, ctx)
	case BlockBulletList:
		renderList(sb, b, s, ctx, "ul")
	case BlockOrderedList:
		renderList(sb, b, s, ctx, "ol")
	case BlockTable:
		renderTable(sb, b, s, ctx)
	case BlockDivider:
		sb.WriteString("<hr />\n")
	case BlockImage:
		renderImage(sb, b, ctx)
	case BlockRepeat:
		renderRepeat(sb, b, s, ctx)
	case BlockIf:
		renderIf(sb, b, s, ctx)
	case BlockRaw:
		// Intentionally unescaped — this is the documented escape hatch.
		sb.WriteString(b.HTML)
	default:
		ctx.pushDiag(b.ID, "warning",
			fmt.Sprintf("unknown block type %q", string(b.Kind)))
		fmt.Fprintf(sb, "<!-- unknown block type %q -->\n", string(b.Kind))
	}
}

func renderHeading(sb *strings.Builder, b Block, s *scope, ctx *RenderContext) {
	lvl := b.Level
	if lvl < 1 || lvl > 6 {
		lvl = 1
	}
	fmt.Fprintf(sb, "<h%d%s>", lvl, dataNodeAttr(b.ID))
	renderInlines(sb, b.Inline, s, ctx)
	fmt.Fprintf(sb, "</h%d>\n", lvl)
}

func renderParagraph(sb *strings.Builder, b Block, s *scope, ctx *RenderContext) {
	style := ""
	switch b.Align {
	case "center":
		style = ` style="text-align:center"`
	case "right":
		style = ` style="text-align:right"`
	case "left":
		style = ` style="text-align:left"`
	}
	fmt.Fprintf(sb, "<p%s%s>", dataNodeAttr(b.ID), style)
	renderInlines(sb, b.Inline, s, ctx)
	sb.WriteString("</p>\n")
}

func renderList(sb *strings.Builder, b Block, s *scope, ctx *RenderContext, tag string) {
	fmt.Fprintf(sb, "<%s%s>\n", tag, dataNodeAttr(b.ID))
	for _, it := range b.Items {
		fmt.Fprintf(sb, "<li%s>", dataNodeAttr(it.ID))
		// Inline the first paragraph-only child so simple lists don't get
		// a stray <p> wrapper that bloats the markup.
		if len(it.Content) == 1 && it.Content[0].Kind == BlockParagraph {
			renderInlines(sb, it.Content[0].Inline, s, ctx)
		} else {
			for _, c := range it.Content {
				renderBlock(sb, c, s, ctx)
			}
		}
		sb.WriteString("</li>\n")
	}
	fmt.Fprintf(sb, "</%s>\n", tag)
}

func renderTable(sb *strings.Builder, b Block, s *scope, ctx *RenderContext) {
	fmt.Fprintf(sb, "<table%s>\n", dataNodeAttr(b.ID))
	// Treat the first row as a header when explicitly flagged; otherwise
	// render a single-body table. (Inferring header-ness would risk
	// surprising authors who intentionally have data in row 0.)
	firstIsHeader := len(b.Rows) > 0 && b.Rows[0].Header
	if firstIsHeader {
		sb.WriteString("<thead>")
		renderTableRow(sb, b.Rows[0], s, ctx, true)
		sb.WriteString("</thead>\n<tbody>\n")
		for _, row := range b.Rows[1:] {
			renderTableRow(sb, row, s, ctx, false)
		}
		sb.WriteString("</tbody>\n")
	} else {
		sb.WriteString("<tbody>\n")
		for _, row := range b.Rows {
			renderTableRow(sb, row, s, ctx, row.Header)
		}
		sb.WriteString("</tbody>\n")
	}
	sb.WriteString("</table>\n")
}

func renderTableRow(sb *strings.Builder, row TableRow, s *scope, ctx *RenderContext, isHeader bool) {
	fmt.Fprintf(sb, "<tr%s>", dataNodeAttr(row.ID))
	tag := "td"
	if isHeader {
		tag = "th"
	}
	for _, c := range row.Cells {
		fmt.Fprintf(sb, "<%s%s", tag, dataNodeAttr(c.ID))
		if c.ColSpan > 1 {
			fmt.Fprintf(sb, ` colspan="%d"`, c.ColSpan)
		}
		sb.WriteByte('>')
		renderInlines(sb, c.Inline, s, ctx)
		fmt.Fprintf(sb, "</%s>", tag)
	}
	sb.WriteString("</tr>\n")
}

func renderImage(sb *strings.Builder, b Block, ctx *RenderContext) {
	if b.Src == "" {
		ctx.pushDiag(b.ID, "warning", "image block missing src")
		return
	}
	widthAttr := ""
	if b.Width > 0 {
		widthAttr = fmt.Sprintf(` width="%d"`, b.Width)
	}
	fmt.Fprintf(sb, "<img%s src=\"%s\" alt=\"%s\"%s />\n",
		dataNodeAttr(b.ID),
		html.EscapeString(b.Src),
		html.EscapeString(b.Alt),
		widthAttr,
	)
}

// renderRepeat iterates the source path and emits the inner blocks per item.
// A missing or non-iterable source renders nothing — the same semantics as
// Go templates' `range` over missing data.
func renderRepeat(sb *strings.Builder, b Block, s *scope, ctx *RenderContext) {
	if b.Source == "" {
		ctx.pushDiag(b.ID, "error", "repeat block missing source path")
		return
	}
	raw, _ := s.resolve(b.Source)
	items := iterItems(raw)
	if items == nil {
		return
	}
	for _, item := range items {
		inner := s.push(item, b.As)
		for _, c := range b.Children {
			renderBlock(sb, c, inner, ctx)
		}
	}
}

// renderIf evaluates the condition and emits either the `children` branch or
// the `else` branch. An absent-else with a false condition emits nothing.
func renderIf(sb *strings.Builder, b Block, s *scope, ctx *RenderContext) {
	if b.Condition == nil {
		ctx.pushDiag(b.ID, "error", "if block missing condition")
		return
	}
	branch := b.Children
	if !evalCondition(b.Condition, s) {
		branch = b.Else
	}
	for _, c := range branch {
		renderBlock(sb, c, s, ctx)
	}
}

// renderInlines emits an inline-node run. Text nodes are HTML-escaped and
// wrapped in any applicable mark tags (bold/italic/link/etc); fields are
// resolved against the current scope and formatted.
func renderInlines(sb *strings.Builder, inl []Inline, s *scope, ctx *RenderContext) {
	for _, i := range inl {
		switch i.Kind {
		case InlineText, "":
			writeTextWithMarks(sb, i.Text, i.Marks)
		case InlineHardBreak:
			sb.WriteString("<br />")
		case InlineField:
			renderField(sb, i, s, ctx)
		default:
			ctx.pushDiag("", "warning",
				fmt.Sprintf("unknown inline type %q", string(i.Kind)))
		}
	}
}

// writeTextWithMarks wraps the escaped text in open/close tags for each mark.
// Marks are applied in a stable order so the output is deterministic — the
// order doesn't matter semantically for most combinations, but tests + diff
// tooling like reproducibility.
func writeTextWithMarks(sb *strings.Builder, text string, marks []Mark) {
	if text == "" && len(marks) == 0 {
		return
	}
	opens, closes := marksToTags(marks)
	for _, o := range opens {
		sb.WriteString(o)
	}
	sb.WriteString(html.EscapeString(text))
	// Close in reverse so tags nest correctly.
	for i := len(closes) - 1; i >= 0; i-- {
		sb.WriteString(closes[i])
	}
}

// marksToTags translates the mark list into paired open/close strings.
// Returning two slices keeps the caller symmetric and avoids a stack
// allocation per inline run.
func marksToTags(marks []Mark) (opens, closes []string) {
	// Stable iteration order: the AST-defined order of appearance.
	for _, m := range marks {
		switch m.Type {
		case MarkBold:
			opens = append(opens, "<strong>")
			closes = append(closes, "</strong>")
		case MarkItalic:
			opens = append(opens, "<em>")
			closes = append(closes, "</em>")
		case MarkUnderline:
			opens = append(opens, "<u>")
			closes = append(closes, "</u>")
		case MarkStrike:
			opens = append(opens, "<s>")
			closes = append(closes, "</s>")
		case MarkCode:
			opens = append(opens, "<code>")
			closes = append(closes, "</code>")
		case MarkLink:
			href := m.Href
			if href == "" {
				href = "#"
			}
			opens = append(opens,
				fmt.Sprintf(`<a href="%s">`, html.EscapeString(href)))
			closes = append(closes, "</a>")
		case MarkColor:
			if m.Value != "" {
				opens = append(opens,
					fmt.Sprintf(`<span style="color:%s">`, html.EscapeString(m.Value)))
				closes = append(closes, "</span>")
			}
		}
	}
	return opens, closes
}

// renderField resolves a field node and writes the escaped, formatted value.
// Missing values emit the declared `default`, or an empty string if none.
// The rendered span carries data attributes so the editor can round-trip
// the field definition when re-parsing saved-to-HTML previews.
func renderField(sb *strings.Builder, i Inline, s *scope, ctx *RenderContext) {
	v, ok := s.resolve(i.Path)
	if !ok {
		// Surface a diagnostic but don't fail — authors may bind this later.
		ctx.pushDiag("", "warning", fmt.Sprintf("field %q not found in data", i.Path))
	}
	formatted := formatField(v, i.Format, i.Default, ctx.Locale, ctx.I18n)
	// Wrap in a span tagged with the path so the preview stays visually
	// attributable (and so CSS in the preview can highlight bound fields).
	fmt.Fprintf(sb, `<span data-formly-field="%s">`, html.EscapeString(i.Path))
	sb.WriteString(html.EscapeString(formatted))
	sb.WriteString("</span>")
}

// dataNodeAttr returns ` data-formly-node="ID"` or "" when the node has no
// ID. Centralizing this keeps the attribute name in one place and avoids
// emitting ` data-formly-node=""` noise for ID-less nodes.
func dataNodeAttr(id string) string {
	if id == "" {
		return ""
	}
	return fmt.Sprintf(` data-formly-node="%s"`, html.EscapeString(id))
}

// pushDiag appends a diagnostic. Lives on *RenderContext rather than as a
// free function because future debugging may want to mutate more than just
// Diagnostics (e.g., a counter of skipped nodes).
func (c *RenderContext) pushDiag(nodeID, severity, msg string) {
	c.Diagnostics = append(c.Diagnostics, Diagnostic{
		NodeID: nodeID, Severity: severity, Message: msg,
	})
}
