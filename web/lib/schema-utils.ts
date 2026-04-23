// Shared helpers for the designer's data-binding layer. Kept pure so we
// can unit-test them later without pulling in React or react-pdf.

export type SchemaNode = {
  path: string; // dot-path from root, e.g. "invoice.items.0.name"
  kind: "object" | "array" | "string" | "number" | "boolean" | "null";
  sample: any;
  children?: SchemaNode[];
};

// Walk a sample JSON object and return a tree of every reachable path.
// Arrays expose their first element as a single representative child so
// users can bind to "items.0.name" and the UI hints that arrays repeat.
export function buildSchema(data: any, path = ""): SchemaNode {
  if (Array.isArray(data)) {
    const children = data.length
      ? [buildSchema(data[0], path ? `${path}.0` : "0")]
      : [];
    return { path, kind: "array", sample: data, children };
  }
  if (data && typeof data === "object") {
    const children = Object.keys(data).map((k) =>
      buildSchema(data[k], path ? `${path}.${k}` : k)
    );
    return { path, kind: "object", sample: data, children };
  }
  let kind: SchemaNode["kind"] = "null";
  if (typeof data === "string") kind = "string";
  else if (typeof data === "number") kind = "number";
  else if (typeof data === "boolean") kind = "boolean";
  return { path, kind, sample: data };
}

// Resolve a dot-path like "invoice.total" or "items.0.name" against `data`.
// Returns undefined if any hop is missing.
export function resolvePath(data: any, path: string): any {
  if (!path) return data;
  const parts = path.split(".");
  let cur = data;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// Collect every leaf path that `data` actually exposes — used to flag
// widgets whose dataKey doesn't match any real field.
export function collectPaths(data: any, path = "", out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(data)) {
    if (data.length) collectPaths(data[0], path ? `${path}.0` : "0", out);
    out.add(path);
  } else if (data && typeof data === "object") {
    for (const k of Object.keys(data)) {
      collectPaths(data[k], path ? `${path}.${k}` : k, out);
    }
    if (path) out.add(path);
  } else {
    out.add(path);
  }
  return out;
}

// Check whether a dataKey matches something in the sample — allows exact
// or ancestor match (binding to an object is legal).
export function keyExists(allPaths: Set<string>, key: string): boolean {
  if (!key) return false;
  if (allPaths.has(key)) return true;
  for (const p of allPaths) {
    if (p.startsWith(key + ".")) return true;
  }
  return false;
}

// Apply a chain of transforms (identifiers, with optional `:arg`). Unknown
// transforms pass through unchanged so the renderer stays forgiving.
// Supported:
//   uppercase | lowercase | titlecase | trim
//   truncate:N
//   date:format       (e.g. "date:yyyy-MM-dd")
//   number:decimals   (e.g. "number:2")
//   currency:ISO      (e.g. "currency:USD")
//   default:value
export function applyTransforms(value: any, transforms: string[] = []): string {
  let v: any = value;
  for (const raw of transforms) {
    if (!raw) continue;
    const [name, arg = ""] = raw.split(":");
    switch (name) {
      case "uppercase":
        v = String(v ?? "").toUpperCase();
        break;
      case "lowercase":
        v = String(v ?? "").toLowerCase();
        break;
      case "titlecase":
        v = String(v ?? "")
          .toLowerCase()
          .replace(/\b\w/g, (c) => c.toUpperCase());
        break;
      case "trim":
        v = String(v ?? "").trim();
        break;
      case "truncate": {
        const n = parseInt(arg, 10) || 40;
        const s = String(v ?? "");
        v = s.length > n ? s.slice(0, n) + "…" : s;
        break;
      }
      case "number": {
        const d = parseInt(arg, 10);
        const num = Number(v);
        v = Number.isFinite(num)
          ? Number.isFinite(d)
            ? num.toFixed(d)
            : num.toLocaleString()
          : v;
        break;
      }
      case "currency": {
        const num = Number(v);
        if (Number.isFinite(num)) {
          try {
            v = new Intl.NumberFormat(undefined, {
              style: "currency",
              currency: arg || "USD",
            }).format(num);
          } catch {
            v = num.toFixed(2);
          }
        }
        break;
      }
      case "date": {
        const d = v instanceof Date ? v : new Date(v);
        if (!isNaN(d.getTime())) {
          // Minimal format tokens — backend does full formatting at render.
          const pad = (n: number) => String(n).padStart(2, "0");
          const map: Record<string, string> = {
            yyyy: String(d.getFullYear()),
            MM: pad(d.getMonth() + 1),
            dd: pad(d.getDate()),
            HH: pad(d.getHours()),
            mm: pad(d.getMinutes()),
          };
          v = (arg || "yyyy-MM-dd").replace(/yyyy|MM|dd|HH|mm/g, (t) => map[t]);
        }
        break;
      }
      case "default":
        if (v == null || v === "") v = arg;
        break;
    }
  }
  return v == null ? "" : String(v);
}

// Evaluate a tiny expression like `status === 'paid'` or `total > 100`
// against the sample data. Deliberately limited — no arbitrary JS —
// so preview mode can't run unsafe code. Returns true on parse failure so
// an empty/invalid expression doesn't accidentally hide the widget.
export function evalShowIf(expr: string, data: any): boolean {
  const e = expr.trim();
  if (!e) return true;
  // Pattern: <path> <op> <literal>
  const m = e.match(/^([\w.]+)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/);
  if (!m) return true;
  const [, path, op, litRaw] = m;
  const lhs = resolvePath(data, path);
  let rhs: any = litRaw.trim();
  if ((rhs.startsWith('"') && rhs.endsWith('"')) || (rhs.startsWith("'") && rhs.endsWith("'"))) {
    rhs = rhs.slice(1, -1);
  } else if (rhs === "true") rhs = true;
  else if (rhs === "false") rhs = false;
  else if (rhs === "null") rhs = null;
  else if (!isNaN(Number(rhs))) rhs = Number(rhs);
  switch (op) {
    case "===":
    case "==":
      return lhs == rhs;
    case "!==":
    case "!=":
      return lhs != rhs;
    case ">":
      return Number(lhs) > Number(rhs);
    case "<":
      return Number(lhs) < Number(rhs);
    case ">=":
      return Number(lhs) >= Number(rhs);
    case "<=":
      return Number(lhs) <= Number(rhs);
  }
  return true;
}
