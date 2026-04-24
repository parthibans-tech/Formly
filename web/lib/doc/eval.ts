/**
 * Scope + condition + formatter helpers for the client-side doc renderer.
 *
 * This file is the TypeScript mirror of api/internal/generate/doc/eval.go.
 * The semantics must stay identical: any divergence causes the preview
 * iframe and the rendered PDF to disagree, which is exactly the class of
 * bug we're refactoring away from.
 *
 * Inputs from the data map can be any JSON-shaped value; we intentionally
 * don't try to be clever about custom classes (Date is the one exception,
 * since it's the idiomatic TS way to express a date).
 */

import type { Condition, FieldFormat } from "./ast";

// ---------------------------------------------------------------------------
// Scope (linked list; new level per `repeat` push)
// ---------------------------------------------------------------------------

export interface Scope {
  readonly parent: Scope | null;
  readonly data: Record<string, unknown>;
  /** When non-empty, `data`'s fields are exposed only under this alias; when
   *  empty, they merge into top-level lookups. */
  readonly alias: string;
}

export function rootScope(data: Record<string, unknown> | null | undefined): Scope {
  return { parent: null, data: data ?? {}, alias: "" };
}

export function pushScope(
  parent: Scope,
  item: Record<string, unknown>,
  alias: string,
): Scope {
  return { parent, data: item, alias };
}

/** Walk the scope chain looking up a dotted path.  Returns `undefined` for
 *  missing keys — matches the Go server's missingkey=zero behaviour, so
 *  undefined paths never throw. */
export function resolvePath(scope: Scope, path: string): unknown {
  if (!path || path === ".") return scope.data;
  const clean = path.replace(/^\./, "");
  const segs = clean.split(".");

  for (let cur: Scope | null = scope; cur != null; cur = cur.parent) {
    // Alias match first — lets inner scopes explicitly address their iteration
    // variable (e.g. "item.name" inside a repeat with as="item").
    if (cur.alias && segs[0] === cur.alias) {
      const rest = segs.slice(1);
      if (rest.length === 0) return cur.data;
      const v = walk(cur.data, rest);
      if (v !== undefined) return v;
      // If the alias path didn't resolve, fall through outward.
    }
    const v = walk(cur.data, segs);
    if (v !== undefined) return v;
  }
  return undefined;
}

function walk(root: unknown, segs: string[]): unknown {
  let cur: unknown = root;
  for (const seg of segs) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export function evalCondition(c: Condition, scope: Scope): boolean {
  const left = resolvePath(scope, c.left);
  switch (c.op) {
    case "defined":
      return left !== undefined && left !== null;
    case "truthy":
      return isTruthy(left);
    case "empty":
      return isEmpty(left);
    case "eq":
      return compareEq(left, c.right);
    case "ne":
      return !compareEq(left, c.right);
    case "gt":
      return compareNum(left, c.right) > 0;
    case "ge":
      return compareNum(left, c.right) >= 0;
    case "lt":
      return compareNum(left, c.right) < 0;
    case "le":
      return compareNum(left, c.right) <= 0;
  }
}

export function isTruthy(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v !== "";
  if (typeof v === "number") return v !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

export function isEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

function compareEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na != null && nb != null) return na === nb;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b;
  return String(a) === String(b);
}

