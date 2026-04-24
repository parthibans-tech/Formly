// Package doc implements the "doc" generation mode — a typed, structural
// document AST that replaces HTML + Go-template as the source of truth.
//
// Why an AST, not a template string?
// ----------------------------------
// The previous html/markdown modes stored Go-template-annotated text. That
// worked, but made several things impossible or brittle:
//
//   - Control flow (`{{ range }} … {{ end }}`, `{{ if }} … {{ end }}`) could
//     straddle block boundaries in the rich-text editor, so a user moving
//     paragraphs could silently split a loop.
//   - Field formatting was a string expression with pipe semantics, so every
//     formatter had to handle arg-order ambiguity.
//   - Errors were referenced by template line number, not by block — we could
//     not surface inline red outlines on the specific broken element.
//
// The `doc` mode stores templates as a JSON AST. Control flow is represented
// by `repeat` and `if` nodes that *contain* their children — structurally
// impossible to corrupt. Field formatting is a structured sub-object
// (`{"kind":"currency","code":"USD"}`), never a string. Errors are attached
// to AST node IDs so the editor can pin them to the right element.
//
// This file is the canonical Go-side AST definition. The TypeScript mirror
// lives at web/lib/doc/ast.ts — keep them in lockstep.
package doc

import (
	"encoding/json"
	"fmt"
)

// ASTVersion is the schema version embedded in stored documents. Bump when
// making breaking changes to node shapes; the render code should branch on
// this to support older stored docs.
const ASTVersion = 1

// StoredDoc is the wire/storage envelope. Source bytes in files storage for
// doc-mode templates MUST deserialize into this shape.
//
// ThemeCss holds per-template CSS that the renderer prepends to the preview
// iframe / PDF output. It lives alongside the AST (not inside it) so changes
// to styling never rewrite node IDs or invalidate diagnostics attached to
// the tree. Starters capture their authored `<style>` block here at import
// time; authors edit it via the designer's Theme drawer.
type StoredDoc struct {
	Version  int    `json:"version"`
	Doc      *Doc   `json:"doc"`
	ThemeCss string `json:"themeCss,omitempty"`
}

// Doc is the root of a document tree.
type Doc struct {
	Type    string  `json:"type"`    // always "doc"
	Content []Block `json:"content"` // block-level children
}

// Block is the tagged union of block-level nodes. We use json.RawMessage +
// a dispatch helper rather than reflection-heavy Unmarshaler trickery so the
// code path is easy to follow and easy to exhaustively test.
//
// The zero value is a valid "empty paragraph" so a missing Block does not
// crash the renderer — it produces an empty <p></p>.
type Block struct {
	// Discriminator — filled during unmarshalling from the node's "type"
	// field. Valid values mirror the BlockKind constants below.
	Kind BlockKind `json:"type"`

	// Stable identifier used to pin editor-side diagnostics. Optional;
	// renderer must tolerate empty IDs (existing docs may not have them).
	ID string `json:"id,omitempty"`

	// --- type-specific payloads (all optional; only the field matching Kind
	// is consulted) -------------------------------------------------------

	// Heading: h1..h6 level.
	Level int `json:"level,omitempty"`

	// Paragraph / Heading: inline children.
	Inline []Inline `json:"content,omitempty"`

	// Paragraph: text alignment. Empty = inherit.
	Align string `json:"align,omitempty"`

	// List (bulletList | orderedList): list items.
	Items []ListItem `json:"items,omitempty"`

	// Table: rows of cells.
	Rows []TableRow `json:"rows,omitempty"`

	// Image: source URL + alt text.
	Src   string `json:"src,omitempty"`
	Alt   string `json:"alt,omitempty"`
	Width int    `json:"width,omitempty"` // px; 0 = auto

	// Repeat: iteration source path and children rendered per-iteration.
	// `As` is the optional alias — when set, the iteration variable is
	// exposed at `.<as>`; otherwise items expose their fields at top-level
	// of the iteration scope.
	Source string `json:"source,omitempty"`
	As     string `json:"as,omitempty"`

	// If: condition + then/else branches. `Else` may be nil (no else).
	Condition *Condition `json:"condition,omitempty"`
	Else      []Block    `json:"else,omitempty"`

	// Repeat / If / container blocks: child blocks.
	Children []Block `json:"children,omitempty"`

	// Raw: escape hatch for literal HTML. Flagged by QA so authors know
	// they've left safe rails.
	HTML string `json:"html,omitempty"`
}

// BlockKind enumerates every valid top-level block discriminator.
type BlockKind string

const (
	BlockHeading     BlockKind = "heading"
	BlockParagraph   BlockKind = "paragraph"
	BlockBulletList  BlockKind = "bulletList"
	BlockOrderedList BlockKind = "orderedList"
	BlockTable       BlockKind = "table"
	BlockDivider     BlockKind = "divider"
	BlockImage       BlockKind = "image"
	BlockRepeat      BlockKind = "repeat"
	BlockIf          BlockKind = "if"
	BlockRaw         BlockKind = "raw"
)

// ListItem wraps the block-level content of one <li>. We model it as a list
// of blocks (not just inline) so an item can contain nested lists, code
// blocks, or even `if` branches without special casing.
type ListItem struct {
	ID      string  `json:"id,omitempty"`
	Content []Block `json:"content"`
}

// TableRow is a row of cells. Header rows are inferred from the row index
// (row 0) when `Header` is true in the first row; the renderer uses <thead>
// only when the first row carries `Header: true`.
type TableRow struct {
	ID     string      `json:"id,omitempty"`
	Header bool        `json:"header,omitempty"`
	Cells  []TableCell `json:"cells"`
}

