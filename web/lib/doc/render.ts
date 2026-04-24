/**
 * Client-side AST → HTML renderer.  Mirror of api/internal/generate/doc/render.go.
 *
 * This runs in the browser for live-preview updates (no server round-trip
 * for every keystroke).  It MUST produce output byte-compatible with the
 * server renderer — otherwise authors see flicker between the in-editor
 * preview and the post-save rendered HTML.  The test suite in render.test.ts
 * pins this invariant with paired fixtures.
 */

import type {
  Block,
  Condition,
  Doc,
  FieldFormat,
  Inline,
  Mark,
  TableRow,
} from "./ast";
import {
  evalCondition,
  formatField,
  iterItems,
  pushScope,
  resolvePath,
  rootScope,
  type Scope,
} from "./eval";

export interface Diagnostic {
  nodeId?: string;
  severity: "error" | "warning";
  message: string;
}

export interface RenderOptions {
  /** Data map used to resolve field references. */
  data?: Record<string, unknown>;
  /** Doc-level locale for formatters (currency, dates). */
  locale?: string;
}

export interface RenderResult {
  html: string;
  diagnostics: Diagnostic[];
}

/** Render `doc` to inner-body HTML.  The caller decides whether to wrap in
 *  a document shell (usually the preview iframe does via wrapInDocument). */
export function renderDoc(doc: Doc, opts: RenderOptions = {}): RenderResult {
  const ctx: RenderContext = {
    locale: opts.locale ?? "en-US",
    diagnostics: [],
  };
  const scope = rootScope(opts.data ?? {});
  const parts: string[] = [];
  for (const b of doc.content) {
    parts.push(renderBlock(b, scope, ctx));
  }
  return { html: parts.join(""), diagnostics: ctx.diagnostics };
}

interface RenderContext {
  locale: string;
  diagnostics: Diagnostic[];
}

