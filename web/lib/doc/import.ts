/**
 * HTML + Go-template → Doc AST importer.
 *
 * This is the bridge from the old authoring format (raw HTML with embedded
 * `{{ ... }}` template expressions) to the new structured AST.  It exists
 * for two reasons:
 *   1. Migrate existing templates (starter library + anything customers
 *      have authored in HTML mode) into the new editor without forcing a
 *      hand-rewrite.
 *   2. Support paste-HTML-as-doc UX in the designer.
 *
 * Design note:  HTML can be almost anything.  Go-template control flow can
 * straddle HTML boundaries in ways the AST can't represent cleanly (e.g.
 * `{{ range }}` wrapping a subset of a `<tbody>`).  We take a tiered
 * approach: structured AST for everything we can handle precisely, and
 * fall back to a `Raw` block for anything too weird.  The importer always
 * succeeds — callers never have to check for failure — and diagnostics
 * explain what was downgraded.
 */

import type {
  Block,
  BulletList,
  Condition,
  CondOp,
  Doc,
  FieldFormat,
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
} from "./ast";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ImportDiagnostic {
  severity: "warning" | "info";
  message: string;
}

export interface ImportResult {
  doc: Doc;
  diagnostics: ImportDiagnostic[];
  /** Concatenated contents of every `<style>` block in the source, in
   *  document order.  Empty string when the source had no stylesheet.
   *  Doc mode stores this alongside the AST as `StoredDoc.themeCss`
   *  and prepends it to the rendered preview / PDF so starters keep
   *  their branded look without us inventing a theme-system mapping
   *  for every CSS property. */
  themeCss?: string;
}

export interface ImportOptions {
  /** Supply a DOMParser explicitly — required in Node environments where
   *  `globalThis.DOMParser` is absent.  A typical Node caller does:
   *
   *    import { JSDOM } from "jsdom";
   *    importHtml(src, { parser: new new JSDOM().window.DOMParser() });
   */
  parser?: DOMParser;
}

/** Convert an HTML document (or fragment) to a Doc AST.  Works in both
 *  browser and Node.  See the file header for the graceful-degradation
 *  policy. */
export function importHtml(html: string, opts: ImportOptions = {}): ImportResult {
  const ctx: ImportCtx = { diagnostics: [], expressions: [] };
  const parser = opts.parser ?? pickDOMParser();
  const { body: bodyHtml, style } = extractBody(html);
  const body = parseToBody(bodyHtml, ctx, parser);
  const doc: Doc = { type: "doc", content: [] };
  const blocks = convertChildrenToBlocks(body, ctx);
  doc.content = foldControlFlow(blocks, ctx);
  if (doc.content.length === 0) {
    doc.content = [
      { type: "paragraph", content: [{ type: "text", text: "" }] },
    ];
  }
  const result: ImportResult = { doc, diagnostics: ctx.diagnostics };
  if (style) result.themeCss = style;
  return result;
}

// ---------------------------------------------------------------------------
// Expression tokenization
// ---------------------------------------------------------------------------

type Expression =
  | { kind: "field"; path: string; format?: FieldFormat }
  | { kind: "rangeOpen"; source: string; alias?: string }
  | { kind: "ifOpen"; condition: Condition }
  | { kind: "elseMark" }
  | { kind: "endMark" }
  // Unknown / unsupported template expression — we emit this so the walker
  // can insert a visible "unsupported" marker (or a Raw block).
  | { kind: "raw"; text: string };

interface ImportCtx {
  diagnostics: ImportDiagnostic[];
  expressions: Expression[];
}

const EXPR_OPEN_TAG_RE = /<formly-x\s+data-idx="(\d+)"(?:\s+data-kind="([^"]+)")?\s*><\/formly-x>/gi;

/** Replace every `{{ ... }}` in the source HTML with a sentinel element,
 *  and remember the parsed expression in ctx.expressions[i].  We use a
 *  real element (not an HTML comment) because comments inside attributes
 *  / scripts can get stripped, whereas a made-up element gets preserved
 *  by every DOM parser we've seen. */
