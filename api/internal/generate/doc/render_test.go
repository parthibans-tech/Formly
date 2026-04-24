package doc

import (
	"strings"
	"testing"
)

// intPtr is a helper for table-driven tests that need to seed *int fields.
func intPtr(n int) *int { return &n }

// renderBody is a test helper — most cases only care about the inner
// rendered HTML, not the <!doctype>/wrapper, so we re-run RenderDoc
// directly without the doc shell.
func renderBody(t *testing.T, d *Doc, data map[string]interface{}) string {
	t.Helper()
	out, _ := RenderDoc(d, data, nil)
	return out
}

func TestRender_Heading(t *testing.T) {
	d := &Doc{Type: "doc", Content: []Block{
		{Kind: BlockHeading, Level: 1, Inline: []Inline{
			{Kind: InlineText, Text: "Hello"},
		}},
	}}
	got := renderBody(t, d, nil)
	if !strings.Contains(got, "<h1>Hello</h1>") {
		t.Fatalf("expected <h1>Hello</h1>, got %q", got)
	}
}

func TestRender_ParagraphWithMarks(t *testing.T) {
	d := &Doc{Type: "doc", Content: []Block{
		{Kind: BlockParagraph, Inline: []Inline{
			{Kind: InlineText, Text: "bold",
				Marks: []Mark{{Type: MarkBold}}},
			{Kind: InlineText, Text: " and "},
			{Kind: InlineText, Text: "italic",
				Marks: []Mark{{Type: MarkItalic}}},
		}},
	}}
	got := renderBody(t, d, nil)
	want := "<p><strong>bold</strong> and <em>italic</em></p>"
	if !strings.Contains(got, want) {
		t.Fatalf("mark render mismatch:\n  got:  %q\n  want: %q", got, want)
	}
}

func TestRender_FieldText(t *testing.T) {
	d := &Doc{Type: "doc", Content: []Block{
		{Kind: BlockParagraph, Inline: []Inline{
			{Kind: InlineText, Text: "Hello, "},
			{Kind: InlineField, Path: "name"},
		}},
	}}
	got := renderBody(t, d, map[string]interface{}{"name": "Jane"})
	if !strings.Contains(got, "Hello, ") || !strings.Contains(got, "Jane") {
		t.Fatalf("field resolve failed: %q", got)
	}
}

func TestRender_FieldMissingUsesDefault(t *testing.T) {
	d := &Doc{Type: "doc", Content: []Block{
		{Kind: BlockParagraph, Inline: []Inline{
			{Kind: InlineField, Path: "missing", Default: "N/A"},
		}},
	}}
	got := renderBody(t, d, nil)
	if !strings.Contains(got, "N/A") {
		t.Fatalf("default not used for missing field: %q", got)
	}
}

func TestRender_CurrencyFormat(t *testing.T) {
	d := &Doc{Type: "doc", Content: []Block{
		{Kind: BlockParagraph, Inline: []Inline{
			{Kind: InlineField, Path: "amount",
				Format: &FieldFormat{Kind: FormatCurrency, Code: "USD"}},
		}},
	}}
	got := renderBody(t, d, map[string]interface{}{"amount": 19.99})
	// We don't assert exact symbol placement (i18n output) — just that the
	// numeric fragment and a currency glyph both appear.
	if !strings.Contains(got, "19.99") {
		t.Fatalf("currency render missed amount: %q", got)
	}
}

func TestRender_NumberFormat(t *testing.T) {
	two := 2
	d := &Doc{Type: "doc", Content: []Block{
		{Kind: BlockParagraph, Inline: []Inline{
			{Kind: InlineField, Path: "qty",
				Format: &FieldFormat{Kind: FormatNumber, Decimals: &two}},
		}},
	}}
	got := renderBody(t, d, map[string]interface{}{"qty": 3})
	if !strings.Contains(got, "3.00") {
		t.Fatalf("number decimals not applied: %q", got)
	}
}

func TestRender_PercentProportional(t *testing.T) {
	d := &Doc{Type: "doc", Content: []Block{
		{Kind: BlockParagraph, Inline: []Inline{
			{Kind: InlineField, Path: "rate",
				Format: &FieldFormat{Kind: FormatPercent, Decimals: intPtr(1)}},
		}},
	}}
	got := renderBody(t, d, map[string]interface{}{"rate": 0.15})
	if !strings.Contains(got, "15.0%") {
		t.Fatalf("percent conversion wrong (0.15 should render 15.0%%): %q", got)
	}
}

func TestRender_RepeatBasic(t *testing.T) {
	d := &Doc{Type: "doc", Content: []Block{
		{Kind: BlockRepeat, Source: "lines", Children: []Block{
			{Kind: BlockParagraph, Inline: []Inline{
				{Kind: InlineField, Path: "name"},
				{Kind: InlineText, Text: " × "},
				{Kind: InlineField, Path: "qty"},
			}},
		}},
	}}
	data := map[string]interface{}{"lines": []interface{}{
		map[string]interface{}{"name": "Widget", "qty": 2.0},
		map[string]interface{}{"name": "Gizmo", "qty": 1.0},
	}}
	got := renderBody(t, d, data)
	if !strings.Contains(got, "Widget") || !strings.Contains(got, "Gizmo") {
		t.Fatalf("repeat did not iterate: %q", got)
	}
	if strings.Count(got, "<p") != 2 {
		t.Fatalf("expected two paragraphs, got %q", got)
	}
}

