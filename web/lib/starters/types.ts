import type { StoredDoc } from "@/lib/doc/ast";

export type StarterCategory =
  | "Billing"
  | "Legal"
  | "HR"
  | "Certificates"
  | "Commerce";

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
  /** Optional precomputed AST.  When present, callers can skip the
   *  runtime importer entirely.  When absent, `getStarterDoc()`
   *  imports on demand.  (The starters in this repo currently don't
   *  ship pre-imported ASTs — they rely on on-demand import.) */
  docAst?: StoredDoc;
};