function preprocess(html: string, ctx: ImportCtx): string {
  // Strip Go-template comments — they're never semantically significant.
  html = html.replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, "");
  // Trim `{{- ... -}}` whitespace markers to `{{ ... }}` since we handle
  // them uniformly.
  const tokenRe = /\{\{-?\s*([\s\S]*?)\s*-?\}\}/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html)) != null) {
    out += html.slice(last, m.index);
    const expr = parseExpression(m[1], ctx);
    const idx = ctx.expressions.length;
    ctx.expressions.push(expr);
    // The sentinel is inline-safe but also block-safe — browsers will
    // place it as-is because `formly-x` is an unknown element. We add
    // a `data-kind` so post-parse passes can short-circuit classification.
    out += `<formly-x data-idx="${idx}" data-kind="${expr.kind}"></formly-x>`;
    last = m.index + m[0].length;
  }
  out += html.slice(last);
  return out;
}

function parseExpression(raw: string, ctx: ImportCtx): Expression {
  const src = raw.trim();
  if (src === "") return { kind: "raw", text: "" };

  // end / else
  if (src === "end") return { kind: "endMark" };
  if (src === "else") return { kind: "elseMark" };

  // Bare `.` — the current-scope value, conventionally used inside
  // `{{ range }}` to render the iterating item.  Emit a field with an
  // empty path, which the renderer resolves via the active scope.
  if (src === ".") return { kind: "field", path: "" };

  // range  — `range .xs` or `range $i, $v := .xs`
  const rangeMatch = /^range\s+(.+)$/.exec(src);
  if (rangeMatch) {
    const args = rangeMatch[1].trim();
    const assign = /^\$([A-Za-z_][A-Za-z0-9_]*)\s*(?:,\s*\$[A-Za-z_][A-Za-z0-9_]*)?\s*:=\s*(.+)$/.exec(
      args,
    );
    if (assign) {
      return {
        kind: "rangeOpen",
        alias: assign[1],
        source: stripDot(assign[2]),
      };
    }
    return { kind: "rangeOpen", source: stripDot(args) };
  }

  // if / with — with behaves like range over a single item; we model it
  // as an if-truthy for now. A future iteration can introduce a "with"
  // block type if users want explicit scope shift.
  const ifMatch = /^if\s+(.+)$/.exec(src);
  if (ifMatch) {
    return { kind: "ifOpen", condition: parseCondition(ifMatch[1]) };
  }
  const withMatch = /^with\s+(.+)$/.exec(src);
  if (withMatch) {
    return {
      kind: "ifOpen",
      condition: { op: "truthy", left: stripDot(withMatch[1].trim()) },
    };
  }

  // Piped field like `.x.y | formatCurrency "USD"`  OR  `.x.y`
  // We also handle leading function calls `formatCurrency .x.y "USD"`.
  const field = parseFieldExpression(src);
  if (field) return field;

  ctx.diagnostics.push({
    severity: "warning",
    message: `unsupported template expression: {{ ${src} }} (kept as raw text)`,
  });
  return { kind: "raw", text: `{{ ${src} }}` };
}

/** Parse a field-ish expression.  Returns null if the shape isn't
 *  recognisable as a field access — caller then treats it as raw. */
function parseFieldExpression(src: string): Expression | null {
  const parts = src.split("|").map((s) => s.trim());
  // Head can be ".a.b", or "fn .a.b ARGS", or "sum .items \"amount\"".
  const head = parts[0];
  const path = extractPathFromHead(head);
  if (!path) return null;
  const format = derivePipelineFormat(parts.slice(1));
  return { kind: "field", path, format };
}

/** Extract the first dotted-path argument from a head expression.  Works
 *  for `.a.b` and for `fn .a.b "x" 1.5`. */
function extractPathFromHead(head: string): string | null {
  const dotMatch = /(?<![\w$])\.[A-Za-z_][\w.]*/.exec(head);
  if (!dotMatch) return null;
  return stripDot(dotMatch[0]);
}

/** Map a pipe tail like `formatCurrency "USD"` into a FieldFormat.  We
 *  support the handful of helpers the starter library uses; everything
 *  else falls through to plain text. */
function derivePipelineFormat(pipes: string[]): FieldFormat | undefined {
  for (const p of pipes) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/.exec(p);
    if (!m) continue;
    const fn = m[1];
    const rest = m[2].trim();
    switch (fn) {
      case "formatCurrency": {
        const code = unquote(rest) || "USD";
        return { kind: "currency", code };
      }
      case "formatDate": {
        const pattern = unquote(rest) || "Jan 2, 2006";
        return { kind: "date", pattern };
      }
      case "formatNumber": {
        const dp = parseInt(unquote(rest) || "0", 10);
        return { kind: "number", decimals: isFinite(dp) ? dp : 0 };
      }
      case "formatPercent": {
        const dp = parseInt(unquote(rest) || "0", 10);
        return { kind: "percent", decimals: isFinite(dp) ? dp : 0 };
      }
    }
  }
  return undefined;
}