function pushDiag(
  ctx: RenderContext,
  severity: "error" | "warning",
  message: string,
  nodeId?: string,
): void {
  ctx.diagnostics.push({ severity, message, nodeId });
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function renderBlock(b: Block, scope: Scope, ctx: RenderContext): string {
  switch (b.type) {
    case "heading":
      return renderHeading(b, scope, ctx);
    case "paragraph":
      return renderParagraph(b, scope, ctx);
    case "bulletList":
      return renderList(b.items, "ul", b.id, scope, ctx);
    case "orderedList":
      return renderList(b.items, "ol", b.id, scope, ctx);
    case "table":
      return renderTable(b.rows, b.id, scope, ctx);
    case "divider":
      return "<hr />\n";
    case "image":
      return renderImage(b, ctx);
    case "repeat":
      return renderRepeat(b, scope, ctx);
    case "if":
      return renderIf(b, scope, ctx);
    case "raw":
      return b.html;
    default: {
      // Exhaustive-check escape: if a new block type is added, TS will
      // flag this branch at compile time.
      const _never: never = b;
      void _never;
      return "";
    }
  }
}

function renderHeading(
  b: { level: number; content: Inline[]; id?: string },
  scope: Scope,
  ctx: RenderContext,
): string {
  const lvl = Math.min(6, Math.max(1, b.level || 1));
  return `<h${lvl}${nodeAttr(b.id)}>${renderInlines(b.content, scope, ctx)}</h${lvl}>\n`;
}

function renderParagraph(
  b: { content: Inline[]; align?: string; id?: string },
  scope: Scope,
  ctx: RenderContext,
): string {
  let style = "";
  if (b.align === "center") style = ' style="text-align:center"';
  else if (b.align === "right") style = ' style="text-align:right"';
  else if (b.align === "left") style = ' style="text-align:left"';
  return `<p${nodeAttr(b.id)}${style}>${renderInlines(b.content, scope, ctx)}</p>\n`;
}

function renderList(
  items: { id?: string; content: Block[] }[],
  tag: "ul" | "ol",
  id: string | undefined,
  scope: Scope,
  ctx: RenderContext,
): string {
  const parts: string[] = [`<${tag}${nodeAttr(id)}>\n`];
  for (const it of items) {
    parts.push(`<li${nodeAttr(it.id)}>`);
    if (it.content.length === 1 && it.content[0].type === "paragraph") {
      // Flatten single-paragraph items to match the server renderer.
      parts.push(renderInlines(it.content[0].content, scope, ctx));
    } else {
      for (const c of it.content) parts.push(renderBlock(c, scope, ctx));
    }
    parts.push("</li>\n");
  }
  parts.push(`</${tag}>\n`);
  return parts.join("");
}

function renderTable(
  rows: TableRow[],
  id: string | undefined,
  scope: Scope,
  ctx: RenderContext,
): string {
  if (rows.length === 0) return `<table${nodeAttr(id)}></table>\n`;
  const parts: string[] = [`<table${nodeAttr(id)}>\n`];
  const firstIsHeader = !!rows[0].header;
  if (firstIsHeader) {
    parts.push("<thead>");
    parts.push(renderTableRow(rows[0], scope, ctx, true));
    parts.push("</thead>\n<tbody>\n");
    for (let i = 1; i < rows.length; i++) {
      parts.push(renderTableRow(rows[i], scope, ctx, false));
    }
    parts.push("</tbody>\n");
  } else {
    parts.push("<tbody>\n");
    for (const row of rows) {
      parts.push(renderTableRow(row, scope, ctx, !!row.header));
    }
    parts.push("</tbody>\n");
  }
  parts.push("</table>\n");
  return parts.join("");
}

function renderTableRow(
  row: TableRow,
  scope: Scope,
  ctx: RenderContext,
  isHeader: boolean,
): string {
  const tag = isHeader ? "th" : "td";
  const parts: string[] = [`<tr${nodeAttr(row.id)}>`];
  for (const c of row.cells) {
    const cs = c.colSpan && c.colSpan > 1 ? ` colspan="${c.colSpan}"` : "";
    parts.push(`<${tag}${nodeAttr(c.id)}${cs}>`);
    parts.push(renderInlines(c.content, scope, ctx));
    parts.push(`</${tag}>`);
  }
  parts.push("</tr>\n");
  return parts.join("");
}

function renderImage(
  b: { src: string; alt?: string; width?: number; id?: string },
  ctx: RenderContext,
): string {
  if (!b.src) {
    pushDiag(ctx, "warning", "image block missing src", b.id);
    return "";
  }
  const w = b.width && b.width > 0 ? ` width="${b.width}"` : "";
  return `<img${nodeAttr(b.id)} src="${escapeAttr(b.src)}" alt="${escapeAttr(b.alt ?? "")}"${w} />\n`;
}

function renderRepeat(
  b: { source: string; as?: string; children: Block[]; id?: string },
  scope: Scope,
  ctx: RenderContext,
): string {
  if (!b.source) {
    pushDiag(ctx, "error", "repeat block missing source path", b.id);
    return "";
  }
  const raw = resolvePath(scope, b.source);
  const items = iterItems(raw);
  if (!items) return "";
  const parts: string[] = [];
  for (const item of items) {
    const inner = pushScope(scope, item, b.as ?? "");
    for (const c of b.children) parts.push(renderBlock(c, inner, ctx));
  }
  return parts.join("");
}

function renderIf(
  b: { condition: Condition; children: Block[]; else?: Block[]; id?: string },
  scope: Scope,
  ctx: RenderContext,
): string {
  if (!b.condition) {
    pushDiag(ctx, "error", "if block missing condition", b.id);
    return "";
  }
  const branch = evalCondition(b.condition, scope) ? b.children : (b.else ?? []);
  return branch.map((c) => renderBlock(c, scope, ctx)).join("");
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

function renderInlines(inl: Inline[], scope: Scope, ctx: RenderContext): string {
  const parts: string[] = [];
  for (const i of inl) {
    switch (i.type) {
      case "text":
        parts.push(writeTextWithMarks(i.text, i.marks));
        break;
      case "hardBreak":
        parts.push("<br />");
        break;
      case "field":
        parts.push(renderField(i, scope, ctx));
        break;
    }
  }
  return parts.join("");
}

function writeTextWithMarks(text: string, marks?: Mark[]): string {
  if (!text && (!marks || marks.length === 0)) return "";
  const { opens, closes } = marksToTags(marks ?? []);
  const body = escapeText(text);
  // Close in reverse so tags nest correctly.
  return opens.join("") + body + closes.slice().reverse().join("");
}

function marksToTags(marks: Mark[]): { opens: string[]; closes: string[] } {
  const opens: string[] = [];
  const closes: string[] = [];
  for (const m of marks) {
    switch (m.type) {
      case "bold":
        opens.push("<strong>");
        closes.push("</strong>");
        break;
      case "italic":
        opens.push("<em>");
        closes.push("</em>");
        break;
      case "underline":
        opens.push("<u>");
        closes.push("</u>");
        break;
      case "strike":
        opens.push("<s>");
        closes.push("</s>");
        break;
      case "code":
        opens.push("<code>");
        closes.push("</code>");
        break;
      case "link":
        opens.push(`<a href="${escapeAttr(m.href || "#")}">`);
        closes.push("</a>");
        break;
      case "color":
        if (m.value) {
          opens.push(`<span style="color:${escapeAttr(m.value)}">`);
          closes.push("</span>");
        }
        break;
    }
  }
  return { opens, closes };
}

function renderField(
  i: { path: string; format?: FieldFormat; default?: string },
  scope: Scope,
  ctx: RenderContext,
): string {
  const v = resolvePath(scope, i.path);
  if (v === undefined) {
    pushDiag(ctx, "warning", `field "${i.path}" not found in data`);
  }
  const out = formatField(v, i.format, i.default, ctx.locale);
  return `<span data-formly-field="${escapeAttr(i.path)}">${escapeText(out)}</span>`;
}

// ---------------------------------------------------------------------------
// Escaping helpers
// ---------------------------------------------------------------------------

function escapeText(s: string): string {
  // html.EscapeString-compatible: & < > ' "
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#39;")
    .replace(/"/g, "&#34;");
}

function escapeAttr(s: string): string {
  return escapeText(s);
}

function nodeAttr(id: string | undefined): string {
  if (!id) return "";
  return ` data-formly-node="${escapeAttr(id)}"`;
}

// ---------------------------------------------------------------------------
// Preview helpers
// ---------------------------------------------------------------------------

/** Wrap a rendered body in the preview document shell.  Must stay visually
 *  aligned with the Go side's wrapInDocument; small deltas are OK (class
 *  names, commented regions) but typography and spacing should match.
 *
 *  `themeCss`, when provided, is appended AFTER the base stylesheet so
 *  per-template styles override shell defaults. Pass it through verbatim
 *  from `StoredDoc.themeCss`. */
export function wrapInDocument(body: string, themeCss?: string): string {
  const theme =
    themeCss && themeCss.trim() !== ""
      ? `<style data-formly-theme>\n${themeCss}\n</style>\n`
      : "";
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
  [data-formly-field] { background: transparent; }
  @media print { body { padding: 24px; max-width: none; } }
</style>
${theme}</head>
<body>
${body}
</body>
</html>`;
}
