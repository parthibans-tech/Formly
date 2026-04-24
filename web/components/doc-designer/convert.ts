/**
 * AST ↔ TipTap-JSON converters.
 *
 * The doc-designer stores its canonical form as `Doc` (lib/doc/ast.ts).
 * TipTap manipulates its own ProseMirror JSON shape.  These converters
 * are the bridge.
 *
 * Round-trip contract:
 *   doc → tiptap → doc  MUST be structurally identical for any Doc the
 *   editor can emit (i.e. anything the schema accepts).  The unit tests
 *   in convert.test.ts pin this property.
 *
 * Why not reuse TipTap-JSON as the storage format directly?
 *   - TipTap's schema is editor-centric: it includes cursor anchors, mark
 *     ordering implementation details, and attribute storage that's tuned
 *     for ProseMirror transactions.  Our renderer (render.ts / render.go)
 *     wants a narrow, hand-designed shape it can guarantee semantics for.
 *   - Decoupling lets the editor evolve (upgrade TipTap, swap for a
 *     different rich-text kernel) without a migration of stored docs.
 */

import type {
  Block,
  BulletList,
  Condition,
  Doc,
  FieldFormat,
  FieldInline,
  Heading,
  If,
  Image,
  Inline,
  ListItem,
  Mark,
  OrderedList,
  Paragraph,
  Raw,
  Repeat,
  Table,
  TableCell,
  TableRow,
  TextInline,
} from "@/lib/doc/ast";
import {
  parseCondition,
  stringifyCondition,
} from "./extensions/if";
import {
  parseFormat,
  stringifyFormat,
} from "./extensions/field";

// ---------------------------------------------------------------------------
// TipTap-JSON shapes
// ---------------------------------------------------------------------------
// We keep this loose (not tied to TipTap's TS types) because the shape is
// simple and we don't want to import JSONContent transitively just for
// runtime conversion.

export interface TTNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TTNode[];
  marks?: TTMark[];
  text?: string;
}