function unquote(s: string): string {
  const m = /^"((?:[^"\\]|\\.)*)"/.exec(s);
  return m ? m[1] : s;
}

function stripDot(s: string): string {
  return s.replace(/^\./, "").trim();
}

/** Parse an `if` argument: either `defined PATH`, `empty PATH`, a binary
 *  comparison like `eq .x "y"`, or a bare path (treated as truthy). */
function parseCondition(raw: string): Condition {
  const src = raw.trim();
  // Binary comparison functions Go templates expose natively.
  const bin = /^(eq|ne|gt|ge|lt|le)\s+(.+)$/.exec(src);
  if (bin) {
    const op = bin[1] as CondOp;
    const parts = splitArgs(bin[2]);
    if (parts.length >= 2) {
      return {
        op,
        left: stripDot(parts[0]),
        right: coerceLiteral(parts[1]),
      };
    }
  }
  // `not .x`  — invert truthy. Approximate as `empty .x`.
  const notMatch = /^not\s+(.+)$/.exec(src);
  if (notMatch) return { op: "empty", left: stripDot(notMatch[1]) };

  return { op: "truthy", left: stripDot(src) };
}

function splitArgs(s: string): string[] {
  // Tokenize on whitespace but keep quoted literals together.
  const out: string[] = [];
  const re = /"(?:[^"\\]|\\.)*"|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) != null) out.push(m[0]);
  return out;
}

function coerceLiteral(tok: string): string | number | boolean {
  if (/^"/.test(tok)) return unquote(tok);
  if (tok === "true") return true;
  if (tok === "false") return false;
  const n = Number(tok);
  if (Number.isFinite(n) && !Number.isNaN(n)) return n;
  // Fall back to a stripped path — the server-side evalCondition will
  // resolve it via scope.
  return tok.replace(/^\./, "");
}

// ---------------------------------------------------------------------------
// DOM setup
// ---------------------------------------------------------------------------

/** Yields just the inner markup of <body>, or the whole input if there's
 *  no wrapping shell, along with any `<style>` contents found anywhere
 *  in the source (head or body).  Scripts are dropped outright — we
 *  never want to execute author-supplied JS in the preview iframe or
 *  the PDF renderer.  Styles, on the other hand, are kept and returned
 *  separately so the caller can stash them on the StoredDoc envelope
 *  (see `StoredDoc.themeCss`). */
function extractBody(html: string): { body: string; style: string } {
  // Collect every <style>...</style> block in source order before we
  // remove them from the body HTML.  We concatenate with newlines so
  // multiple starters' blocks don't run together.
  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  const chunks: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = styleRe.exec(html)) != null) {
    const css = sm[1].trim();
    if (css) chunks.push(css);
  }
  const style = chunks.join("\n\n").trim();

  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const inner = bodyMatch ? bodyMatch[1] : html;
  const body = inner
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  return { body, style };
}

function parseToBody(html: string, ctx: ImportCtx, parser: DOMParser): HTMLElement {
  const processed = preprocess(html, ctx);
  const wrapped = `<!doctype html><html><body>${processed}</body></html>`;
  const doc = parser.parseFromString(wrapped, "text/html");
  const body = doc.body;
  if (!body) throw new Error("import: DOM parsed without a body");
  return body as HTMLElement;
}

/** Browser path: use the native global.  In Node (or any runtime where
 *  `DOMParser` isn't global) callers must pass `parser` explicitly. */
function pickDOMParser(): DOMParser {
  if (typeof DOMParser !== "undefined") return new DOMParser();
  throw new Error(
    "importHtml: no DOMParser available. Pass one explicitly (e.g. `new new JSDOM().window.DOMParser()` in Node).",
  );
}

// ---------------------------------------------------------------------------
// Block-level walker
// ---------------------------------------------------------------------------

/** Walk a parent element's children and emit Blocks.  Control-flow
 *  sentinels come through as "synthetic" Raw-ish blocks with a sentinel
 *  html string; the later foldControlFlow pass picks them up. */
function convertChildrenToBlocks(parent: ParentNode, ctx: ImportCtx): Block[] {
  const out: Block[] = [];
  const children = Array.from(parent.childNodes);
  for (const node of children) {
    pushBlock(node, out, ctx);
  }
  return out;
}

