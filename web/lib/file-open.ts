import { api } from "@/lib/api";

// Minimal shape for files-related click logic. Matches the public
// fields of FileList's FileItem and Drive's local FileItem so callers
// can pass either without a structural cast.
export type OpenableFile = {
  id: string;
  name: string;
  mime: string;
  templateId?: string;
  previewPdfId?: string | null;
  convertStatus?:
    | "pending"
    | "ready"
    | "failed"
    | "unsupported"
    | "macro_warning"
    | null;
};

// designerEligible mirrors api/internal/templates.DetectAndCreate so
// the row click and the action menu can decide "should I show 'Open
// designer'?" with the same predicate the server uses to seed templates.
//
// Plain text (.txt) was previously included here and routed through the
// markdown designer — that surprised users who just wanted a text
// editor. It now routes to the ONLYOFFICE document editor instead
// (canOpenInOnlyOffice).
export function designerEligible(f: { mime: string; name: string }): boolean {
  const ext = f.name.toLowerCase().split(".").pop() ?? "";
  const isImage = f.mime.startsWith("image/") && !f.mime.includes("svg");
  const isMarkdown =
    f.mime === "text/markdown" || ext === "md" || ext === "markdown";
  const isHTML = f.mime === "text/html" || ext === "html" || ext === "htm";
  const isPDF = f.mime === "application/pdf" || ext === "pdf";
  return isImage || isMarkdown || isHTML || isPDF;
}

// canOpenInDesigner reports whether `Open designer` (PDF / form-style
// designer) should appear. Covers (a) files with an existing template,
// (b) designer-eligible uploads whose template just hasn't been
// backfilled yet, and (c) office docs whose convert-to-pdf has produced
// a sibling PDF that *can* host a template.
//
// Office docs without a sibling PDF are *not* covered here — they route
// to the ONLYOFFICE document editor (canOpenInOnlyOffice) instead. The
// PDF designer is for static / form layouts; native DOCX editing
// belongs in a real document editor.
export function canOpenInDesigner(f: OpenableFile): boolean {
  if (f.templateId) return true;
  if (designerEligible(f)) return true;
  if (
    (f.convertStatus === "ready" || f.convertStatus === "macro_warning") &&
    !!f.previewPdfId
  ) {
    return true;
  }
  return false;
}

// openInDesigner is idempotent. For office docs with a ready preview
// it targets the *preview* row so the designer opens the PDF (not the
// original DOCX/RTF/etc.). On success returns the templateId; on a
// "no detector for this type" response, returns null so the caller can
// surface a useful toast instead of a silent navigation failure.
export async function openInDesigner(
  f: OpenableFile,
  navigate: (href: string) => void
): Promise<string | null> {
  if (f.templateId) {
    navigate(`/templates/${f.templateId}/designer`);
    return f.templateId;
  }
  const targetId =
    (f.convertStatus === "ready" || f.convertStatus === "macro_warning") &&
    f.previewPdfId
      ? f.previewPdfId
      : f.id;
  return ensureTemplateAndNav(targetId, navigate);
}

// canOpenInOnlyOffice mirrors api/internal/onlyoffice.IsEditableByOnlyOffice.
// Office documents (Word, Excel, PowerPoint and their OpenDocument
// equivalents) route to the ONLYOFFICE editor instead of the PDF
// designer. The backend picks word/cell/slide off the extension; we
// only need a "should I show the entry?" predicate here. The check is
// mostly extension-based since browsers send inconsistent MIME for
// older Office formats.
const ONLYOFFICE_DOC_EXTS = new Set([
  // word
  "docx", "doc", "docm", "dotx", "dot", "dotm",
  "odt", "ott",
  "rtf", "txt",
  // cell
  "xlsx", "xls", "xlsm", "xltx", "xlt", "xltm",
  "ods", "ots",
  "csv",
  // slide
  "pptx", "ppt", "pptm", "potx", "pot", "potm",
  "ppsx", "pps", "ppsm",
  "odp", "otp",
]);
const ONLYOFFICE_DOC_MIMES = new Set([
  // word
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  "application/vnd.ms-word.document.macroenabled.12",
  "application/vnd.ms-word.template.macroenabled.12",
  "application/rtf",
  "text/rtf",
  "application/vnd.oasis.opendocument.text",
  "text/plain",
  // cell
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.ms-excel.template.macroenabled.12",
  "application/vnd.oasis.opendocument.spreadsheet",
  "text/csv",
  // slide
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.presentationml.template",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  "application/vnd.ms-powerpoint.presentation.macroenabled.12",
  "application/vnd.ms-powerpoint.template.macroenabled.12",
  "application/vnd.ms-powerpoint.slideshow.macroenabled.12",
  "application/vnd.oasis.opendocument.presentation",
]);

