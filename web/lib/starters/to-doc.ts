/**
 * Starter → StoredDoc helper.
 *
 * Starters ship with HTML + Go-template source as the canonical
 * authoring format.  For doc-mode templates we need a StoredDoc AST.
 * This helper picks the precomputed AST when a starter ships one and
 * otherwise runs the browser-side importer.  Diagnostics from the
 * importer are returned alongside so callers can surface any
 * downgrades (e.g. a `<dl>` with embedded control flow that became a
 * Raw block).
 *
 * Node callers — e.g. the smoke-test scripts — must supply a
 * `parser` (typically `new new JSDOM().window.DOMParser()`); the
 * browser uses the native global.
 */

import { importHtml, type ImportDiagnostic } from "@/lib/doc/import";
import { wrapStoredDoc, type StoredDoc } from "@/lib/doc/ast";
import type { Starter } from "./types";

export interface StarterDocResult {
  stored: StoredDoc;
  diagnostics: ImportDiagnostic[];
}

export function getStarterDoc(
  starter: Starter,
  opts: { parser?: DOMParser } = {},
): StarterDocResult {
  if (starter.docAst) {
    return { stored: starter.docAst, diagnostics: [] };
  }
  const { doc, diagnostics, themeCss } = importHtml(starter.html, opts);
  return { stored: wrapStoredDoc(doc, themeCss), diagnostics };
}
