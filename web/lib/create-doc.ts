/**
 * Client helper for creating doc-mode templates.
 *
 * Posts to /v1/templates/doc with an optional seed AST.  The server
 * stores it in the versioned envelope (see CreateDocTemplate) and
 * returns the new fileId/templateId.
 *
 * Callers typically either:
 *   - Pass no seed → creates an empty one-paragraph document.
 *   - Pass a `seedDoc` (the inner `Doc` tree — NOT the outer
 *     `StoredDoc` envelope).  The server wraps it in the current
 *     version envelope so version bumps don't leak to clients.
 */

import { api } from "@/lib/api";
import type { Doc } from "@/lib/doc/ast";

export async function createDocTemplate(opts: {
  name: string;
  seedDoc?: Doc;
  /** Per-template theme CSS (see `StoredDoc.themeCss`). Passed through
   *  untouched — the server stores it alongside the AST. */
  themeCss?: string;
  folderId?: string;
}): Promise<{ fileId: string; templateId: string }> {
  const body: Record<string, unknown> = { name: opts.name };
  if (opts.seedDoc) body.doc = opts.seedDoc;
  if (opts.themeCss && opts.themeCss.trim() !== "") body.themeCss = opts.themeCss;
  if (opts.folderId) body.folderId = opts.folderId;

  return api<{ fileId: string; templateId: string }>("/v1/templates/doc", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