export interface TTMark {
  type: string;
  attrs?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// AST → TipTap
// ---------------------------------------------------------------------------

export function docToTipTap(doc: Doc): TTNode {
  return {
    type: "doc",
    content: doc.content.map(blockToTT),
  };
}

function blockToTT(b: Block): TTNode {
  switch (b.type) {
    case "heading":
      return {
        type: "heading",
        attrs: withId({ level: b.level }, b.id),
        content: inlinesToTT(b.content),
      };
    case "paragraph":
      return {
        type: "paragraph",
        attrs: withId(
          b.align ? { textAlign: b.align } : {},
          b.id,
        ),
        content: inlinesToTT(b.content),
      };
    case "bulletList":
      return {
        type: "bulletList",
        attrs: withId({}, b.id),
        content: b.items.map(listItemToTT),
      };
    case "orderedList":
      return {
        type: "orderedList",
        attrs: withId({}, b.id),
        content: b.items.map(listItemToTT),
      };
    case "table":
      return {
        type: "table",
        attrs: withId({}, b.id),
        content: b.rows.map(rowToTT),
      };
    case "divider":
      return { type: "horizontalRule", attrs: withId({}, b.id) };
    case "image":
      return {
        type: "image",
        attrs: withId(
          {
            src: b.src,
            alt: b.alt ?? null,
            width: b.width ?? null,
          },
          b.id,
        ),
      };
    case "repeat":
      return {
        type: "repeat",
        attrs: withId({ source: b.source, as: b.as ?? "" }, b.id),
        content: b.children.length
          ? b.children.map(blockToTT)
          : [seedParagraph()],
      };
    case "if":
      return ifToTT(b);
    case "raw":
      // Raw HTML doesn't have a rich-editor representation; we surface it
      // as a read-only paragraph holding the HTML verbatim.  The converter
      // round-trips it back to a raw block on the way out.
      return {
        type: "paragraph",
        attrs: withId({ rawHtml: b.html }, b.id),
        content: [{ type: "text", text: b.html }],
      };
    default: {
      const _never: never = b;
      void _never;
      return { type: "paragraph", content: [] };
    }
  }
}

function listItemToTT(it: ListItem): TTNode {
  return {
    type: "listItem",
    attrs: withId({}, it.id),
    content: it.content.length ? it.content.map(blockToTT) : [seedParagraph()],
  };
}

function rowToTT(r: TableRow): TTNode {
  return {
    type: "tableRow",
    attrs: withId({}, r.id),
    content: r.cells.map((c) => ({
      type: r.header ? "tableHeader" : "tableCell",
      attrs: withId(
        c.colSpan && c.colSpan > 1 ? { colspan: c.colSpan } : {},
        c.id,
      ),
      // Cell content in the AST is Inline[]; TipTap's table cell wants
      // Block content — wrap inlines in a paragraph.
      content: [
        {
          type: "paragraph",
          content: inlinesToTT(c.content),
        },
      ],
    })),
  };
}

function ifToTT(b: If): TTNode {
  const children: TTNode[] = [
    {
      type: "ifBranch",
      content: b.children.length
        ? b.children.map(blockToTT)
        : [seedParagraph()],
    },
  ];
  if (b.else && b.else.length) {
    children.push({
      type: "elseBranch",
      content: b.else.map(blockToTT),
    });
  }
  return {
    type: "if",
    attrs: withId({ condition: stringifyCondition(b.condition) ?? "" }, b.id),
    content: children,
  };
}

function inlinesToTT(inl: Inline[]): TTNode[] {
  const out: TTNode[] = [];
  for (const i of inl) {
    switch (i.type) {
      case "text":
        // Empty text runs are valid in our AST (they carry marks only
        // occasionally) but ProseMirror forbids empty text nodes — skip.
        if (!i.text) continue;
        out.push({
          type: "text",
          text: i.text,
          ...(i.marks && i.marks.length
            ? { marks: i.marks.map(markToTT) }
            : {}),
        });
        break;
      case "hardBreak":
        out.push({ type: "hardBreak" });
        break;
      case "field":
        out.push({
          type: "field",
          attrs: {
            path: i.path,
            format: stringifyFormat(i.format),
            default: i.default ?? undefined,
          },
        });
        break;
    }
  }
  return out;
}

function markToTT(m: Mark): TTMark {
  switch (m.type) {
    case "bold":
    case "italic":
    case "underline":
    case "strike":
    case "code":
      return { type: m.type };
    case "link":
      return { type: "link", attrs: { href: m.href } };
    case "color":
      return { type: "textStyle", attrs: { color: m.value } };
  }
}

function withId(attrs: Record<string, unknown>, id?: string): Record<string, unknown> {
  if (!id) return attrs;
  return { ...attrs, id };
}

function seedParagraph(): TTNode {
  return { type: "paragraph", content: [] };
}

// ---------------------------------------------------------------------------
// TipTap → AST
// ---------------------------------------------------------------------------

export function tipTapToDoc(node: TTNode): Doc {
  if (node.type !== "doc") {
    // Be defensive: callers sometimes hand us a fragment.  Wrap.
    return { type: "doc", content: [ttToBlock(node)].filter(Boolean) as Block[] };
  }
  const content: Block[] = [];
  for (const c of node.content ?? []) {
    const b = ttToBlock(c);
    if (b) content.push(b);
  }
  return { type: "doc", content };
}

function ttToBlock(n: TTNode): Block | null {
  switch (n.type) {
    case "heading": {
      const level = clampLevel(n.attrs?.level);
      const h: Heading = {
        type: "heading",
        level,
        content: ttToInlines(n.content ?? []),
      };
      attachId(h, n);
      return h;
    }
    case "paragraph": {
      // Handle the raw-HTML escape hatch we round-tripped through
      // paragraph.rawHtml above.
      if (typeof n.attrs?.rawHtml === "string" && (n.attrs.rawHtml as string).length > 0) {
        const r: Raw = { type: "raw", html: String(n.attrs.rawHtml) };
        attachId(r, n);
        return r;
      }
      const p: Paragraph = {
        type: "paragraph",
        content: ttToInlines(n.content ?? []),
      };
      const align = n.attrs?.textAlign;
      if (align === "left" || align === "center" || align === "right") {
        p.align = align;
      }
      attachId(p, n);
      return p;
    }
    case "bulletList": {
      const bl: BulletList = {
        type: "bulletList",
        items: (n.content ?? []).map(ttToListItem),
      };
      attachId(bl, n);
      return bl;
    }
    case "orderedList": {
      const ol: OrderedList = {
        type: "orderedList",
        items: (n.content ?? []).map(ttToListItem),
      };
      attachId(ol, n);
      return ol;
    }
    case "table": {
      const t: Table = {
        type: "table",
        rows: (n.content ?? []).map(ttToRow),
      };
      attachId(t, n);
      return t;
    }
    case "horizontalRule": {
      const d: Block = { type: "divider" };
      attachId(d, n);
      return d;
    }
    case "image": {
      const src = String(n.attrs?.src ?? "");
      if (!src) return null;
      const img: Image = { type: "image", src };
      const alt = n.attrs?.alt;
      if (typeof alt === "string") img.alt = alt;
      const w = n.attrs?.width;
      if (typeof w === "number" && w > 0) img.width = w;
      attachId(img, n);
      return img;
    }
    case "repeat": {
      const r: Repeat = {
        type: "repeat",
        source: String(n.attrs?.source ?? ""),
        children: (n.content ?? [])
          .map(ttToBlock)
          .filter(Boolean) as Block[],
      };
      const as = n.attrs?.as;
      if (typeof as === "string" && as.length > 0) r.as = as;
      attachId(r, n);
      return r;
    }
    case "if": {
      const cond =
        parseCondition(n.attrs?.condition as string | undefined) ?? ({
          op: "truthy",
          left: "",
        } as Condition);
      const children = n.content ?? [];
      const thenBranch = children.find((c) => c.type === "ifBranch");
      const elseBranch = children.find((c) => c.type === "elseBranch");
      const iff: If = {
        type: "if",
        condition: cond,
        children: (thenBranch?.content ?? [])
          .map(ttToBlock)
          .filter(Boolean) as Block[],
      };
      if (elseBranch && elseBranch.content && elseBranch.content.length) {
        iff.else = elseBranch.content.map(ttToBlock).filter(Boolean) as Block[];
      }
      attachId(iff, n);
      return iff;
    }
    default:
      // Unknown node type — drop silently.  Authors can't introduce these
      // via the UI, so we're only defending against bad paste payloads.
      return null;
  }
}

function ttToListItem(n: TTNode): ListItem {
  return {
    id: typeof n.attrs?.id === "string" ? (n.attrs.id as string) : undefined,
    content: (n.content ?? []).map(ttToBlock).filter(Boolean) as Block[],
  };
}

function ttToRow(n: TTNode): TableRow {
  const isHeader = (n.content ?? []).every((c) => c.type === "tableHeader");
  const cells: TableCell[] = (n.content ?? []).map((c): TableCell => {
    // Cells carry a single paragraph containing the inlines.
    const para = (c.content ?? []).find((x) => x.type === "paragraph");
    const inl = ttToInlines(para?.content ?? []);
    const cell: TableCell = { content: inl };
    const cs = c.attrs?.colspan;
    if (typeof cs === "number" && cs > 1) cell.colSpan = cs;
    if (typeof c.attrs?.id === "string") cell.id = c.attrs.id as string;
    return cell;
  });
  return {
    id: typeof n.attrs?.id === "string" ? (n.attrs.id as string) : undefined,
    header: isHeader || undefined,
    cells,
  };
}

function ttToInlines(nodes: TTNode[]): Inline[] {
  const out: Inline[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case "text": {
        if (!n.text) continue;
        const t: TextInline = { type: "text", text: n.text };
        if (n.marks && n.marks.length) {
          const marks = n.marks.map(ttMarkToMark).filter(Boolean) as Mark[];
          if (marks.length) t.marks = marks;
        }
        out.push(t);
        break;
      }
      case "hardBreak":
        out.push({ type: "hardBreak" });
        break;
      case "field": {
        const path = String(n.attrs?.path ?? "");
        const f: FieldInline = { type: "field", path };
        const fmt = parseFormat(n.attrs?.format as string | undefined);
        if (fmt) f.format = fmt as FieldFormat;
        const dflt = n.attrs?.default;
        if (typeof dflt === "string" && dflt !== "") f.default = dflt;
        out.push(f);
        break;
      }
      default:
        // Skip unknown inline types.
        break;
    }
  }
  return out;
}

function ttMarkToMark(m: TTMark): Mark | null {
  switch (m.type) {
    case "bold":
    case "italic":
    case "underline":
    case "strike":
    case "code":
      return { type: m.type };
    case "link":
      return { type: "link", href: String(m.attrs?.href ?? "") };
    case "textStyle": {
      const color = m.attrs?.color;
      if (typeof color === "string" && color.length) {
        return { type: "color", value: color };
      }
      return null;
    }
    default:
      return null;
  }
}

function clampLevel(v: unknown): 1 | 2 | 3 | 4 | 5 | 6 {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 1;
  const c = Math.max(1, Math.min(6, Math.trunc(n)));
  return c as 1 | 2 | 3 | 4 | 5 | 6;
}

function attachId(target: { id?: string }, n: TTNode): void {
  const id = n.attrs?.id;
  if (typeof id === "string" && id.length > 0) target.id = id;
}
