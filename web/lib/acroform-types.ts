// AcroForm types for interactive PDF field properties.
// Props are stored under widget.props with the "acro" prefix so they
// round-trip through the API safely (Go renderer ignores unknown fields).

export type AcroFormat =
  | "none"
  | "number"
  | "currency"
  | "date"
  | "phone"
  | "ssn"
  | "zip"
  | "zip4"
  | "percent";

export type AcroOption = { label: string; value: string };

// Tier B additions -----------------------------------------------------------

export type AcroCalcOp =
  | "none"
  | "sum"
  | "product"
  | "average"
  | "min"
  | "max"
  | "custom";

export type AcroBorderStyle = "solid" | "dashed" | "underline" | "beveled" | "inset";

export type AcroButtonAction = "none" | "submit" | "reset" | "js";

// ----------------------------------------------------------------------------

export const ACRO_FORMAT_LABELS: Record<AcroFormat, string> = {
  none: "None (plain text)",
  number: "Number",
  currency: "Currency ($)",
  date: "Date",
  phone: "Phone (US)",
  ssn: "SSN (US)",
  zip: "ZIP code",
  zip4: "ZIP+4 code",
  percent: "Percent (%)",
};

export const DATE_FORMAT_PRESETS: { value: string; label: string }[] = [
  { value: "mm/dd/yyyy", label: "MM/DD/YYYY" },
  { value: "dd/mm/yyyy", label: "DD/MM/YYYY" },
  { value: "yyyy-mm-dd", label: "YYYY-MM-DD" },
  { value: "mmm d, yyyy", label: "Mon D, YYYY" },
  { value: "m/d", label: "M/D" },
  { value: "m/d/yy", label: "M/D/YY" },
];

export const ACRO_CALC_OP_LABELS: Record<AcroCalcOp, string> = {
  none: "None",
  sum: "Sum",
  product: "Product",
  average: "Average",
  min: "Minimum",
  max: "Maximum",
  custom: "Custom JS",
};

export const ACRO_BORDER_STYLE_LABELS: Record<AcroBorderStyle, string> = {
  solid: "Solid",
  dashed: "Dashed",
  underline: "Underline",
  beveled: "Beveled",
  inset: "Inset",
};

export const ACRO_BUTTON_ACTION_LABELS: Record<AcroButtonAction, string> = {
  none: "None",
  submit: "Submit form",
  reset: "Reset form",
  js: "Run JavaScript",
};

// Widget types that produce interactive AcroForm fields in the PDF.
export const ACRO_FIELD_TYPES = new Set([
  "text",
  "multiline",
  "number",
  "currency",
  "date",
  "checkbox",
  "radio",
  "dropdown",
  "signature-field",
  "button",
]);

export function isAcroFieldType(type: string): boolean {
  return ACRO_FIELD_TYPES.has(type);
}