export function canOpenInOnlyOffice(f: { mime: string; name: string }): boolean {
  const ext = f.name.toLowerCase().split(".").pop() ?? "";
  if (ONLYOFFICE_DOC_EXTS.has(ext)) return true;
  return ONLYOFFICE_DOC_MIMES.has(f.mime.toLowerCase());
}

// openInOnlyOffice is just a navigation helper — the editor page does
// all the real work (config fetch, script inject, DocEditor mount).
// Centralized here so callers don't hardcode the route shape.
export function openInOnlyOffice(
  f: { id: string },
  navigate: (href: string) => void
): void {
  navigate(`/editor/${f.id}`);
}

async function ensureTemplateAndNav(
  fileId: string,
  navigate: (href: string) => void
): Promise<string | null> {
  const { templateId } = await api<{ templateId: string }>(
    `/v1/files/${fileId}/ensure-template`,
    { method: "POST" }
  );
  if (!templateId) return null;
  navigate(`/templates/${templateId}/designer`);
  return templateId;
}

// canOpenInCodeEditor mirrors api/internal/textcontent.IsCodeEditable.
// Source files (js/ts/py/css/...) and plain-text configs route to the
// in-app CodeMirror editor. ONLYOFFICE-owned formats are excluded so
// the two editors never overlap; the designer-eligible image / PDF /
// HTML / markdown formats are excluded as well — those have their own
// purpose-built editors.
const CODE_EDITOR_EXTS = new Set([
  // JS / TS family
  "js", "jsx", "ts", "tsx", "mjs", "cjs",
  // mainstream languages
  "py", "pyi", "rb", "go", "rs", "java", "kt", "kts", "swift",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "m", "mm",
  "cs", "php", "lua", "pl", "r", "scala", "clj", "ex", "exs",
  "erl", "hs", "ml", "dart", "groovy", "vb", "f", "f90",
  // data / query
  "sql", "graphql", "gql", "proto",
  // styling
  "css", "scss", "sass", "less",
  // markup (not markdown — that has its own designer)
  "xml", "svg", "vue", "svelte", "astro",
  // config
  "json", "json5", "jsonc", "yaml", "yml", "toml",
  "ini", "cfg", "conf", "env", "properties",
  // shells
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  // infra
  "tf", "tfvars", "hcl", "nix",
  "makefile", "mk",
  "dockerfile", "containerfile",
  // misc plain text
  "log", "txt",
  "gitignore", "gitattributes", "editorconfig",
  "lock",
]);

const CODE_EDITOR_BASENAMES = new Set([
  "dockerfile", "containerfile",
  "makefile", "gnumakefile",
  ".gitignore", ".gitattributes", ".dockerignore", ".editorconfig",
  ".env", ".npmrc", ".prettierrc", ".eslintrc", ".eslintignore",
  ".browserslistrc",
  "procfile", "rakefile", "gemfile", "podfile",
]);

// HTML / markdown / images / PDFs have purpose-built editors elsewhere
// in the app. We don't want the code editor to shadow them, even though
// HTML/SVG/markdown are technically text. The drive picks at most one
// editor per file via the if/else-if chain in the menu logic.
const DESIGNER_OWNED_EXTS = new Set([
  "pdf", "html", "htm", "md", "markdown",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff",
]);

