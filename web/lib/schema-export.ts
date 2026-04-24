// Schema export utilities for the designer.
// Export formats:
//   1. JSON            — the raw sample data (pretty-printed)
//   2. TypeScript      — generated interface from the schema tree
//   3. Skeleton        — every dataKey zeroed for API integration tests
//   4. Full config     — complete template: widgets + layout + sample data

import { buildSchema, type SchemaNode } from "@/lib/schema-utils";

// ---------------------------------------------------------------------------
// 4. Full template config export
// Bundles everything needed to recreate or inspect the template:
//   • template metadata  (id, name, mode, version)
//   • widgets array      (all placements with type, position, props)
//   • config             (pageLayout, custom fonts, etc.)
//   • sampleData         (current sample JSON, already parsed)
// ---------------------------------------------------------------------------

export type ExportableWidget = {
  id?: string;
  type: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  dataKey: string;
  zIndex: number;
  props: Record<string, any>;
  locked?: boolean;
  hidden?: boolean;
};

export type FullTemplateExport = {
  _exportedAt: string;           // ISO timestamp
  _version: 1;                   // bump when format changes
  template: {
    id: string;
    name: string;
    mode: string;
    version: number;
  };
  widgets: ExportableWidget[];
  config: Record<string, any>;   // pageLayout + any other config
  sampleData: Record<string, any>;
};

export function buildFullExport(
  tpl: { id: string; name: string; mode: string; version: number },
  widgets: ExportableWidget[],
  config: Record<string, any>,
  sampleJSON: string
): FullTemplateExport {
  let sampleData: Record<string, any> = {};
  try {
    sampleData = JSON.parse(sampleJSON || "{}");
  } catch { /* keep empty */ }

  // Strip runtime-only / internal flags from props before exporting so the
  // file stays clean. Keep _label, _group (user-defined), drop _locked/_hidden
  // (they live on the top-level locked/hidden field already).
  const cleanWidgets: ExportableWidget[] = widgets.map((w) => {
    const { _locked, _hidden, ...cleanProps } = (w.props ?? {}) as Record<string, any>;
    return {
      type:    w.type,
      page:    w.page,
      x:       w.x,
      y:       w.y,
      w:       w.w,
      h:       w.h,
      dataKey: w.dataKey,
      zIndex:  w.zIndex,
      props:   cleanProps,
      ...(w.locked  ? { locked:  true } : {}),
      ...(w.hidden  ? { hidden:  true } : {}),
    };
  });

  return {
    _exportedAt: new Date().toISOString(),
    _version: 1,
    template: {
      id:      tpl.id,
      name:    tpl.name,
      mode:    tpl.mode,
      version: tpl.version,
    },
    widgets: cleanWidgets,
    config,
    sampleData,
  };
}

export function downloadFullExport(
  tpl: { id: string; name: string; mode: string; version: number },
  widgets: ExportableWidget[],
  config: Record<string, any>,
  sampleJSON: string
): void {
  const payload = buildFullExport(tpl, widgets, config, sampleJSON);
  downloadJSON(
    JSON.stringify(payload, null, 2),
    `${tpl.name || "template"}-config.json`
  );
}

// ---------------------------------------------------------------------------
// 1. Download sample JSON
// ---------------------------------------------------------------------------

export function downloadJSON(json: string, filename = "schema.json"): void {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// 2. TypeScript interface generator
// ---------------------------------------------------------------------------

/**
 * Converts a sample JSON object into a TypeScript interface string.
 * Arrays are rendered as `T[]` using the first element as the prototype.
 *
 * Example input:  { name: "Alice", score: 42, items: [{ id: 1 }] }
 * Example output:
 *   export interface Schema {
 *     name: string;
 *     score: number;
 *     items: Items[];
 *   }
 *   export interface Items {
 *     id: number;
 *   }
 */
export function toTypeScript(data: any, rootName = "Schema"): string {
  const interfaces: string[] = [];
  buildInterface(data, rootName, interfaces);
  return interfaces.join("\n\n");
}

function buildInterface(data: any, name: string, out: string[]): string {
  // Sanitise to a valid PascalCase identifier.
  const ident = toPascal(name);

  if (Array.isArray(data)) {
    // Treat as a top-level array — use the first element.
    if (data.length > 0 && typeof data[0] === "object" && data[0] !== null) {
      return buildInterface(data[0], ident, out) + "[]";
    }
    return tsTypeOf(data[0] ?? null) + "[]";
  }

  if (data && typeof data === "object") {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(data)) {
      lines.push(`  ${key}: ${fieldType(key, value, out)};`);
    }
    out.push(`export interface ${ident} {\n${lines.join("\n")}\n}`);
    return ident;
  }

  return tsTypeOf(data);
}

function fieldType(key: string, value: any, out: string[]): string {
  if (Array.isArray(value)) {
    if (value.length > 0 && typeof value[0] === "object" && value[0] !== null) {
      const childName = toPascal(key);
      buildInterface(value[0], childName, out);
      return `${childName}[]`;
    }
    return `${tsTypeOf(value[0] ?? null)}[]`;
  }
  if (value && typeof value === "object") {
    const childName = toPascal(key);
    buildInterface(value, childName, out);
    return childName;
  }
  return tsTypeOf(value);
}

function tsTypeOf(v: any): string {
  if (v === null || v === undefined) return "unknown";
  switch (typeof v) {
    case "string":  return "string";
    case "number":  return "number";
    case "boolean": return "boolean";
    default:        return "unknown";
  }
}

function toPascal(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/^./, (c) => c.toUpperCase());
}

export function downloadTypeScript(data: any, filename = "schema.ts"): void {
  const ts = toTypeScript(data);
  const blob = new Blob([ts], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// 3. Skeleton payload
// Generates an empty JSON object with one key per leaf in the schema tree,
// with zero-values matching each field's type.
// ---------------------------------------------------------------------------

export function buildSkeletonPayload(data: any): any {
  return skeletonFrom(data);
}

function skeletonFrom(data: any): any {
  if (Array.isArray(data)) {
    return data.length > 0 ? [skeletonFrom(data[0])] : [];
  }
  if (data && typeof data === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(data)) {
      out[k] = skeletonFrom(v);
    }
    return out;
  }
  // Zero-value for the type.
  if (typeof data === "number")  return 0;
  if (typeof data === "boolean") return false;
  return "";
}

export function downloadSkeleton(data: any, filename = "payload.json"): void {
  const skeleton = buildSkeletonPayload(data);
  downloadJSON(JSON.stringify(skeleton, null, 2), filename);
}

// ---------------------------------------------------------------------------
// 4. Copy to clipboard helper
// ---------------------------------------------------------------------------

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts.
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      return true;
    } catch {
      return false;
    }
  }
}