function compareNum(a: unknown, b: unknown): number {
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na != null && nb != null) {
    if (na < nb) return -1;
    if (na > nb) return 1;
    return 0;
  }
  const sa = String(a);
  const sb = String(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

export function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Iteration normalization for `repeat` blocks
// ---------------------------------------------------------------------------

/** Normalize a resolved value into per-iteration records.  Same rules as
 *  Go's iterItems: arrays of objects become the list, plain objects become
 *  single-element iteration, primitives wrap as { _: value }. */
export function iterItems(v: unknown): Record<string, unknown>[] | null {
  if (v == null) return null;
  if (Array.isArray(v)) {
    return v.map((it) =>
      it != null && typeof it === "object" && !Array.isArray(it)
        ? (it as Record<string, unknown>)
        : { _: it },
    );
  }
  if (typeof v === "object") return [v as Record<string, unknown>];
  return null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Produce the display text for a resolved field value.  `locale` is the
 *  doc-level fallback locale; per-format `locale` overrides it. */
export function formatField(
  v: unknown,
  format: FieldFormat | undefined,
  fallback: string | undefined,
  locale: string,
): string {
  if (v == null) return fallback ?? "";
  if (!format || format.kind === "text") return defaultStringify(v);
  const loc = format.locale || locale || undefined;

  switch (format.kind) {
    case "number": {
      const n = asNumber(v);
      if (n == null) return defaultStringify(v);
      return formatNumberLocale(n, format.decimals ?? 0, loc);
    }
    case "currency": {
      const n = asNumber(v);
      if (n == null) return defaultStringify(v);
      const code = (format.code || "USD").toUpperCase();
      try {
        return new Intl.NumberFormat(loc, {
          style: "currency",
          currency: code,
        }).format(n);
      } catch {
        // Bad locale/code falls back to fixed-format so preview never crashes.
        return `${code} ${n.toFixed(2)}`;
      }
    }
    case "percent": {
      const n = asNumber(v);
      if (n == null) return defaultStringify(v);
      // Accept 0.15 or 15 — same proportional heuristic as the server.
      const scaled = Math.abs(n) <= 1 ? n * 100 : n;
      return formatNumberLocale(scaled, format.decimals ?? 0, loc) + "%";
    }
    case "date": {
      const d = asDate(v);
      if (!d) return defaultStringify(v);
      // Pattern compatibility: we accept a tiny subset of Go's reference
      // date layout so authors can share patterns across client and server.
      return formatDatePattern(d, format.pattern || "2006-01-02", loc);
    }
  }
  return defaultStringify(v);
}

function defaultStringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function formatNumberLocale(n: number, decimals: number, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(n);
  } catch {
    return n.toFixed(decimals);
  }
}

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v * 1000);
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Render `date` using a Go-style reference-date pattern.  This is a thin
 *  translator — it only supports the tokens the editor can actually emit
 *  via its date-format picker.  Unknown tokens pass through literally. */
function formatDatePattern(date: Date, pattern: string, locale?: string): string {
  const map: Record<string, string> = {
    "2006": String(date.getFullYear()),
    "06": String(date.getFullYear()).slice(-2),
    "01": pad2(date.getMonth() + 1),
    "1": String(date.getMonth() + 1),
    "Jan": shortMonth(date, locale),
    "January": longMonth(date, locale),
    "02": pad2(date.getDate()),
    "2": String(date.getDate()),
    "Mon": shortDay(date, locale),
    "Monday": longDay(date, locale),
    "15": pad2(date.getHours()),
    "03": pad2(((date.getHours() + 11) % 12) + 1),
    "04": pad2(date.getMinutes()),
    "05": pad2(date.getSeconds()),
    "PM": date.getHours() < 12 ? "AM" : "PM",
  };
  // Apply longest tokens first so "January" isn't eaten by "Jan".
  const tokens = Object.keys(map).sort((a, b) => b.length - a.length);
  let out = pattern;
  for (const tok of tokens) {
    out = out.split(tok).join(map[tok]);
  }
  return out;
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

function shortMonth(d: Date, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { month: "short" }).format(d);
  } catch {
    return d.toLocaleString(undefined, { month: "short" });
  }
}
function longMonth(d: Date, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { month: "long" }).format(d);
  } catch {
    return d.toLocaleString(undefined, { month: "long" });
  }
}
function shortDay(d: Date, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(d);
  } catch {
    return d.toLocaleString(undefined, { weekday: "short" });
  }
}
function longDay(d: Date, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(d);
  } catch {
    return d.toLocaleString(undefined, { weekday: "long" });
  }
}
