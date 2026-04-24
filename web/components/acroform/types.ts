// Shared types used across the AcroForm Designer component tree.

import type { Transform } from "@/lib/acroform-transforms";

export type FieldRect = { x: number; y: number; w: number; h: number };
export type PageSize = { w: number; h: number };

export type AcroFormField = {
  name: string;
  type: string;
  page: number;
  default?: string;
  value?: string;
  options?: string[];
  locked?: boolean;
  rect?: FieldRect;
  pageSize?: PageSize;
  flags?: number;
  maxLen?: number;
  tooltip?: string;
  readOnly?: boolean;
  required?: boolean;
  multiline?: boolean;
  password?: boolean;
  comb?: boolean;
  combo?: boolean;
  multiSelect?: boolean;
};

// Tier B — Validation rule types.

export type ValidationType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "email"
  | "url";

export type ValidationRule = {
  type?: ValidationType;
  minLength?: number;
  maxLength?: number;
  pattern?: string; // regex source
  min?: number;
  max?: number;
  minDate?: string; // ISO date (yyyy-mm-dd)
  maxDate?: string;
  expression?: string; // evalShowIf-style `<path> <op> <literal>` — $value for current value
  message?: string; // override default error message
};

// Top-level cross-field validation rule — evaluated against the full sample row.
export type CrossValidation = {
  id: string;
  expression: string;
  message: string;
};

export type AcroMapping = {
  dataKey: string;
  default?: string;
  required?: boolean;
  // Transform is polymorphic:
  //   - string (legacy op name)
  //   - single Transform object
  //   - Transform[] pipeline (executed in order, left to right)
  transform?: Transform | Transform[] | string;
  section?: string;
  flatten?: boolean;
  validation?: ValidationRule;
  // evalShowIf-style expression evaluated against the full sample data row.
  // When present and false, the field is skipped entirely at fill time.
  fillWhen?: string;
};

export type MappingMap = Record<string, AcroMapping>;
