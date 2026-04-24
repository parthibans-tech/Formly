/**
 * Document AST — TypeScript mirror of api/internal/generate/doc/ast.go.
 *
 * The AST is the source of truth for doc-mode templates. Both the browser
 * editor and the Go server manipulate structurally-identical JSON; keeping
 * this file in lockstep with its Go peer is how we guarantee the preview
 * iframe and the rendered PDF agree.
 *
 * Invariants (enforced by renderer / editor, not the type system):
 *  - Control flow (`repeat`, `if`) contains its children. A loop can never
 *    straddle block boundaries.
 *  - Field formats are structured objects — no pipe-expression strings.
 *  - Every node MAY carry a stable `id` used to pin diagnostics to the
 *    editor view.  IDs should be short (nanoid, 10 chars) but the renderer
 *    tolerates missing / duplicate ids without crashing.
 */

export const AST_VERSION = 1 as const;

/** On-disk storage envelope. Bytes stored in the files table deserialize
 *  into this shape for doc-mode templates. */
export interface StoredDoc {
  version: number;
  doc: Doc;
  /** Per-template CSS prepended to the rendered preview / PDF.  Lives
   *  alongside the AST (not inside it) so presentation can evolve
   *  independently of structural content.  Imported starters capture
   *  their `<style>` block here; authors edit it via the designer's
   *  Theme drawer. */
  themeCss?: string;
}

export interface Doc {
  type: "doc";
  content: Block[];
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export type Block =
  | Heading
  | Paragraph
  | BulletList
  | OrderedList
  | Table
  | Divider
  | Image
  | Repeat
  | If
  | Raw;

interface BlockCommon {
  /** Stable id used by the editor to attach diagnostics. Optional. */
  id?: string;
}

export interface Heading extends BlockCommon {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  content: Inline[];
}

export interface Paragraph extends BlockCommon {
  type: "paragraph";
  content: Inline[];
  align?: "left" | "center" | "right";
}

export interface BulletList extends BlockCommon {
  type: "bulletList";
  items: ListItem[];
}

export interface OrderedList extends BlockCommon {
  type: "orderedList";
  items: ListItem[];
}

export interface ListItem {
  id?: string;
  content: Block[];
}

export interface Table extends BlockCommon {
  type: "table";
  rows: TableRow[];
}

export interface TableRow {
  id?: string;
  header?: boolean;
  cells: TableCell[];
}

export interface TableCell {
  id?: string;
  content: Inline[];
  colSpan?: number;
}

export interface Divider extends BlockCommon {
  type: "divider";
}

export interface Image extends BlockCommon {
  type: "image";
  src: string;
  alt?: string;
  /** Render width in px. 0 or omitted = auto (original size). */
  width?: number;
}

// --- Control flow ---------------------------------------------------------

/** Iterate `source` (a path into the data map) and render `children` once
 *  per item.  If `as` is non-empty the iteration item is exposed under that
 *  key in the inner scope; otherwise its fields are merged at top-level
 *  (mirroring the Go-template range block). */
export interface Repeat extends BlockCommon {
  type: "repeat";
  source: string;
  as?: string;
  children: Block[];
}

/** Render `children` when `condition` is true; otherwise `else` (if given).
 *  An absent `else` with a false condition renders nothing — NOT an error. */
export interface If extends BlockCommon {
  type: "if";
  condition: Condition;
  children: Block[];
  else?: Block[];
}

/** Escape hatch.  The QA panel flags raw blocks so authors know they've left
 *  the safe rails. */
export interface Raw extends BlockCommon {
  type: "raw";
  html: string;
}

// ---------------------------------------------------------------------------
// Inlines
// ---------------------------------------------------------------------------

export type Inline = TextInline | FieldInline | HardBreak;

export interface TextInline {
  type: "text";
  text: string;
  marks?: Mark[];
}

/** Data-bound inline.  `path` is dotted JSON-ish (e.g. "invoice.total").
 *  `format` drives display; `default` is shown when the path is missing. */
export interface FieldInline {
  type: "field";
  path: string;
  format?: FieldFormat;
  default?: string;
}

export interface HardBreak {
  type: "hardBreak";
}

// ---------------------------------------------------------------------------
// Marks (inline text decorations)
// ---------------------------------------------------------------------------

export type Mark =
  | { type: "bold" }
  | { type: "italic" }
  | { type: "underline" }
  | { type: "strike" }
  | { type: "code" }
  | { type: "link"; href: string }
  | { type: "color"; value: string };

// ---------------------------------------------------------------------------
// Field formatting
// ---------------------------------------------------------------------------

export type FieldFormat =
  | { kind: "text" }
  | { kind: "number"; decimals?: number; locale?: string }
  | { kind: "currency"; code: string; locale?: string }
  | { kind: "date"; pattern: string; locale?: string }
  | { kind: "percent"; decimals?: number; locale?: string };

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/** Unary + binary condition operators.  Semantics match Go-side evalCondition.
 *   - defined: path resolves to a non-undefined value
 *   - truthy:  isTruthy(value)
 *   - empty:   value is null / "" / [] / {}
 *   - eq/ne/gt/ge/lt/le: numeric compare when both sides parse as numbers;
 *     otherwise string compare. */
export type CondOp =
  | "defined"
  | "truthy"
  | "empty"
  | "eq"
  | "ne"
  | "gt"
  | "ge"
  | "lt"
  | "le";

export interface Condition {
  op: CondOp;
  left: string;
  right?: string | number | boolean;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/** Minimal shape check — does NOT walk the tree for semantic validity (that's
 *  the renderer's job, and it's deliberately tolerant).  Returns null on
 *  success, or a short error message describing the first structural problem
 *  found.  Useful for rejecting malformed API payloads before storing them. */
export function validateStoredDoc(s: unknown): string | null {
  if (!s || typeof s !== "object") return "envelope must be an object";
  const env = s as Partial<StoredDoc>;
  if (env.version != null && typeof env.version !== "number") {
    return "version must be a number";
  }
  if (env.version != null && env.version > AST_VERSION) {
    return `unsupported version ${env.version} (max ${AST_VERSION})`;
  }
  if (!env.doc || typeof env.doc !== "object") return "missing `doc`";
  if ((env.doc as Doc).type !== "doc") return "root node type must be 'doc'";
  if (!Array.isArray((env.doc as Doc).content)) return "doc.content must be an array";
  if (env.themeCss != null && typeof env.themeCss !== "string") {
    return "themeCss must be a string";
  }
  return null;
}

/** Wrap a Doc in the versioned envelope for storage.  `themeCss` is
 *  stored alongside the tree, not inside it, so changing the CSS never
 *  rewrites node IDs or invalidates diagnostics attached to the AST. */
export function wrapStoredDoc(doc: Doc, themeCss?: string): StoredDoc {
  const env: StoredDoc = { version: AST_VERSION, doc };
  if (themeCss && themeCss.trim() !== "") env.themeCss = themeCss;
  return env;
}

/** Sensible default for "create new empty doc". */
export function emptyDoc(): Doc {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "" }] }],
  };
}