function pushBlock(node: Node, out: Block[], ctx: ImportCtx): void {
  if (node.nodeType === /* TEXT_NODE */ 3) {
    const text = (node.textContent ?? "").replace(/\s+/g, " ");
    if (text.trim() === "") return;
    out.push({ type: "paragraph", content: [{ type: "text", text }] });
    return;
  }
  if (node.nodeType !== /* ELEMENT_NODE */ 1) return;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  // Expression sentinels can appear at block position when a template
  // tag (range/if/else/end) lives between block siblings.  We pass them
  // through as synthetic sentinels that foldControlFlow consumes.  A
  // bare `{{ .field }}` at block position is promoted to its own
  // paragraph — it was conceptually inline but ended up alone.
  if (tag === "formly-x") {
    const expr = lookupExpr(el, ctx);
    if (!expr) return;
    if (expr.kind === "field") {
      out.push({
        type: "paragraph",
        content: [
          {
            type: "field",
            path: expr.path,
            ...(expr.format ? { format: expr.format } : {}),
          },
        ],
      });
      return;
    }
    out.push({ type: "raw", html: exprSentinelHtml(el) });
    return;
  }

  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const level = Math.max(1, Math.min(6, parseInt(tag.slice(1), 10))) as
        | 1
        | 2
        | 3
        | 4
        | 5
        | 6;
      const h: Heading = {
        type: "heading",
        level,
        content: convertInlines(el, ctx),
      };
      out.push(h);
      return;
    }
    case "p": {
      if (elementHasControlFlow(el)) {
        ctx.diagnostics.push({
          severity: "info",
          message: "<p> contains {{ if }} or {{ range }} — kept as raw HTML. Rebuild with structured blocks for rich editing.",
        });
        out.push({ type: "raw", html: reconstructRawHtml(el, ctx) });
        return;
      }
      const p: Paragraph = {
        type: "paragraph",
        content: convertInlines(el, ctx),
      };
      const align = readTextAlign(el);
      if (align) p.align = align;
      out.push(p);
      return;
    }
    case "ul": {
      if (elementHasControlFlow(el)) {
        pushListWithControlFlow(el, out, ctx, "bulletList");
        return;
      }
      const ul: BulletList = { type: "bulletList", items: readListItems(el, ctx) };
      out.push(ul);
      return;
    }
    case "ol": {
      if (elementHasControlFlow(el)) {
        pushListWithControlFlow(el, out, ctx, "orderedList");
        return;
      }
      const ol: OrderedList = {
        type: "orderedList",
        items: readListItems(el, ctx),
      };
      out.push(ol);
      return;
    }
    case "hr":
      out.push({ type: "divider" });
      return;
    case "img": {
      const src = el.getAttribute("src") ?? "";
      if (!src) return;
      const img: Image = { type: "image", src };
      const alt = el.getAttribute("alt");
      if (alt) img.alt = alt;
      const w = el.getAttribute("width");
      if (w) {
        const n = parseInt(w, 10);
        if (Number.isFinite(n) && n > 0) img.width = n;
      }
      out.push(img);
      return;
    }
    case "table": {
      pushTable(el, out, ctx);
      return;
    }
    case "br":
      // Ignore stray <br> at block level — they get absorbed into the
      // preceding paragraph's inline stream naturally during convertInlines.
      return;
    case "div":
    case "section":
    case "article":
    case "main":
    case "header":
    case "footer":
    case "nav":
    case "aside":
    case "tbody":
    case "thead":
    case "tfoot": {
      // Flatten generic containers — recurse into children.  If the
      // container holds only inline content, treat it as a paragraph —
      // unless it carries block-ish control flow we can't express
      // inline, in which case fall back to a Raw block that preserves
      // the original Go-template source.
      if (containsOnlyInline(el)) {
        if (elementHasControlFlow(el)) {
          ctx.diagnostics.push({
            severity: "info",
            message: `<${tag}> contains {{ if }} or {{ range }} — kept as raw HTML. Rebuild with structured blocks for rich editing.`,
          });
          out.push({ type: "raw", html: reconstructRawHtml(el, ctx) });
          return;
        }
        out.push({ type: "paragraph", content: convertInlines(el, ctx) });
        return;
      }
      for (const child of Array.from(el.childNodes)) {
        pushBlock(child, out, ctx);
      }
      return;
    }
    case "blockquote": {
      // We don't have a blockquote block type; represent as a paragraph
      // with a note in diagnostics.  A future iteration can add one.
      for (const child of Array.from(el.childNodes)) {
        pushBlock(child, out, ctx);
      }
      return;
    }
    default: {
      // Unknown element: if it's inline-only, convert as paragraph; else
      // recurse.  This handles things like `<span>` wrapping block content
      // in templated markup.  Same control-flow downgrade as generic
      // containers — e.g. a `<dl>` full of dt/dd interleaved with
      // `{{ if }}` should be kept as Raw rather than lose the logic.
      if (containsOnlyInline(el)) {
        if (elementHasControlFlow(el)) {
          ctx.diagnostics.push({
            severity: "info",
            message: `<${tag}> contains {{ if }} or {{ range }} — kept as raw HTML. Rebuild with structured blocks for rich editing.`,
          });
          out.push({ type: "raw", html: reconstructRawHtml(el, ctx) });
          return;
        }
        out.push({ type: "paragraph", content: convertInlines(el, ctx) });
        return;
      }
      for (const child of Array.from(el.childNodes)) {
        pushBlock(child, out, ctx);
      }
      return;
    }
  }
}

