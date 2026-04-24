import { api } from "@/lib/api";

const STARTER_MD = `# {{ .title }}

Hello **{{ .name }}**, welcome to Drive360 Markdown templates.

- Write in [Markdown](https://commonmark.org/) with GFM extensions.
- Use \`{{ .placeholders }}\` for dynamic values.
- Use \`{{ range .items }} … {{ end }}\` for lists.

| Feature | Supported |
|---|---|
| Headings | ✔ |
| Tables | ✔ |
| Code blocks | ✔ |

> Save, then click Generate to render this as a PDF.
`;

export async function createMarkdownTemplate(opts: {
  name: string;
  content?: string;
  folderId?: string;
}): Promise<{ fileId: string; templateId: string }> {
  const filename = opts.name.endsWith(".md") ? opts.name : `${opts.name}.md`;
  const body = opts.content ?? STARTER_MD;

  // conflict=keep preserves the historical "silently auto-rename to foo (2).md"
  // behaviour for programmatically-created templates — the UI that kicks these
  // off doesn't have a surface to prompt from, and duplicate starters are
  // expected (e.g. a user creating two "Untitled markdown" back-to-back).
  const { fileId, uploadUrl } = await api<{
    fileId: string;
    uploadUrl: string;
  }>("/v1/files/upload-url", {
    method: "POST",
    body: JSON.stringify({
      name: filename,
      mime: "text/markdown",
      folderId: opts.folderId,
      conflict: "keep",
    }),
  });

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "text/markdown" },
    body,
  });
  if (!putRes.ok) throw new Error(`upload failed: ${putRes.status}`);

  const complete = await api<{ templateId?: string }>(
    `/v1/files/${fileId}/complete`,
    { method: "POST" }
  );
  if (!complete.templateId) {
    throw new Error("template was not created");
  }

  return { fileId, templateId: complete.templateId };
}
