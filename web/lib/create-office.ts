import { api } from "@/lib/api";

// One-shot create of a blank Word / Excel / PowerPoint document. Calls
// the server-side blank-office endpoint which generates a minimal valid
// OOXML package, drops it in object storage, and marks the resulting
// file row active in a single round-trip — there's no presigned PUT
// dance because the bytes are server-generated and don't need scanning.
//
// The caller is expected to immediately navigate to /editor/{fileId},
// where the existing OnlyOffice integration takes over.
export type OfficeKind = "docx" | "xlsx" | "pptx";

export async function createBlankOffice(opts: {
  kind: OfficeKind;
  name?: string;
  folderId?: string;
}): Promise<{ fileId: string; name: string; mime: string; size: number }> {
  return api<{
    fileId: string;
    name: string;
    mime: string;
    size: number;
  }>("/v1/files/blank-office", {
    method: "POST",
    body: JSON.stringify({
      kind: opts.kind,
      name: opts.name,
      folderId: opts.folderId,
    }),
  });
}
