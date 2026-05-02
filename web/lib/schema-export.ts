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
// Import — counterpart to buildFullExport.
// Validates a parsed JSON blob against the FullTemplateExport contract and
// returns the three pieces a designer needs to overwrite local state:
//   • widgets       — fresh array (caller decides how to merge / replace)
//   • config        — page layout + custom fonts
//   • sampleData    — raw object, ready to JSON.stringify back into the
//                     sample textarea
// Throws with a human-readable message on schema mismatch so the caller
// can surface it via toast.show("error", e.message).
// ---------------------------------------------------------------------------

export interface ImportedTemplate {
  widgets: ExportableWidget[];
  config: Record<string, any>;
  sampleData: Record<string, any>;
  /** Original template metadata from the export — useful for warnings. */
  sourceMeta: {
    id?: string;
    name?: string;
    mode?: string;
    version?: number;
    exportedAt?: string;
  };
}

export function parseFullImport(raw: string): ImportedTemplate {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("File is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Expected a JSON object at the root");
  }
  // We accept three shapes:
  //   1. Full export (has _version + widgets[])
  //   2. Bare widgets array
  //   3. { widgets: [...] } loose wrapper
  // This makes the import forgiving — users sometimes paste in just the
  // widgets array from a snippet, which is fine.
  let widgets: any;
  let config: any = {};
  let sampleData: any = {};
  let sourceMeta: ImportedTemplate["sourceMeta"] = {};

  if (Array.isArray(parsed)) {
    widgets = parsed;
  } else if (Array.isArray(parsed.widgets)) {
    widgets = parsed.widgets;
    config = parsed.config && typeof parsed.config === "object" ? parsed.config : {};
    sampleData =
      parsed.sampleData && typeof parsed.sampleData === "object"
        ? parsed.sampleData
        : {};
    if (parsed.template && typeof parsed.template === "object") {
      sourceMeta = {
        id: parsed.template.id,
        name: parsed.template.name,
        mode: parsed.template.mode,
        version: parsed.template.version,
      };
    }
    if (typeof parsed._exportedAt === "string") {
      sourceMeta.exportedAt = parsed._exportedAt;
    }
  } else {
    throw new Error("Missing `widgets` array — not a template export");
  }

  // Per-widget shape check. We don't validate every prop type, but the
  // skeleton fields must be present and numeric, otherwise the designer
  // will throw later when computing positions.
  if (!Array.isArray(widgets)) {
    throw new Error("`widgets` is not an array");
  }
  const cleaned: ExportableWidget[] = widgets.map((w, i) => {
    if (!w || typeof w !== "object") {
      throw new Error(`Widget #${i} is not an object`);
    }
    const required = ["type", "page", "x", "y", "w", "h"] as const;
    for (const k of required) {
      if (typeof (w as any)[k] !== (k === "type" ? "string" : "number")) {
        throw new Error(`Widget #${i} missing or invalid \`${k}\``);
      }
    }
    return {
      id: typeof w.id === "string" ? w.id : undefined,
      type: w.type,
      page: w.page,
      x: w.x,
      y: w.y,
      w: w.w,
      h: w.h,
      dataKey: typeof w.dataKey === "string" ? w.dataKey : "",
      zIndex: typeof w.zIndex === "number" ? w.zIndex : 0,
      props: w.props && typeof w.props === "object" ? w.props : {},
      ...(w.locked ? { locked: true } : {}),
      ...(w.hidden ? { hidden: true } : {}),
    };
  });

  return { widgets: cleaned, config, sampleData, sourceMeta };
}

/**
 * Browser file-picker helper. Opens a `<input type="file" accept=".json">`
 * dialog, reads the chosen file as text, parses+validates it via
 * `parseFullImport`, and resolves with the result. Resolves to `null` if
 * the user cancels the dialog.
 */
export function pickAndParseFullImport(): Promise<ImportedTemplate | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      try {
        const text = await file.text();
        resolve(parseFullImport(text));
      } catch (e) {
        reject(e);
      }
    };
    // If the user dismisses the dialog without picking, no event fires —
    // we never resolve. That's fine: the caller's await just hangs until
    // the next interaction, and there's nothing to clean up.
    input.click();
  });
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
