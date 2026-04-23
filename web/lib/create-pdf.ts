import { api } from "@/lib/api";

export type BlankPdfOpts = {
  name: string;
  pageSize?: "A4" | "Letter" | "Legal" | "A3" | "A5";
  orientation?: "portrait" | "landscape";
  pages?: number;
  folderId?: string;
};

// Creates a new blank PDF via the server and returns the created template ID.
// The PDF is created in static mode so the StaticDesigner can then place widgets.
export async function createBlankPdfTemplate(
  opts: BlankPdfOpts
): Promise<{ fileId: string; templateId: string }> {
  const res = await api<{ fileId: string; templateId: string }>(
    "/v1/templates/blank-pdf",
    {
      method: "POST",
      body: JSON.stringify({
        name: opts.name,
        pageSize: opts.pageSize ?? "Letter",
        orientation: opts.orientation ?? "portrait",
        pages: opts.pages ?? 1,
        folderId: opts.folderId,
      }),
    }
  );
  return res;
}
