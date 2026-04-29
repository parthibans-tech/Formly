/**
 * auto-schema — derives a FormSchema from a starter's sampleData when the
 * starter doesn't ship its own formSchema.  This lets every starter open in
 * fill mode (form + rendered preview) without per-template hand-curation.
 *
 * Heuristics:
 *   - Top-level objects → "object" group with one input per leaf field.
 *   - Top-level arrays of strings → "string-list" group.
 *   - Top-level arrays of objects → "object-list" group; row fields are
 *     inferred the same way (one level deep).
 *   - Other top-level scalars → "scalar" group.
 *   - Field type is inferred from key name (email, phone, date, url) and
 *     value length (long strings → textarea).
 *
 * Hand-curated formSchemas always win — this is just the fallback.
 */

import type {
  FieldType,
  FormGroup,
  FormSchema,
  ObjectListGroup,
  ScalarField,
} from "./types";

export function autoSchemaFromSample(
  sample: Record<string, unknown>,
): FormSchema {
  const groups: FormGroup[] = [];
  for (const [key, value] of Object.entries(sample)) {
    const g = groupFor(key, value);
    if (g) groups.push(g);
  }
  return { groups };
}

function groupFor(key: string, value: unknown): FormGroup | null {
  const label = humanize(key);

  // Array of strings
  if (Array.isArray(value)) {
    const first = value[0];
    if (value.length === 0 || typeof first === "string") {
      return {
        kind: "string-list",
        id: key,
        label,
        path: key,
        itemPlaceholder: humanize(singularize(key)),
      };
    }
    // Array of objects
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const fields = inferRowFields(first as Record<string, unknown>);
      if (fields.length === 0) return null;
      const newItem: Record<string, unknown> = {};
      for (const f of fields) {
        newItem[f.id] = f.type === "string-list" ? [""] : "";
      }
      const g: ObjectListGroup = {
        kind: "object-list",
        id: key,
        label,
        path: key,
        fields,
        newItem,
        itemLabel: pickItemLabel(first as Record<string, unknown>),
      };
      return g;
    }
    return null;
  }

  // Object → flatten leaf scalars
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const fields: ScalarField[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean"
      ) {
        fields.push({
          id: k,
          label: humanize(k),
          type: typeFromKeyAndValue(k, v),
        });
      }
    }
    if (fields.length === 0) return null;
    return {
      kind: "object",
      id: key,
      label,
      path: key,
      fields,
    };
  }

  // Scalar
  return {
    kind: "scalar",
    id: key,
    label,
    path: key,
    type: typeFromKeyAndValue(key, value),
  };
}

function inferRowFields(
  row: Record<string, unknown>,
): Array<
  | ScalarField
  | { id: string; label: string; type: "string-list"; itemPlaceholder?: string }
> {
  const fields: Array<
    | ScalarField
    | { id: string; label: string; type: "string-list"; itemPlaceholder?: string }
  > = [];
  for (const [k, v] of Object.entries(row)) {
    if (Array.isArray(v) && (v.length === 0 || typeof v[0] === "string")) {
      fields.push({
        id: k,
        label: humanize(k),
        type: "string-list",
        itemPlaceholder: humanize(singularize(k)),
      });
    } else if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      fields.push({
        id: k,
        label: humanize(k),
        type: typeFromKeyAndValue(k, v),
      });
    }
  }
  return fields;
}

function typeFromKeyAndValue(key: string, value: unknown): FieldType {
  const lk = key.toLowerCase();
  if (lk.includes("email")) return "email";
  if (lk.includes("phone") || lk === "tel") return "tel";
  if (lk.includes("url") || lk.includes("website") || lk.includes("link"))
    return "url";
  if (
    lk.includes("date") ||
    lk.endsWith("at") ||
    lk.endsWith("on") ||
    lk === "due" ||
    lk === "issued"
  ) {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      return "date";
    }
  }
  if (
    typeof value === "string" &&
    (value.length > 80 || value.includes("\n"))
  ) {
    return "longtext";
  }
  return "text";
}

function humanize(key: string): string {
  return key
    .replace(/[_-]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function singularize(s: string): string {
  if (s.endsWith("ies") && s.length > 3) return s.slice(0, -3) + "y";
  if (s.endsWith("s") && s.length > 1) return s.slice(0, -1);
  return s;
}

function pickItemLabel(row: Record<string, unknown>): string | undefined {
  const candidates = [
    "title",
    "name",
    "label",
    "description",
    "task",
    "summary",
    "subject",
    "company",
    "degree",
  ];
  for (const c of candidates) {
    if (typeof row[c] === "string" && (row[c] as string).trim() !== "") {
      return `{${c}}`;
    }
  }
  return undefined;
}