function readTextAlign(el: Element): "left" | "center" | "right" | undefined {
  const style = el.getAttribute("style") || "";
  const m = /text-align\s*:\s*(left|center|right)/i.exec(style);
  if (m) return m[1].toLowerCase() as "left" | "center" | "right";
  return undefined;
}

/** Handle `<ul>` / `<ol>` that contains template control flow.  We
 *  recognise the common `<ul>{{ range .xs }}<li>...</li>{{ end }}</ul>`
 *  shape and emit a `repeat` wrapping a single-item list.  Anything
 *  more exotic falls back to a Raw block so the authored logic isn't
 *  lost. */
function pushListWithControlFlow(
  el: Element,
  out: Block[],
  ctx: ImportCtx,
  kind: "bulletList" | "orderedList",
): void {
  // Collect non-whitespace children in source order.
  const children = Array.from(el.children);
  const sentinels: Array<{ el: Element; expr: Expression }> = [];
  const lis: Element[] = [];
  let otherCount = 0;
  for (const c of children) {
    const tag = c.tagName.toLowerCase();
    if (tag === "formly-x") {
      const expr = lookupExpr(c, ctx);
      if (expr) sentinels.push({ el: c, expr });
    } else if (tag === "li") {
      lis.push(c);
    } else {
      otherCount++;
    }
  }

  // Minimum viable pattern: first sentinel is rangeOpen, last is endMark,
  // exactly one <li>, and no other elements.
  if (
    sentinels.length === 2 &&
    sentinels[0].expr.kind === "rangeOpen" &&
    sentinels[1].expr.kind === "endMark" &&
    lis.length === 1 &&
    otherCount === 0
  ) {
    const range = sentinels[0].expr as Extract<Expression, { kind: "rangeOpen" }>;
    const liBlocks: Block[] = [];
    const li = lis[0];
    if (containsOnlyInline(li)) {
      liBlocks.push({ type: "paragraph", content: convertInlines(li, ctx) });
    } else {
      for (const cn of Array.from(li.childNodes)) pushBlock(cn, liBlocks, ctx);
    }
    const list: BulletList | OrderedList =
      kind === "bulletList"
        ? {
            type: "bulletList",
            items: [{ content: liBlocks }],
          }
        : {
            type: "orderedList",
            items: [{ content: liBlocks }],
          };
    out.push({
      type: "repeat",
      source: range.source,
      ...(range.alias ? { as: range.alias } : {}),
      children: [list],
    });
    return;
  }

  // Anything else: preserve as Raw so the original template still works.
  ctx.diagnostics.push({
    severity: "info",
    message: `<${el.tagName.toLowerCase()}> contains template control flow too complex to convert — kept as raw HTML.`,
  });
  out.push({ type: "raw", html: reconstructRawHtml(el, ctx) });
}

function readListItems(el: Element, ctx: ImportCtx): ListItem[] {
  const items: ListItem[] = [];
  for (const c of Array.from(el.children)) {
    if (c.tagName.toLowerCase() !== "li") continue;
    const inner: Block[] = [];
    if (containsOnlyInline(c)) {
      inner.push({ type: "paragraph", content: convertInlines(c, ctx) });
    } else {
      for (const child of Array.from(c.childNodes)) {
        pushBlock(child, inner, ctx);
      }
    }
    items.push({ content: inner });
  }
  return items;
}

/** Table builder with range detection.  If a table contains a range that
 *  wraps only a subset of rows, we can't encode the shape precisely, so
 *  we fall back to a Raw block (preserving the original Go-template). */
