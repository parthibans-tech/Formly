import {
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  FileVideo,
  Hash,
  Presentation,
  type LucideIcon,
} from "lucide-react";

export type FileKind =
  | "pdf"
  | "doc"
  | "sheet"
  | "slides"
  | "html"
  | "markdown"
  | "text"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "code"
  | "other";

export function categorizeFile(mime: string, name = ""): FileKind {
  const m = (mime || "").toLowerCase();
  const lower = name.toLowerCase();
  const ext = lower.split(".").pop() || "";

  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (
    m.includes("wordprocessing") ||
    m.includes("msword") ||
    ["doc", "docx", "odt", "rtf"].includes(ext)
  )
    return "doc";
  if (
    m.includes("spreadsheet") ||
    m.includes("excel") ||
    m === "text/csv" ||
    ["xls", "xlsx", "ods", "csv", "tsv"].includes(ext)
  )
    return "sheet";
  if (
    m.includes("presentation") ||
    m.includes("powerpoint") ||
    ["ppt", "pptx", "odp", "key"].includes(ext)
  )
    return "slides";
  if (m === "text/html" || ext === "html" || ext === "htm") return "html";
  if (m === "text/markdown" || ext === "md" || ext === "markdown")
    return "markdown";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (
    ["zip", "rar", "7z", "tar", "gz", "bz2"].includes(ext) ||
    m.includes("zip") ||
    m.includes("compressed")
  )
    return "archive";
  if (
    ["js", "ts", "tsx", "jsx", "py", "go", "rs", "java", "cpp", "c", "rb", "php", "json", "xml", "yml", "yaml"].includes(
      ext
    ) ||
    m.includes("javascript") ||
    m.includes("json") ||
    m.includes("xml")
  )
    return "code";
  if (m.startsWith("text/")) return "text";
  return "other";
}

export function iconForKind(kind: FileKind): LucideIcon {
  switch (kind) {
    case "pdf":
      return FileType2;
    case "doc":
      return FileText;
    case "sheet":
      return FileSpreadsheet;
    case "slides":
      return Presentation;
    case "html":
      return FileCode2;
    case "markdown":
      return Hash;
    case "image":
      return FileImage;
    case "video":
      return FileVideo;
    case "audio":
      return FileAudio;
    case "archive":
      return FileArchive;
    case "code":
      return FileCode2;
    case "text":
      return FileText;
    default:
      return File;
  }
}

// Back-compat: existing callers use iconForMime / colorForMime directly.
export function iconForMime(mime: string, name = ""): LucideIcon {
  return iconForKind(categorizeFile(mime, name));
}

// Foreground text color by kind.
export function colorForKind(kind: FileKind): string {
  switch (kind) {
    case "pdf":
      return "text-red-500";
    case "doc":
      return "text-blue-500";
    case "sheet":
      return "text-emerald-500";
    case "slides":
      return "text-orange-500";
    case "html":
      return "text-orange-500";
    case "markdown":
      return "text-sky-500";
    case "image":
      return "text-violet-500";
    case "video":
      return "text-pink-500";
    case "audio":
      return "text-rose-500";
    case "archive":
      return "text-amber-500";
    case "code":
      return "text-indigo-500";
    case "text":
      return "text-slate-500";
    default:
      return "text-slate-500";
  }
}

export function colorForMime(mime: string, name = ""): string {
  return colorForKind(categorizeFile(mime, name));
}

// Google-Drive-style colored badge (solid color on the badge square).
// Returns tailwind classes for { background, foreground (icon color) }.
export function badgeColorsForKind(kind: FileKind): {
  bg: string;
  fg: string;
} {
  switch (kind) {
    case "pdf":
      return { bg: "bg-red-500", fg: "text-white" };
    case "doc":
      return { bg: "bg-blue-500", fg: "text-white" };
    case "sheet":
      return { bg: "bg-emerald-500", fg: "text-white" };
    case "slides":
      return { bg: "bg-orange-500", fg: "text-white" };
    case "html":
      return { bg: "bg-orange-500", fg: "text-white" };
    case "markdown":
      return { bg: "bg-sky-500", fg: "text-white" };
    case "image":
      return { bg: "bg-violet-500", fg: "text-white" };
    case "video":
      return { bg: "bg-pink-500", fg: "text-white" };
    case "audio":
      return { bg: "bg-rose-500", fg: "text-white" };
    case "archive":
      return { bg: "bg-amber-500", fg: "text-white" };
    case "code":
      return { bg: "bg-indigo-500", fg: "text-white" };
    case "text":
      return { bg: "bg-slate-500", fg: "text-white" };
    default:
      return { bg: "bg-slate-400", fg: "text-white" };
  }
}

// Short label shown in the preview tile when no real thumbnail is available.
export function shortLabelForKind(kind: FileKind): string {
  switch (kind) {
    case "pdf":
      return "PDF";
    case "doc":
      return "DOC";
    case "sheet":
      return "SHEET";
    case "slides":
      return "SLIDES";
    case "html":
      return "HTML";
    case "markdown":
      return "MD";
    case "image":
      return "IMAGE";
    case "video":
      return "VIDEO";
    case "audio":
      return "AUDIO";
    case "archive":
      return "ZIP";
    case "code":
      return "CODE";
    case "text":
      return "TXT";
    default:
      return "FILE";
  }
}