// TableCell allows inline-only content for now. Block-level content inside
// cells (nested tables, lists) is deferred until v2 — it complicates the
// editor schema more than it's worth for this release.
type TableCell struct {
	ID     string   `json:"id,omitempty"`
	Inline []Inline `json:"content,omitempty"`
	// Rough column span; >1 renders as <td colspan="N">.
	ColSpan int `json:"colSpan,omitempty"`
}

// Inline is the tagged union of inline nodes. Text marks (bold/italic/link…)
// hang off the text node itself rather than being nested wrapper nodes, to
// keep the tree shallow and match how ProseMirror represents inline formatting.
type Inline struct {
	Kind InlineKind `json:"type"`

	// Text: content + marks.
	Text  string `json:"text,omitempty"`
	Marks []Mark `json:"marks,omitempty"`

	// Field: path into data + optional format + fallback when missing.
	Path    string       `json:"path,omitempty"`
	Format  *FieldFormat `json:"format,omitempty"`
	Default string       `json:"default,omitempty"`
}

// InlineKind enumerates inline node types.
type InlineKind string

const (
	InlineText      InlineKind = "text"
	InlineField     InlineKind = "field"
	InlineHardBreak InlineKind = "hardBreak"
)

// Mark is an inline text decoration. We keep it as a typed struct (not just
// a string) so link / color marks can carry their payload without a parallel
// "attrs" map.
type Mark struct {
	Type MarkType `json:"type"`
	Href string   `json:"href,omitempty"`  // link
	Value string  `json:"value,omitempty"` // color (CSS value)
}

// MarkType is the mark discriminator.
type MarkType string

const (
	MarkBold      MarkType = "bold"
	MarkItalic    MarkType = "italic"
	MarkUnderline MarkType = "underline"
	MarkStrike    MarkType = "strike"
	MarkCode      MarkType = "code"
	MarkLink      MarkType = "link"
	MarkColor     MarkType = "color"
)

// FieldFormat is a structured formatter spec. Unlike Go-template pipes, the
// order of parameters can never be ambiguous here — each format kind has
// explicit named fields.
type FieldFormat struct {
	Kind FormatKind `json:"kind"`

	// number | currency | percent
	Decimals *int `json:"decimals,omitempty"`

	// currency
	Code string `json:"code,omitempty"`

	// date
	Pattern string `json:"pattern,omitempty"`

	// optional i18n override; empty string uses the doc-level locale
	Locale string `json:"locale,omitempty"`
}

// FormatKind enumerates supported formatters.
type FormatKind string

const (
	FormatText     FormatKind = "text"
	FormatNumber   FormatKind = "number"
	FormatCurrency FormatKind = "currency"
	FormatDate     FormatKind = "date"
	FormatPercent  FormatKind = "percent"
)

// Condition is a comparison used by if-blocks. The structured shape means
// we never parse a user-typed expression at render time — the editor built
// the condition from dropdowns.
//
// Comparison semantics (server-side, mirrored by client):
//   - `defined`  : left path resolves to a non-nil value
//   - `truthy`   : resolved value is "truthy" per isTruthy()
//   - `empty`    : resolved value is nil / empty string / empty collection
//   - eq/ne/gt/ge/lt/le: numeric comparison when both sides parse as
//     numbers; string comparison otherwise. A right-hand boolean is only
//     used with eq/ne and compares to isTruthy(left).
type Condition struct {
	Op    CondOp      `json:"op"`
	Left  string      `json:"left"`            // path into data
	Right interface{} `json:"right,omitempty"` // literal; only used for binary ops
}

// CondOp enumerates condition operators.
type CondOp string

const (
	CondDefined CondOp = "defined"
	CondTruthy  CondOp = "truthy"
	CondEmpty   CondOp = "empty"
	CondEq      CondOp = "eq"
	CondNe      CondOp = "ne"
	CondGt      CondOp = "gt"
	CondGe      CondOp = "ge"
	CondLt      CondOp = "lt"
	CondLe      CondOp = "le"
)

// ParseStoredDoc deserializes the on-disk envelope and validates the version.
// Returns a typed error if the envelope is malformed so the handler can
// return 400 rather than 500.
func ParseStoredDoc(raw []byte) (*StoredDoc, error) {
	var s StoredDoc
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("doc: parse envelope: %w", err)
	}
	if s.Version == 0 {
		// Be lenient with older drafts that omit the version field.
		s.Version = ASTVersion
	}
	if s.Version > ASTVersion {
		return nil, fmt.Errorf("doc: unsupported ast version %d (max supported: %d)", s.Version, ASTVersion)
	}
	if s.Doc == nil {
		return nil, fmt.Errorf("doc: envelope missing `doc` field")
	}
	if s.Doc.Type != "doc" {
		return nil, fmt.Errorf("doc: root node type must be `doc`, got %q", s.Doc.Type)
	}
	return &s, nil
}

// MarshalStoredDoc is the inverse of ParseStoredDoc — kept next to its pair so
// the envelope shape lives in one file.
func MarshalStoredDoc(doc *Doc) ([]byte, error) {
	return json.Marshal(StoredDoc{Version: ASTVersion, Doc: doc})
}

// MarshalStoredDocWithTheme is like MarshalStoredDoc but also carries the
// per-template theme CSS. Kept as a second function (rather than making
// MarshalStoredDoc variadic) so the common no-theme call site stays a
// one-liner.
func MarshalStoredDocWithTheme(doc *Doc, themeCss string) ([]byte, error) {
	return json.Marshal(StoredDoc{Version: ASTVersion, Doc: doc, ThemeCss: themeCss})
}