function pushTable(el: Element, out: Block[], ctx: ImportCtx): void {
  // Check for range/if markers nested inside the table at any depth —
  // those indicate control flow we can't model as structured rows.
  if (tableHasControlFlow(el)) {
    ctx.diagnostics.push({
      severity: "info",
      message:
        "table contains {{ range }} or {{ if }} — kept as raw HTML. Rebuild with a Repeat block for structured editing.",
    });
    out.push({ type: "raw", html: reconstructRawHtml(el, ctx) });
    return;
  }

  const rows: TableRow[] = [];
  // We treat <thead>/<tbody>/<tfoot> as transparent so row ordering stays
  // stable.  Cell tag (th vs td) drives the header flag per row.
  const trNodes = el.querySelectorAll("tr");
  trNodes.forEach((tr) => {
    const cells: TableCell[] = [];
    let header = false;
    for (const cell of Array.from(tr.children)) {
      const tagName = cell.tagName.toLowerCase();
      if (tagName !== "td" && tagName !== "th") continue;
      if (tagName === "th") header = true;
      const cs = cell.getAttribute("colspan");
      const tc: TableCell = {
        content: convertInlines(cell, ctx),
      };
      if (cs) {
        const n = parseInt(cs, 10);
        if (Number.isFinite(n) && n > 1) tc.colSpan = n;
      }
      cells.push(tc);
    }
    if (cells.length) rows.push({ header: header || undefined, cells });
  });
  if (rows.length) {
    const t: Table = { type: "table", rows };
    out.push(t);
  }
}

function tableHasControlFlow(el: Element): boolean {
  return elementHasControlFlow(el);
}

/** Does the element (anywhere in its subtree) contain a range / if /
 *  else / end sentinel?  Used to detect when a container element we'd
 *  otherwise convert inline-only actually carries block-ish control
 *  flow and should be downgraded to Raw. */
function elementHasControlFlow(el: Element): boolean {
  const exprs = el.querySelectorAll("formly-x");
  for (const e of Array.from(exprs)) {
    const kind = (e as HTMLElement).dataset.kind;
    if (kind === "rangeOpen" || kind === "ifOpen" || kind === "elseMark" || kind === "endMark") {
      return true;
    }
  }
  return false;
}

/** Rehydrate an element back to its original HTML — used for Raw
 *  fallback blocks.  Also restores `{{ ... }}` expressions from the
 *  sentinel so the Raw block is still a valid Go-template fragment. */
function reconstructRawHtml(el: Element, ctx: ImportCtx): string {
  let html = el.outerHTML;
  html = html.replace(
    EXPR_OPEN_TAG_RE,
    (_m, idxStr: string) => {
      const idx = parseInt(idxStr, 10);
      const expr = ctx.expressions[idx];
      return expr ? exprToTemplateSource(expr) : "";
    },
  );
  return html;
}

function exprToTemplateSource(e: Expression): string {
  switch (e.kind) {
    case "field": {
      const base = `{{ .${e.path}`;
      if (!e.format) return `${base} }}`;
      switch (e.format.kind) {
        case "currency":
          return `${base} | formatCurrency "${e.format.code}" }}`;
        case "date":
          return `${base} | formatDate "${e.format.pattern}" }}`;
        case "number":
          return `${base} | formatNumber "${e.format.decimals ?? 0}" }}`;
        case "percent":
          return `${base} | formatPercent "${e.format.decimals ?? 0}" }}`;
        default:
          return `${base} }}`;
      }
    }
    case "rangeOpen":
      return e.alias
        ? `{{ range $${e.alias} := .${e.source} }}`
        : `{{ range .${e.source} }}`;
    case "ifOpen":
      return `{{ if ${condToTemplate(e.condition)} }}`;
    case "elseMark":
      return "{{ else }}";
    case "endMark":
      return "{{ end }}";
    case "raw":
      return e.text;
  }
}

function condToTemplate(c: Condition): string {
  if (c.op === "truthy") return `.${c.left}`;
  if (c.op === "empty") return `not .${c.left}`;
  if (c.op === "defined") return `.${c.left}`;
  const rhs =
    typeof c.right === "string" ? JSON.stringify(c.right) : String(c.right);
  return `${c.op} .${c.left} ${rhs}`;
}

