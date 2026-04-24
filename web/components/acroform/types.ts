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

export type AcroMapping = {
  dataKey: string;
  default?: string;
  required?: boolean;
  transform?: Transform | string; // legacy string tolerated
  section?: string;
  flatten?: boolean;
};

export type MappingMap = Record<string, AcroMapping>;
