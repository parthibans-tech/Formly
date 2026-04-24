package doc

import (
	"sort"
	"strings"
)

// ExtractFields walks the AST and returns the sorted, de-duplicated list of
// top-level data paths referenced by the document. It replaces the regex /
// text/template/parse-based placeholder extractors used by the html and
// markdown modes.
//
// Top-level semantics match the existing ghtml.ExtractPlaceholders contract:
//   - Fields referenced at the root scope appear as-is.
//   - Fields inside a `repeat` block are rewritten back to the iterated
//     source path, so `{ repeat source="lines", children: [ field path="qty" ] }`
//     reports `lines` as a top-level placeholder, not `qty`.
//   - Fields referenced through a repeat's alias (`as: "item"`) are skipped —
//     they belong to the iteration scope, not the root.
//   - Condition paths are treated as top-level references too, so authors
//     get auto-complete on conditionally-rendered data.
func ExtractFields(d *Doc) []string {
	if d == nil {
		return []string{}
	}
	seen := map[string]bool{}
	walkBlocksForFields(d.Content, &aliasStack{}, seen)
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// aliasStack tracks the chain of `repeat.as` aliases so we can detect when
// a field path starts with an alias and therefore belongs to an inner scope.
// A plain slice-of-strings is sufficient — nesting depth for real templates
// is shallow.
type aliasStack struct{ stack []string }

func (a *aliasStack) push(alias string) { a.stack = append(a.stack, alias) }
func (a *aliasStack) pop()               { a.stack = a.stack[:len(a.stack)-1] }
func (a *aliasStack) contains(head string) bool {
	if head == "" {
		return false
	}
	for _, x := range a.stack {
		if x == head {
			return true
		}
	}
	return false
}

// walkBlocksForFields is the recursive half of ExtractFields. We pass `seen`
// by pointer so a single set captures every reference in the tree.
func walkBlocksForFields(bs []Block, aliases *aliasStack, seen map[string]bool) {
	for _, b := range bs {
		switch b.Kind {
		case BlockHeading, BlockParagraph:
			walkInlinesForFields(b.Inline, aliases, seen)
		case BlockBulletList, BlockOrderedList:
			for _, it := range b.Items {
				walkBlocksForFields(it.Content, aliases, seen)
			}
		case BlockTable:
			for _, row := range b.Rows {
				for _, c := range row.Cells {
					walkInlinesForFields(c.Inline, aliases, seen)
				}
			}
		case BlockRepeat:
			// Record the iteration source itself as a top-level field — but
			// only when it isn't an alias from a surrounding repeat.
			recordPath(b.Source, aliases, seen)
			aliases.push(b.As)
			walkBlocksForFields(b.Children, aliases, seen)
			aliases.pop()
		case BlockIf:
			if b.Condition != nil {
				recordPath(b.Condition.Left, aliases, seen)
			}
			walkBlocksForFields(b.Children, aliases, seen)
			walkBlocksForFields(b.Else, aliases, seen)
		}
	}
}

func walkInlinesForFields(inl []Inline, aliases *aliasStack, seen map[string]bool) {
	for _, i := range inl {
		if i.Kind == InlineField {
			recordPath(i.Path, aliases, seen)
		}
	}
}

// recordPath adds `path` to the seen-set unless it's empty, starts with a
// known alias (belongs to an inner scope), or has already been recorded.
func recordPath(path string, aliases *aliasStack, seen map[string]bool) {
	p := strings.TrimPrefix(path, ".")
	if p == "" {
		return
	}
	head := p
	if idx := strings.Index(p, "."); idx > 0 {
		head = p[:idx]
	}
	if aliases.contains(head) {
		return
	}
	seen[p] = true
}
