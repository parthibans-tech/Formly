import type { StoredDoc } from "@/lib/doc/ast";

export type StarterCategory =
  | "Billing"
  | "Legal"
  | "HR"
  | "Certificates"
  | "Commerce"
  | "Correspondence"
  | "Reports"
  | "Marketing"
  | "Finance"
  | "Operations"
  | "Events"
  | "Education";

// ---------------------------------------------------------------------------
// Form schema — drives resume.io-style fill mode.
// ---------------------------------------------------------------------------
//
// A starter declares the *shape* of its sampleData via `formSchema`.  When
// present, end-users get a structured form bound to that shape instead of
// editing the AST directly.  The schema is purely a UX hint — the underlying
// renderer still drives off the data tree.
//
// Paths are dot-notation rooted at the data object.  E.g. "person.name"
// addresses `data.person.name`.  List paths address arrays; row fields
// inside a list are addressed relative to the row.

export type FieldType =
  | "text"
  | "longtext"
  | "email"
  | "url"
  | "tel"
  | "date";

export interface ScalarField {
  id: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  help?: string;
  optional?: boolean;
}

export interface ObjectGroup {
  kind: "object";
  id: string;
  label: string;
  /** Path to an object node in the data tree. */
  path: string;
  fields: ScalarField[];
}

export interface ScalarGroup {
  kind: "scalar";
  id: string;
  label: string;
  path: string;
  type: FieldType;
  placeholder?: string;
  help?: string;
}

export interface StringListGroup {
  kind: "string-list";
  id: string;
  label: string;
  path: string;
  itemPlaceholder?: string;
  help?: string;
}

export interface ObjectListGroup {
  kind: "object-list";
  id: string;
  label: string;
  path: string;
  /** Pattern for the row header. Tokens like {title} are replaced with
   *  the row's matching field value. */
  itemLabel?: string;
  /** Each row is an object; fields can be scalars or nested string-lists. */
  fields: Array<ScalarField | { id: string; label: string; type: "string-list"; itemPlaceholder?: string }>;
  /** Used when the user clicks "Add" — a fresh row template. */
  newItem: Record<string, unknown>;
}

export type FormGroup = ObjectGroup | ScalarGroup | StringListGroup | ObjectListGroup;

export interface FormSchema {
  groups: FormGroup[];
}

export type Starter = {
  id: string;
  name: string;
  description: string;
  category: StarterCategory;
  tags: string[];
  /** HTML + Go-template source.  Remains the authoring source of truth;
   *  the AST is derived from it at starter-selection time. */
  html: string;
  sampleData: Record<string, unknown>;
  /** Optional structured-form schema.  When set, the starter supports
   *  resume.io-style fill mode (form on the left, live preview on the
   *  right).  Without it the starter still works through the AST editor. */
  formSchema?: FormSchema;
  /** Optional precomputed AST.  When present, callers can skip the
   *  runtime importer entirely.  When absent, `getStarterDoc()`
   *  imports on demand.  (The starters in this repo currently don't
   *  ship pre-imported ASTs — they rely on on-demand import.) */
  docAst?: StoredDoc;
};
