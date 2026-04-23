// Minimal Go-template-like renderer for starter thumbnails.
// Handles: {{ .path }}, {{ range .list }}...{{ end }}, {{ if .flag }}...{{ end }},
// {{ if eq .x "y" }}, and the formatCurrency / formatDate / formatNumber pipes.
// Not feature-complete — server-side Preview is the authoritative renderer.
// This only exists so the starter gallery can show a readable thumbnail before
// any template is created in the user's workspace.

type Ctx = Record<string, unknown>;

export function miniRender(src: string, data: Ctx): string {
  return evalBlock(src, data);
}

// Entry point + recursive evaluator.
function evalBlock(src: string, data: Ctx): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const start = src.indexOf("{{", i);
    if (start === -1) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, start);
    const end = src.indexOf("}}", start + 2);
    if (end === -1) {
      out += src.slice(start);
      break;
    }
    const expr = src.slice(start + 2, end).trim();

    // range block
    if (expr.startsWith("range ")) {
      const path = expr.slice("range ".length).trim();
      const close = findMatchingEnd(src, end + 2);
      if (close === -1) {
        i = end + 2;
        continue;
      }
      const inner = src.slice(end + 2, close.start);
      const items = resolvePath(data, path);
      if (Array.isArray(items)) {
        for (const item of items) {
          out += evalBlock(inner, item as Ctx);
        }
      }
      i = close.endIdx;
      continue;
    }

    // if block
    if (expr.startsWith("if ")) {
      const cond = expr.slice("if ".length).trim();
      const close = findMatchingEnd(src, end + 2);
      if (close === -1) {
        i = end + 2;
        continue;
      }
      const fullInner = src.slice(end + 2, close.start);
      const elseIdx = findElse(fullInner);
      const truthy = evalCondition(cond, data);
      if (truthy) {
        const inner =
          elseIdx !== -1 ? fullInner.slice(0, elseIdx.start) : fullInner;
        out += evalBlock(inner, data);
      } else if (elseIdx !== -1) {
        out += evalBlock(fullInner.slice(elseIdx.end), data);
      }
      i = close.endIdx;
      continue;
    }

    // with block
    if (expr.startsWith("with ")) {
      const path = expr.slice("with ".length).trim();
      const close = findMatchingEnd(src, end + 2);
      if (close === -1) {
        i = end + 2;
        continue;
      }
      const inner = src.slice(end + 2, close.start);
      const v = resolvePath(data, path);
      if (v && typeof v === "object") {
        out += evalBlock(inner, v as Ctx);
      }
      i = close.endIdx;
      continue;
    }

    // end / else at wrong nesting — skip
    if (expr === "end" || expr === "else") {
      i = end + 2;
      continue;
    }

    // expression
    out += renderExpr(expr, data);
    i = end + 2;
  }
  return out;
}

function findMatchingEnd(
  src: string,
  from: number
): { start: number; endIdx: number } | -1 {
  let i = from;
  let depth = 0;
  while (i < src.length) {
    const next = src.indexOf("{{", i);
    if (next === -1) return -1;
    const close = src.indexOf("}}", next + 2);
    if (close === -1) return -1;
    const expr = src.slice(next + 2, close).trim();
    if (
      expr.startsWith("range ") ||
      expr.startsWith("if ") ||
      expr.startsWith("with ")
    ) {
      depth++;
    } else if (expr === "end") {
      if (depth === 0) return { start: next, endIdx: close + 2 };
      depth--;
    }
    i = close + 2;
  }
  return -1;
}

function findElse(
  inner: string
): { start: number; end: number } | -1 {
  let i = 0;
  let depth = 0;
  while (i < inner.length) {
    const next = inner.indexOf("{{", i);
    if (next === -1) return -1;
    const close = inner.indexOf("}}", next + 2);
    if (close === -1) return -1;
    const expr = inner.slice(next + 2, close).trim();
    if (
      expr.startsWith("range ") ||
      expr.startsWith("if ") ||
      expr.startsWith("with ")
    ) {
      depth++;
    } else if (expr === "end") {
      depth--;
    } else if (expr === "else" && depth === 0) {
      return { start: next, end: close + 2 };
    }
    i = close + 2;
  }
  return -1;
}