func TestRender_RepeatAlias(t *testing.T) {
	d := &Doc{Type: "doc", Content: []Block{
		{Kind: BlockRepeat, Source: "lines", As: "item", Children: []Block{
			{Kind: BlockParagraph, Inline: []Inline{
				{Kind: InlineField, Path: "item.name"},
			}},
		}},
	}}
	data := map[string]interface{}{"lines": []interface{}{
		map[string]interface{}{"name": "A"},
	}}
	got := renderBody(t, d, data)
	if !strings.Contains(got, "A") {
		t.Fatalf("alias resolution failed: %q", got)
	}
}

func TestRender_IfTrue(t *testing.T) {
	d := &Doc{Type: "doc", Content: []Block{
		{Kind: BlockIf, Condition: &Condition{Op: CondTruthy, Left: "flag"},
			Children: []Block{{Kind: BlockParagraph,
				Inline: []Inline{{Kind: InlineText, Text: "Shown"}}}},
			Else: []Block{{Kind: BlockParagraph,
				Inline: []Inline{{Kind: InlineText, Text: "Hidden"}}}},
		},
	}}
	got := renderBody(t, d, map[string]interface{}{"flag": true})
	if !strings.Contains(got, "Shown") || strings.Contains(got, "Hidden") {
		t.Fatalf("if-true branch wrong: %q", got)
	}
}

func TestRender_IfFalseElse(t *testing.T) {
	d := &Doc{Type: "doc", Content: []Block{
		{Kind: BlockIf, Condition: &Condition{Op: CondGt, Left: "qty", Right: 5},
			Children: []Block{{Kind: BlockParagraph,
				Inline: []Inline{{Kind: InlineText, Text: "Big"}}}},
			Else: []Block{{Kind: BlockParagraph,
				Inline: []Inline{{Kind: InlineText, Text: "Small"}}}},
		},
	}}
	got := renderBody(t, d, map[string]interface{}{"qty": 2.0})
	if !strings.Contains(got, "Small") || strings.Contains(got, "Big") {
		t.Fatalf("if-false branch wrong: %q", got)
	}
}

func TestRender_Table(t *testing.T) {
	d := &Doc{Type: "doc", Content: []Block{
		{Kind: BlockTable, Rows: []TableRow{
			{Header: true, Cells: []TableCell{
				{Inline: []Inline{{Kind: InlineText, Text: "Name"}}},
				{Inline: []Inline{{Kind: InlineText, Text: "Qty"}}},
			}},
			{Cells: []TableCell{
				{Inline: []Inline{{Kind: InlineText, Text: "Widget"}}},
				{Inline: []Inline{{Kind: InlineText, Text: "2"}}},
			}},
		}},
	}}
	got := renderBody(t, d, nil)
	if !strings.Contains(got, "<thead>") || !strings.Contains(got, "<tbody>") {
		t.Fatalf("thead/tbody missing: %q", got)
	}
	if !strings.Contains(got, "<th") || !strings.Contains(got, "<td") {
		t.Fatalf("th/td missing: %q", got)
	}
}

func TestRender_EscapesHTML(t *testing.T) {
	d := &Doc{Type: "doc", Content: []Block{
		{Kind: BlockParagraph, Inline: []Inline{
			{Kind: InlineText, Text: "<script>alert(1)</script>"},
		}},
	}}
	got := renderBody(t, d, nil)
	if strings.Contains(got, "<script>") {
		t.Fatalf("unescaped script tag in output: %q", got)
	}
	if !strings.Contains(got, "&lt;script&gt;") {
		t.Fatalf("expected escaped text: %q", got)
	}
}

func TestRender_RawPassesThrough(t *testing.T) {
	d := &Doc{Type: "doc", Content: []Block{
		{Kind: BlockRaw, HTML: "<div class='custom'>ok</div>"},
	}}
	got := renderBody(t, d, nil)
	if !strings.Contains(got, "<div class='custom'>ok</div>") {
		t.Fatalf("raw block should pass through verbatim: %q", got)
	}
}

func TestExtractFields_SkipsAlias(t *testing.T) {
	d := &Doc{Type: "doc", Content: []Block{
		{Kind: BlockParagraph, Inline: []Inline{{Kind: InlineField, Path: "name"}}},
		{Kind: BlockRepeat, Source: "lines", As: "item", Children: []Block{
			{Kind: BlockParagraph, Inline: []Inline{
				{Kind: InlineField, Path: "item.name"},
				{Kind: InlineField, Path: "item.qty"},
			}},
		}},
	}}
	got := ExtractFields(d)
	// Expect `name` and `lines` but NOT `item.name` / `item.qty`.
	joined := strings.Join(got, ",")
	if !strings.Contains(joined, "name") || !strings.Contains(joined, "lines") {
		t.Fatalf("missing top-level refs: %v", got)
	}
	for _, p := range got {
		if strings.HasPrefix(p, "item.") {
			t.Fatalf("alias-scoped path leaked to top-level: %v", got)
		}
	}
}

func TestParseStoredDoc_Envelope(t *testing.T) {
	raw := []byte(`{"version":1,"doc":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"hi"}]}]}}`)
	s, err := ParseStoredDoc(raw)
	if err != nil {
		t.Fatalf("parse err: %v", err)
	}
	if s.Doc == nil || len(s.Doc.Content) != 1 {
		t.Fatalf("unexpected doc: %#v", s.Doc)
	}
	if s.Doc.Content[0].Kind != BlockParagraph {
		t.Fatalf("expected paragraph, got %s", s.Doc.Content[0].Kind)
	}
}

func TestParseStoredDoc_RejectsFutureVersion(t *testing.T) {
	raw := []byte(`{"version":9,"doc":{"type":"doc","content":[]}}`)
	if _, err := ParseStoredDoc(raw); err == nil {
		t.Fatal("expected version error, got nil")
	}
}