export function canOpenInCodeEditor(f: { mime: string; name: string }): boolean {
  if (canOpenInOnlyOffice(f)) return false;
  const lower = f.name.toLowerCase();
  const ext = lower.split(".").pop() ?? "";
  if (DESIGNER_OWNED_EXTS.has(ext)) return false;
  if (CODE_EDITOR_EXTS.has(ext)) return true;
  const base = lower.split("/").pop() ?? lower;
  if (CODE_EDITOR_BASENAMES.has(base)) return true;
  const m = f.mime.toLowerCase();
  if (m.startsWith("text/") && m !== "text/html" && m !== "text/markdown") {
    return true;
  }
  switch (m) {
    case "application/json":
    case "application/xml":
    case "application/javascript":
    case "application/typescript":
    case "application/x-sh":
    case "application/x-yaml":
    case "application/toml":
    case "application/x-shellscript":
      return true;
  }
  return false;
}

export function openInCodeEditor(
  f: { id: string },
  navigate: (href: string) => void
): void {
  navigate(`/code/${f.id}`);
}

// languageForName maps a file's extension/basename to the CodeMirror
// language pack key the editor should lazy-load. Returning "" means
// "plain text, no language extension" — CodeMirror still renders fine,
// just without syntax highlighting.
export function languageForName(name: string): string {
  const lower = name.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  // Basename overrides win — Dockerfile etc. have no extension.
  if (base === "dockerfile" || base === "containerfile") return "dockerfile";
  if (base === "makefile" || base === "gnumakefile" || base.endsWith(".mk"))
    return "makefile";

  const ext = lower.split(".").pop() ?? "";
  switch (ext) {
    case "js": case "jsx": case "mjs": case "cjs":
      return "javascript";
    case "ts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "py": case "pyi":
      return "python";
    case "rb":
      return "ruby";
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "java":
      return "java";
    case "kt": case "kts":
      return "kotlin";
    case "swift":
      return "swift";
    case "c": case "h":
      return "c";
    case "cc": case "cpp": case "cxx": case "hpp": case "hh":
      return "cpp";
    case "cs":
      return "csharp";
    case "php":
      return "php";
    case "lua":
      return "lua";
    case "sql":
      return "sql";
    case "css":
      return "css";
    case "scss": case "sass": case "less":
      return "css";
    case "html": case "htm": case "vue": case "svelte": case "astro":
      return "html";
    case "xml": case "svg":
      return "xml";
    case "json": case "json5": case "jsonc":
      return "json";
    case "yaml": case "yml":
      return "yaml";
    case "toml":
      return "toml";
    case "sh": case "bash": case "zsh": case "fish":
      return "shell";
    case "dockerfile":
      return "dockerfile";
    default:
      return "";
  }
}

// canExportPDF reports whether the "Export as PDF" action should appear
// for a given file. Mirrors api/internal/docconvert.IsConvertible — we
// route the predicate through the filename extension so the menu shows
// the entry consistently with what the backend would actually accept.
const CONVERTIBLE_EXTS = new Set([
  "doc", "docx", "docm",
  "dot", "dotx", "dotm",
  "rtf", "odt", "ott", "wps",
]);
const CONVERTIBLE_MIMES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-word.document.macroenabled.12",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  "application/vnd.ms-word.template.macroenabled.12",
  "application/rtf",
  "text/rtf",
  "application/vnd.oasis.opendocument.text",
]);

export function canExportPDF(f: { mime: string; name: string }): boolean {
  const ext = f.name.toLowerCase().split(".").pop() ?? "";
  if (CONVERTIBLE_EXTS.has(ext)) return true;
  return CONVERTIBLE_MIMES.has(f.mime.toLowerCase());
}

// requestPDFExport kicks off the async LibreOffice conversion. Returns
// when the job is queued (status 202); the actual conversion lands
// later via the worker, which flips files.convert_status to 'ready'
// and sets preview_pdf_id. Callers should refresh after a short delay
// or surface a "converting…" state until the file row updates.
export async function requestPDFExport(fileId: string): Promise<void> {
  await api(`/v1/files/${fileId}/export-pdf`, { method: "POST" });
}
