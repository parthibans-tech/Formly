/**
 * Client helper for the rename-template flow.
 *
 * Hits `PATCH /v1/templates/:id`, which updates both the template row and
 * the underlying file row in a single transaction. Uniqueness is enforced
 * server-side per org (case-insensitive, non-trashed). On collision the
 * server returns HTTP 409 with error code `name_conflict`; callers should
 * render that inline on the rename input — don't treat it as a generic
 * "save failed".
 *
 * Usage:
 *   await renameTemplate(tpl.id, "Q2 invoices");
 */
import { api, ApiError } from "@/lib/api";

export interface RenameTemplateResult {
  id: string;
  name: string;
  /** Final filename on the files table — may include the extension the
   *  server preserved (e.g. ".pdf" / ".docast"). Surface this in the UI
   *  when showing the underlying file name separately from the template's
   *  display name. */
  fileName: string;
}

export async function renameTemplate(
  id: string,
  name: string,
): Promise<RenameTemplateResult> {
  return api<RenameTemplateResult>(`/v1/templates/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

/** Narrow helper so designers can render the right error copy without
 *  string-matching on `.message`. */
export function isNameConflict(e: unknown): e is ApiError {
  return e instanceof ApiError && e.code === "name_conflict";
}
