// Client-side mirror of api/internal/generate/acroform/transforms.go.
// Used for live preview in the AcroForm Designer — the server is still
// the source of truth at fill time; this only powers the "what will the
// field look like after transform?" UI feedback.

export type TransformOp =
  | "none"
  | "uppercase"
  | "lowercase"
  | "titlecase"
  | "trim"
  | "template"
  | "date-format"
  | "number-format"
  | "lookup"
  | "concat"
  | "substring"
  | "replace"
  | "boolean-label"
  | "js-expr";

export type Transform = {
  op: TransformOp;
  params?: Record<string, any>;
};

export const TRANSFORM_CATALOG: {
  op: TransformOp;
  label: string;
  description: string;
}[] = [
  { op: "none", label: "No transform", description: "Pass value through unchanged." },
  { op: "uppercase", label: "Uppercase", description: "Force ALL CAPS." },
  { op: "lowercase", label: "Lowercase", description: "force all lowercase." },
  { op: "titlecase", label: "Title Case", description: "Capitalize The First Letter Of Each Word." },
  { op: "trim", label: "Trim whitespace", description: "Strip leading/trailing spaces." },
  { op: "template", label: "Template string", description: "Compose from other fields: 'Hello {name}'." },
  { op: "date-format", label: "Date format", description: "Reformat dates (ISO → MM/DD/YYYY, etc.)." },
  { op: "number-format", label: "Number format", description: "Decimals, thousands sep, prefix/suffix." },
  { op: "lookup", label: "Lookup table", description: "Map input values to outputs." },
  { op: "concat", label: "Concat fields", description: "Join values from several fields." },
  { op: "substring", label: "Substring", description: "Take a slice of the string." },
  { op: "replace", label: "Regex replace", description: "Pattern → replacement." },
  { op: "boolean-label", label: "Boolean → label", description: "true → 'Yes', false → 'No'." },
  { op: "js-expr", label: "JS expression", description: "Custom (preview in browser only)." },
];

// Normalize a legacy string transform ("uppercase") or undefined into a
// structured Transform object.
export function normalizeTransform(raw: unknown): Transform {
  if (!raw) return { op: "none" };
  if (typeof raw === "string") return { op: (raw as TransformOp) || "none" };
  if (typeof raw === "object" && raw && "op" in (raw as any)) {
    return raw as Transform;
  }
  return { op: "none" };
}

export function applyTransform(
  value: unknown,
  t: Transform | undefined,
  row: Record<string, any> = {}
): string {
  const tx = t ?? { op: "none" };
  const s = valueToString(value);

  switch (tx.op) {
    case "none":
      return s;
    case "uppercase":
      return s.toUpperCase();
    case "lowercase":
      return s.toLowerCase();
    case "titlecase":
      return s
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase());
    case "trim":
      return s.trim();
    case "template":
      return renderTemplate(tx.params?.pattern || "", row);
    case "date-format":
      return formatDate(s, tx.params?.from, tx.params?.to);
    case "number-format":
      return formatNumber(value, tx.params || {});
    case "lookup": {
      const map = tx.params?.map || {};
      const def = tx.params?.default ?? "";
      return map[s] ?? def ?? s;
    }
    case "concat": {
      const fields: string[] = tx.params?.fields || [];
      const sep: string = tx.params?.sep || "";
      return fields
        .map((k) => valueToString(row[k]))
        .filter((v) => v.length > 0)
        .join(sep);
    }
    case "substring": {
      const start = toInt(tx.params?.start, 0);
      const end = toInt(tx.params?.end, s.length);
      if (start < 0 || start > s.length) return "";
      return s.slice(start, Math.max(start, Math.min(end, s.length)));
    }
    case "replace": {
      const pattern: string = tx.params?.pattern || "";
      const replacement: string = tx.params?.replacement || "";
      if (!pattern) return s;
      try {
        return s.replace(new RegExp(pattern, "g"), replacement);
      } catch {
        return s;
      }
    }
    case "boolean-label": {
      const truthy: string = tx.params?.truthy ?? "Yes";
      const falsy: string = tx.params?.falsy ?? "No";
      return toBool(value) ? truthy : falsy;
    }
    case "js-expr": {
      const expr: string = tx.params?.expr || "";
      if (!expr) return s;
      try {
        // Preview-only; server-side execution is gated.
        // eslint-disable-next-line no-new-func
        const fn = new Function("value", "row", `return (${expr});`);
        const out = fn(value, row);
        return valueToString(out);
      } catch {
        return s;
      }
    }
  }
}

// ---- helpers ----

function valueToString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "yes" || s === "on" || s === "1";
  }
  return false;
}

function toInt(v: unknown, def: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    if (!Number.isNaN(n)) return n;
  }
  return def;
}

function renderTemplate(pattern: string, row: Record<string, any>): string {
  return pattern.replace(/\{([^}]+)\}/g, (_m, key) => {
    const k = key.trim();
    return valueToString(row[k]);
  });
}

function formatDate(input: string, from?: string, to?: string): string {
  if (!input) return "";
  // Let Date parse most common inputs; fall back to explicit yyyy-mm-dd.
  let d: Date | null = null;
  const parsed = new Date(input);
  if (!Number.isNaN(parsed.getTime())) d = parsed;
  if (!d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
    if (m) d = new Date(+m[1], +m[2] - 1, +m[3]);
  }
  if (!d) return input;

  const alias = (to || "yyyy-mm-dd").toLowerCase();
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = d.getFullYear();
  const M = d.getMonth() + 1;
  const D = d.getDate();
  const months = [
    "January","February","March","April","May","June",
    "July","August","September","October","November","December",
  ];
  const monthsShort = months.map((m) => m.slice(0, 3));

  switch (alias) {
    case "mm/dd/yyyy": return `${pad(M)}/${pad(D)}/${y}`;
    case "dd/mm/yyyy": return `${pad(D)}/${pad(M)}/${y}`;
    case "yyyy-mm-dd":
    case "iso":
    case "iso8601":
      return `${y}-${pad(M)}-${pad(D)}`;
    case "mm-dd-yyyy": return `${pad(M)}-${pad(D)}-${y}`;
    case "long": return `${months[M-1]} ${D}, ${y}`;
    case "short": return `${monthsShort[M-1]} ${D}, ${y}`;
    default:
      return d.toISOString().slice(0, 10);
  }
}

function formatNumber(v: unknown, params: Record<string, any>): string {
  let num: number | null = null;
  if (typeof v === "number" && Number.isFinite(v)) {
    num = v;
  } else if (typeof v === "string") {
    const cleaned = v.trim().replace(/,/g, "").replace(/^[$€£¥]/, "");
    const parsed = parseFloat(cleaned);
    if (!Number.isNaN(parsed)) num = parsed;
  }
  if (num === null) return valueToString(v);

  const decimals = toInt(params.decimals, 2);
  const thousands = !!params.thousands;
  const prefix = params.prefix ?? "";
  const suffix = params.suffix ?? "";

  let out = num.toFixed(decimals);
  if (thousands) {
    const [intPart, frac] = out.split(".");
    const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    out = frac ? `${withCommas}.${frac}` : withCommas;
  }
  return `${prefix}${out}${suffix}`;
}