function containsOnlyInline(el: Element): boolean {
  const blocky = new Set([
    "p", "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "table", "tr", "td", "th", "thead", "tbody", "tfoot",
    "div", "section", "article", "header", "footer", "nav", "aside", "main",
    "hr", "blockquote", "pre",
  ]);
  for (const c of Array.from(el.children)) {
    if (blocky.has(c.tagName.toLowerCase())) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Inline walker
// ---------------------------------------------------------------------------

function convertInlines(parent: ParentNode, ctx: ImportCtx, marks: Mark[] = []): Inline[] {
  const out: Inline[] = [];
  for (const node of Array.from(parent.childNodes)) {
    pushInline(node, out, ctx, marks);
  }
  return collapseAdjacentText(out);
}

function pushInline(
  node: Node,
  out: Inline[],
  ctx: ImportCtx,
  marks: Mark[],
): void {
  if (node.nodeType === 3) {
    const text = (node.textContent ?? "").replace(/\s+/g, " ");
    if (!text) return;
    const inline: TextInline = { type: "text", text };
    if (marks.length) inline.marks = [...marks];
    out.push(inline);
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  if (tag === "formly-x") {
    const expr = lookupExpr(el, ctx);
    if (!expr) return;
    if (expr.kind === "field") {
      out.push({
        type: "field",
        path: expr.path,
        ...(expr.format ? { format: expr.format } : {}),
      });
      return;
    }
    if (expr.kind === "raw") {
      out.push({ type: "text", text: expr.text, ...(marks.length ? { marks: [...marks] } : {}) });
      return;
    }
    // Control-flow sentinels at inline position can only come from
    // intra-inline ranges (rare).  Warn and drop.
    ctx.diagnostics.push({
      severity: "warning",
      message: `template expression ${expr.kind} encountered inline — dropped`,
    });
    return;
  }

  if (tag === "br") {
    out.push({ type: "hardBreak" });
    return;
  }

  const extraMark = markFor(el);
  const nextMarks = extraMark ? [...marks, extraMark] : marks;

  // Recurse into children with (possibly) extended marks.
  for (const c of Array.from(el.childNodes)) {
    pushInline(c, out, ctx, nextMarks);
  }
}

function markFor(el: HTMLElement): Mark | null {
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "strong":
    case "b":
      return { type: "bold" };
    case "em":
    case "i":
      return { type: "italic" };
    case "u":
      return { type: "underline" };
    case "s":
    case "strike":
    case "del":
      return { type: "strike" };
    case "code":
      return { type: "code" };
    case "a":
      return { type: "link", href: el.getAttribute("href") ?? "" };
    case "span": {
      const style = el.getAttribute("style") || "";
      const m = /color\s*:\s*([^;]+)/i.exec(style);
      if (m) return { type: "color", value: m[1].trim() };
      return null;
    }
    default:
      return null;
  }
}

function collapseAdjacentText(inl: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const i of inl) {
    const last = out[out.length - 1];
    if (
      last &&
      last.type === "text" &&
      i.type === "text" &&
      sameMarks(last.marks, i.marks)
    ) {
      last.text = last.text + i.text;
      continue;
    }
    out.push(i);
  }
  return out;
}

function sameMarks(a: Mark[] | undefined, b: Mark[] | undefined): boolean {
  const la = a ?? [];
  const lb = b ?? [];
  if (la.length !== lb.length) return false;
  for (let i = 0; i < la.length; i++) {
    if (JSON.stringify(la[i]) !== JSON.stringify(lb[i])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Control-flow folding
// ---------------------------------------------------------------------------
//
// The block walker emits control-flow sentinels as `raw` blocks whose
// html field is a special marker. Here we collapse sequences of
// `[rangeOpen, ...inner, endMark]` into Repeat blocks and
// `[ifOpen, ...then, (elseMark, ...else)?, endMark]` into If blocks.
// Sentinels that don't match (unbalanced) degrade to their raw
// Go-template source so the content isn't lost.

const SENTINEL_PREFIX = "__FORMLY_EXPR_SENTINEL__:";

function exprSentinelHtml(el: Element): string {
  const idx = el.getAttribute("data-idx") || "-1";
  return `${SENTINEL_PREFIX}${idx}`;
}

function sentinelExpr(b: Block, ctx: ImportCtx): Expression | null {
  if (b.type !== "raw") return null;
  if (!b.html.startsWith(SENTINEL_PREFIX)) return null;
  const idx = parseInt(b.html.slice(SENTINEL_PREFIX.length), 10);
  return ctx.expressions[idx] ?? null;
}

function foldControlFlow(blocks: Block[], ctx: ImportCtx): Block[] {
  const [folded, consumed] = foldRange(blocks, 0, ctx, null);
  if (consumed !== blocks.length) {
    ctx.diagnostics.push({
      severity: "warning",
      message: `unbalanced template control flow — ${blocks.length - consumed} trailing blocks`,
    });
  }
  return folded;
}

/** Recursive fold.  `stopAt` indicates what ends the current run — null
 *  for the top level (runs to end), "end" for inside a range/if (runs to
 *  endMark), or "endOrElse" for inside an if-then (runs to endMark or
 *  elseMark). Returns the accumulated blocks and the number of input
 *  blocks consumed. */
function foldRange(
  blocks: Block[],
  start: number,
  ctx: ImportCtx,
  stopAt: null | "end" | "endOrElse",
): [Block[], number] {
  const out: Block[] = [];
  let i = start;
  while (i < blocks.length) {
    const b = blocks[i];
    const e = sentinelExpr(b, ctx);
    if (!e) {
      // Not a sentinel — emit as-is but also descend into nested blocks
      // (list items, if-children of earlier folds, …) to fold any nested
      // control flow.  Here we only need to descend into containers we
      // emitted directly; tables don't carry raw sentinels because we
      // detected control-flow tables up-front.
      out.push(b);
      i++;
      continue;
    }
    switch (e.kind) {
      case "raw":
        // Raw expressions at block level become a Raw block holding the
        // original source.  This preserves whatever the user wrote even
        // if we don't understand it.
        out.push({ type: "raw", html: e.text });
        i++;
        continue;
      case "field":
        // A bare field at block level (pushBlock promotes these to
        // paragraphs, so in practice we won't see one here — but keep
        // this case as a safety net so a missed sentinel can never
        // cause the fold loop to spin forever).
        out.push({
          type: "paragraph",
          content: [
            {
              type: "field",
              path: e.path,
              ...(e.format ? { format: e.format } : {}),
            },
          ],
        });
        i++;
        continue;
      case "endMark":
        if (stopAt === "end" || stopAt === "endOrElse") {
          return [out, i + 1 - start];
        }
        ctx.diagnostics.push({
          severity: "warning",
          message: "{{ end }} without a matching {{ range }}/{{ if }}",
        });
        i++;
        continue;
      case "elseMark":
        if (stopAt === "endOrElse") {
          return [out, i + 1 - start];
        }
        ctx.diagnostics.push({
          severity: "warning",
          message: "{{ else }} outside of {{ if }} block",
        });
        i++;
        continue;
      case "rangeOpen": {
        const [inner, consumed] = foldRange(blocks, i + 1, ctx, "end");
        const repeat: Repeat = {
          type: "repeat",
          source: e.source,
          ...(e.alias ? { as: e.alias } : {}),
          children: inner,
        };
        out.push(repeat);
        i = i + 1 + consumed;
        continue;
      }
      case "ifOpen": {
        const [thenBlocks, consumed1] = foldRange(
          blocks,
          i + 1,
          ctx,
          "endOrElse",
        );
        // Did we stop at `else` or `end`?  Inspect the block that closed us.
        const closer = blocks[i + consumed1];
        let elseBlocks: Block[] | undefined;
        let totalConsumed = consumed1;
        if (closer) {
          const closerExpr = sentinelExpr(closer, ctx);
          if (closerExpr?.kind === "elseMark") {
            const [elseArr, consumed2] = foldRange(
              blocks,
              i + 1 + consumed1,
              ctx,
              "end",
            );
            elseBlocks = elseArr;
            totalConsumed = consumed1 + consumed2;
          }
        }
        const iff: If = {
          type: "if",
          condition: e.condition,
          children: thenBlocks,
          ...(elseBlocks && elseBlocks.length ? { else: elseBlocks } : {}),
        };
        out.push(iff);
        i = i + 1 + totalConsumed;
        continue;
      }
    }
    // Defensive: any unmatched kind still advances the cursor so we
    // never spin.  Exhaustive switches above should already cover every
    // Expression variant, but this guards against future additions.
    i++;
  }
  if (stopAt !== null) {
    ctx.diagnostics.push({
      severity: "warning",
      message: `missing {{ end }} — ${blocks.length - start} blocks consumed as implicit body`,
    });
  }
  return [out, i - start];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lookupExpr(el: Element, ctx: ImportCtx): Expression | null {
  const idx = parseInt(el.getAttribute("data-idx") || "-1", 10);
  return ctx.expressions[idx] ?? null;
}