function evalCondition(cond: string, data: Ctx): boolean {
  // support "eq .x "y"" / "ne" / "gt" / "lt"
  const cmpMatch = cond.match(/^(eq|ne|gt|lt)\s+(.+)/);
  if (cmpMatch) {
    const op = cmpMatch[1];
    const rest = cmpMatch[2];
    const parts = splitArgs(rest);
    if (parts.length < 2) return false;
    const a = resolveValue(parts[0], data);
    const b = resolveValue(parts[1], data);
    switch (op) {
      case "eq":
        return a == b;
      case "ne":
        return a != b;
      case "gt":
        return Number(a) > Number(b);
      case "lt":
        return Number(a) < Number(b);
    }
  }
  // bare path
  const v = resolveValue(cond, data);
  return truthy(v);
}

function renderExpr(expr: string, data: Ctx): string {
  const parts = expr.split("|").map((p) => p.trim());
  let value = resolveValue(parts[0], data);
  for (let i = 1; i < parts.length; i++) {
    value = applyPipe(value, parts[i]);
  }
  if (value === null || value === undefined) return "";
  return escapeHtml(String(value));
}

function applyPipe(value: unknown, call: string): unknown {
  const m = call.match(/^(\w+)\s*(.*)$/);
  if (!m) return value;
  const fn = m[1];
  const args = splitArgs(m[2]).map((a) => literalValue(a));
  switch (fn) {
    case "upper":
      return String(value ?? "").toUpperCase();
    case "lower":
      return String(value ?? "").toLowerCase();
    case "formatCurrency": {
      const code = String(args[0] ?? "USD").toUpperCase();
      return formatCurrency(value, code);
    }
    case "formatNumber": {
      const decimals = Number(args[0] ?? 0);
      return formatNumber(value, decimals);
    }
    case "formatDate":
      return formatDate(value, String(args[0] ?? ""));
    default:
      return value;
  }
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      cur += ch;
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      cur += ch;
      continue;
    }
    if (ch === " ") {
      if (cur.length) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length) out.push(cur);
  return out;
}

function literalValue(tok: string): unknown {
  if (tok.startsWith('"') && tok.endsWith('"'))
    return tok.slice(1, -1);
  if (tok.startsWith("'") && tok.endsWith("'"))
    return tok.slice(1, -1);
  const n = Number(tok);
  if (!Number.isNaN(n)) return n;
  return tok;
}

function resolveValue(tok: string, data: Ctx): unknown {
  tok = tok.trim();
  if (tok.startsWith('"') && tok.endsWith('"')) return tok.slice(1, -1);
  if (tok.startsWith("'") && tok.endsWith("'")) return tok.slice(1, -1);
  const n = Number(tok);
  if (!Number.isNaN(n) && tok !== "") return n;
  return resolvePath(data, tok);
}

function resolvePath(data: Ctx, path: string): unknown {
  if (!path.startsWith(".")) return undefined;
  const parts = path.slice(1).split(".").filter(Boolean);
  if (parts.length === 0) return data;
  let cur: any = data;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function truthy(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return Boolean(v);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
      ? "&lt;"
      : c === ">"
      ? "&gt;"
      : c === '"'
      ? "&quot;"
      : "&#39;"
  );
}

function formatCurrency(v: unknown, code: string): string {
  const n = Number(v);
  if (Number.isNaN(n)) return String(v ?? "");
  const sym =
    code === "USD" ? "$" : code === "EUR" ? "€" : code === "GBP" ? "£" : code === "INR" ? "₹" : code === "JPY" ? "¥" : code + " ";
  const dec = code === "JPY" || code === "KRW" ? 0 : 2;
  return sym + n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function formatNumber(v: unknown, decimals: number): string {
  const n = Number(v);
  if (Number.isNaN(n)) return String(v ?? "");
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// Best-effort client-side date formatter. Handles the most common Go template
// layout tokens. The authoritative formatter is the server.
function formatDate(v: unknown, layout: string): string {
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v ?? "");
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const monthsShort = months.map((m) => m.slice(0, 3));
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const tokens: Array<[RegExp, (d: Date) => string]> = [
    [/\bMonday\b/g, (d) => weekdays[d.getDay()]],
    [/\bJanuary\b/g, (d) => months[d.getMonth()]],
    [/\bJan\b/g, (d) => monthsShort[d.getMonth()]],
    [/\b2006\b/g, (d) => String(d.getFullYear())],
    [/\b01\b/g, (d) => String(d.getMonth() + 1).padStart(2, "0")],
    [/\b02\b/g, (d) => String(d.getDate()).padStart(2, "0")],
    [/\b2\b/g, (d) => String(d.getDate())],
    [/\b15\b/g, (d) => String(d.getHours()).padStart(2, "0")],
    [/\b04\b/g, (d) => String(d.getMinutes()).padStart(2, "0")],
  ];
  let out = layout;
  for (const [re, fn] of tokens) out = out.replace(re, fn(d));
  return out;
}
