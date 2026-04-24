// Client-side validation runner for the AcroForm Designer. Mirrors the
// server-side checks in api/internal/generate/acroform/fill.go#validateValue
// so the designer can surface errors inline before submitting.
//
// The runner is intentionally tolerant:
//   - empty/undefined values on non-required fields → no error
//   - unparseable patterns → no error (don't block the designer on typos)
//   - the expression evaluator reuses evalShowIf — only `<path> <op> <literal>`

import { evalShowIf, resolvePath } from "./schema-utils";
import type {
  AcroFormField,
  AcroMapping,
  CrossValidation,
  MappingMap,
  ValidationRule,
} from "@/components/acroform/types";

export type FieldError = {
  fieldName: string;
  dataKey: string;
  message: string;
  severity: "error" | "warning";
};

// Evaluate a fillWhen expression. Empty/unparseable → true (don't skip).
export function shouldFill(
  fillWhen: string | undefined,
  data: Record<string, any>
): boolean {
  if (!fillWhen || !fillWhen.trim()) return true;
  try {
    return evalShowIf(fillWhen, data);
  } catch {
    return true;
  }
}

// Validate a single field value against a rule. Returns 0..N messages.
export function validateField(
  value: unknown,
  rule: ValidationRule | undefined,
  fieldName: string,
  dataKey: string,
  row: Record<string, any> = {}
): FieldError[] {
  if (!rule) return [];
  const out: FieldError[] = [];
  const push = (msg: string) =>
    out.push({
      fieldName,
      dataKey,
      message: rule.message || msg,
      severity: "error",
    });

  // Empty value — only flag if a non-string constraint is set without a type.
  const isEmpty =
    value == null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0);

  if (isEmpty) {
    // Required is handled by the caller (it cares about Mapping.required, not
    // the ValidationRule). For validation rules alone, empty is a pass.
    return out;
  }

  // Type checks.
  if (rule.type) {
    switch (rule.type) {
      case "string":
        if (typeof value !== "string") push("Must be a string");
        break;
      case "number": {
        const n =
          typeof value === "number"
            ? value
            : typeof value === "string"
            ? parseFloat(value)
            : NaN;
        if (!Number.isFinite(n)) push("Must be a number");
        break;
      }
      case "boolean":
        if (
          typeof value !== "boolean" &&
          !(typeof value === "string" && /^(true|false|yes|no|on|off|1|0)$/i.test(value.trim()))
        ) {
          push("Must be true or false");
        }
        break;
      case "date": {
        const s = String(value);
        const d = new Date(s);
        if (isNaN(d.getTime())) push("Must be a valid date");
        break;
      }
      case "email": {
        const s = String(value);
        // Pragmatic email regex: one @, no spaces, a dot in the domain.
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) push("Must be a valid email");
        break;
      }
      case "url": {
        const s = String(value);
        try {
          // Allow bare domains? No — require a scheme to avoid ambiguity.
          new URL(s);
        } catch {
          push("Must be a valid URL (include https://)");
        }
        break;
      }
    }
  }

  // String constraints.
  if (typeof value === "string") {
    if (rule.minLength != null && value.length < rule.minLength) {
      push(`Must be at least ${rule.minLength} characters`);
    }
    if (rule.maxLength != null && value.length > rule.maxLength) {
      push(`Must be at most ${rule.maxLength} characters`);
    }
    if (rule.pattern) {
      try {
        const re = new RegExp(rule.pattern);
        if (!re.test(value)) push("Does not match the required pattern");
      } catch {
        // Invalid regex in rule — don't surface to end user.
      }
    }
  }

  // Number constraints.
  if (rule.min != null || rule.max != null) {
    const n =
      typeof value === "number"
        ? value
        : typeof value === "string"
        ? parseFloat(value)
        : NaN;
    if (Number.isFinite(n)) {
      if (rule.min != null && n < rule.min) push(`Must be ≥ ${rule.min}`);
      if (rule.max != null && n > rule.max) push(`Must be ≤ ${rule.max}`);
    }
  }

  // Date constraints (ISO string comparison — both sides are yyyy-mm-dd).
  if (rule.minDate || rule.maxDate) {
    const d = new Date(String(value));
    if (!isNaN(d.getTime())) {
      if (rule.minDate) {
        const min = new Date(rule.minDate);
        if (!isNaN(min.getTime()) && d < min) push(`Must be on or after ${rule.minDate}`);
      }
      if (rule.maxDate) {
        const max = new Date(rule.maxDate);
        if (!isNaN(max.getTime()) && d > max) push(`Must be on or before ${rule.maxDate}`);
      }
    }
  }

  // Custom expression — evaluated against the row with $value bound.
  if (rule.expression && rule.expression.trim()) {
    try {
      const ok = evalShowIf(rule.expression, { ...row, $value: value });
      if (!ok) push("Does not satisfy the custom rule");
    } catch {
      // Ignore parse failures.
    }
  }

  return out;
}

// Validate every mapped field + evaluate cross-field rules against the sample.
export function validateAll(
  fields: AcroFormField[],
  mappings: MappingMap,
  sampleData: Record<string, any>,
  crossValidations: CrossValidation[] = []
): FieldError[] {
  const out: FieldError[] = [];

  for (const f of fields) {
    const m: AcroMapping | undefined = mappings[f.name];
    if (!m || !m.dataKey) continue;
    if (!shouldFill(m.fillWhen, sampleData)) continue;

    const value = resolvePath(sampleData, m.dataKey) ?? sampleData[m.dataKey];

    // Required check (applies even if no validation rule exists).
    if (m.required) {
      const isEmpty =
        value == null ||
        (typeof value === "string" && value.trim() === "") ||
        (Array.isArray(value) && value.length === 0);
      if (isEmpty) {
        out.push({
          fieldName: f.name,
          dataKey: m.dataKey,
          message: m.validation?.message || "Required",
          severity: "error",
        });
        // Skip further validation for empty required fields.
        continue;
      }
    }

    const errs = validateField(value, m.validation, f.name, m.dataKey, sampleData);
    out.push(...errs);
  }

  // Cross-field validations.
  for (const cv of crossValidations) {
    if (!cv.expression || !cv.expression.trim()) continue;
    try {
      const ok = evalShowIf(cv.expression, sampleData);
      if (!ok) {
        out.push({
          fieldName: `__cross__:${cv.id}`,
          dataKey: "",
          message: cv.message || `Cross-validation failed: ${cv.expression}`,
          severity: "error",
        });
      }
    } catch {
      // ignore
    }
  }

  return out;
}
