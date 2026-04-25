"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  Check,
  CheckSquare,
  ChevronRight,
  Camera,
  Copy,
  Download,
  Eye,
  BookTemplate,
  ClipboardList,
  FileCode2,
  FileType2,
  Hash,
  FolderPlus,
  FolderOpen,
  Folder as FolderIcon,
  Grid3x3,
  Home,
  KeyRound,
  LayoutList,
  Link2,
  Lock,
  LockOpen,
  MoreHorizontal,
  Move,
  PencilLine,
  Plus,
  RefreshCw,
  Search,
  Share2,
  SlidersHorizontal,
  Star,
  Trash2,
  Upload,
  UploadCloud,
  Users,
  X,
} from "lucide-react";
import { api, API_URL, ApiError, clearSession, getToken, getUser } from "@/lib/api";
import { UploadTooLargeError, uploadToPresign } from "@/lib/upload";
import {
  canExportPDF,
  canOpenInCodeEditor,
  canOpenInDesigner,
  canOpenInOnlyOffice,
  openInCodeEditor,
  openInDesigner as openInDesignerShared,
  openInOnlyOffice,
  requestPDFExport,
} from "@/lib/file-open";
import { useToast } from "@/components/toast";
import {
  UploadConflictDialog,
  type ConflictChoice,
  type UploadConflict,
} from "@/components/upload-conflict-dialog";
import { UploadDropzone } from "@/components/upload-dropzone";
import { CameraCaptureDialog } from "@/components/camera-capture-dialog";
import { MergeFilesDialog } from "@/components/merge-files-dialog";
import { InsertPagesDialog } from "@/components/insert-pages-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { useConfirm } from "@/components/ui/confirm";
import { usePrompt } from "@/components/ui/prompt";
import { createHtmlTemplate } from "@/lib/create-html";
import { createDocTemplate } from "@/lib/create-doc";
import { createMarkdownTemplate } from "@/lib/create-markdown";
import { createBlankPdfTemplate, type BlankPdfOpts } from "@/lib/create-pdf";
import { AppShell } from "@/components/app-shell";
import { StarterBrowser } from "@/components/starter-browser";
import { BlankPdfDialog } from "@/components/blank-pdf-dialog";
import { FormBuilderDialog } from "@/components/form-builder-dialog";
import {
  createFormTemplate,
  type CreateFormOpts,
} from "@/lib/create-form";
import type { Starter } from "@/lib/starters";
import { getStarterDoc } from "@/lib/starters";
import { iconForMime } from "@/lib/file-icons";
import { FileGridCard, type GridCardMenuItem } from "@/components/file-grid-card";
import { FolderGridCard } from "@/components/folder-grid-card";
import { ShareModal } from "@/components/share-modal";
import { SharePeopleModal } from "@/components/share-people-modal";
import { FilePreviewDialog } from "@/components/file-preview-dialog";
import { MediaPreviewDialog } from "@/components/media-preview-dialog";
import { ViewToggle } from "@/components/view-toggle";
import { useViewMode } from "@/hooks/use-view-mode";
import { cn } from "@/lib/utils";

type FileItem = {
  id: string;
  name: string;
  mime: string;
  size: number;
  status: string;
  templateId?: string;
  folderId?: string | null;
  createdAt: string;
  // Per-user starred flag (see api/internal/files — starred_files JOIN).
  starred?: boolean;
  // Office-doc preview pipeline. Populated for sources that go through
  // soffice convert-to-pdf. When convertStatus is "ready" or
  // "macro_warning", previewPdfId points at the sibling PDF row.
  previewPdfId?: string | null;
  convertStatus?:
    | "pending"
    | "ready"
    | "failed"
    | "unsupported"
    | "macro_warning"
    | null;
  convertWarning?: string | null;
};

type Folder = {
  id: string;
  parentId: string | null;
  name: string;
  createdAt: string;
  // Locked = folder is part of the vault. Server returns 423 when listing
  // contents without an active vault session — the global VaultUnlockProvider
  // intercepts that and prompts for re-auth automatically.
  locked?: boolean;
  lockedAt?: string;
};

type Share = {
  id: string;
  token: string;
  role: string;
  expiresAt?: string;
  createdAt: string;
  passwordProtected?: boolean;
  oneTime?: boolean;
  downloadLimit?: number | null;
  downloadCount?: number;
};

export default function DrivePage() {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const searchParams = useSearchParams();
  const currentFolderId = searchParams.get("folder") || "";

  const [user, setUser] = useState<any>(null);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<{ name: string; pct: number } | null>(
    null
  );
  // Upload conflict prompt — non-null while we're waiting on the user
  // to pick Replace / Keep / Cancel after a 409 from the server.
  // `resolve` is the promise resolver the `upload()` fn awaits.
  const [conflict, setConflict] = useState<
    | ({
        resolve: (choice: ConflictChoice) => void;
      } & UploadConflict)
    | null
  >(null);
  const [err, setErr] = useState<string | null>(null);
  const [shareFor, setShareFor] = useState<FileItem | null>(null);
  const [previewFor, setPreviewFor] = useState<FileItem | null>(null);
  // In-app audio / video preview target. Separate from `previewFor`
  // (which is PDF-only and routes through the heavy react-pdf shell)
  // so we don't pay the pdf.js worker cost for a media click.
  const [mediaPreviewFor, setMediaPreviewFor] = useState<FileItem | null>(
    null,
  );
  // People/group ACL dialog target. Files and folders both flow through
  // this state — the resource type disambiguates which endpoints the
  // modal talks to. `null` = closed.
  const [sharePeopleFor, setSharePeopleFor] = useState<
    { id: string; name: string; type: "file" | "folder" } | null
  >(null);
  const [search, setSearch] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [creatingStarterId, setCreatingStarterId] = useState<string | null>(null);
  const [blankPdfOpen, setBlankPdfOpen] = useState(false);
  const [formBuilderOpen, setFormBuilderOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);

  // Drive view state (shared hook — grid by default, persisted).
  const [viewMode, setViewMode] = useViewMode();
  const [sortBy, setSortBy] = useState<"name" | "modified" | "size" | "type">(
    "modified"
  );
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [typeFilter, setTypeFilter] = useState<
    "all" | "templates" | "pdf" | "html" | "markdown" | "image" | "other"
  >("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // PDF merge / insert dialog state. mergeOpen drives the multi-file
  // stitch flow (bulk toolbar entry); insertFor drives the single-PDF
  // splice flow (row-action entry on PDF rows). Mutually exclusive in
  // practice — only one dialog mounts at a time.
  const [mergeOpen, setMergeOpen] = useState(false);
  const [insertFor, setInsertFor] = useState<{ id: string; name: string } | null>(null);
  const [dropTargetFolder, setDropTargetFolder] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    setUser(getUser());
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, currentFolderId]);

  async function load() {
    setLoading(true);
    try {
      const [f, d] = await Promise.all([
        api<{ files: FileItem[] }>(
          `/v1/files?folder=${encodeURIComponent(currentFolderId)}`
        ),
        api<{ folders: Folder[] }>(
          `/v1/folders?parent=${encodeURIComponent(currentFolderId)}`
        ),
      ]);
      setFiles(f.files);
      setFolders(d.folders);
      if (currentFolderId) {
        const b = await api<{ breadcrumbs: Folder[] }>(
          `/v1/folders/${currentFolderId}/breadcrumbs`
        );
        setBreadcrumbs(b.breadcrumbs);
      } else {
        setBreadcrumbs([]);
      }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  // Open the conflict dialog and wait for the user's choice. Resolves
  // with "replace" | "keep" | "cancel". Wrapped in a promise so the
  // upload flow can `await` it inline.
  function askConflict(info: UploadConflict): Promise<ConflictChoice> {
    return new Promise((resolve) => {
      setConflict({ ...info, resolve });
    });
  }

  async function upload(
    file: File,
    conflictStrategy?: "replace" | "keep"
  ) {
    setErr(null);
    setUploading({ name: file.name, pct: 0 });
    try {
      // Ask for an upload URL. The server checks for a same-name + same-type
      // file in the current folder first; a 409 means the user has to pick
      // Replace / Keep both / Cancel before we can proceed.
      let createResp: {
        fileId: string;
        uploadUrl?: string;
        upload?: { url: string; fields: Record<string, string> };
        maxBytes?: number;
        resolvedName?: string;
        replaced?: boolean;
      };
      try {
        createResp = await api("/v1/files/upload-url", {
          method: "POST",
          body: JSON.stringify({
            name: file.name,
            mime: file.type,
            // Forward the size so the server can reject oversize uploads
            // before issuing a presign — saves us from streaming a GB
            // just to learn it's over the limit.
            size: file.size,
            folderId: currentFolderId || undefined,
            conflict: conflictStrategy,
          }),
        });
      } catch (e: any) {
        if (
          e instanceof ApiError &&
          e.status === 409 &&
          e.code === "name_conflict"
        ) {
          // Server tucks the collision details on the `error` object
          // (existingFileId / existingName / isTemplate). Surface the
          // dialog, then retry with whatever the user picked.
          const raw = e.raw?.error ?? {};
          setUploading(null);
          const choice = await askConflict({
            fileName: file.name,
            existingFileId: raw.existingFileId || "",
            existingName: raw.existingName || file.name,
            isTemplate: !!raw.isTemplate,
          });
          if (choice === "cancel") {
            toast.show("info", "Upload cancelled");
            return;
          }
          await upload(file, choice);
          return;
        }
        throw e;
      }

      const {
        fileId,
        upload: postUpload,
        uploadUrl,
        maxBytes,
        resolvedName,
        replaced,
      } = createResp;
      await uploadToPresign(
        { upload: postUpload, uploadUrl, maxBytes },
        file,
        (pct) => setUploading({ name: file.name, pct })
      );
      const complete = await api<{ templateId?: string }>(
        `/v1/files/${fileId}/complete`,
        { method: "POST" }
      );
      setUploading(null);
      await load();
      // Upload no longer auto-jumps into the designer. The file lands
      // in Drive first; if a template was detected, the user can open
      // the designer from the file's row menu (or by clicking the
      // file). This matches the "I just want to keep the file" flow
      // and removes the surprise redirect for users who are mid-upload.
      const displayName = resolvedName || file.name;
      if (replaced) {
        toast.show("success", `Replaced ${displayName}`);
      } else if (resolvedName && resolvedName !== file.name) {
        toast.show("success", `Uploaded as ${resolvedName}`, {
          description: "A file with that name already existed.",
        });
      } else if (complete.templateId) {
        toast.show("success", `Uploaded ${displayName}`, {
          description: "Saved to Drive — click the file to open designer.",
        });
      } else {
        toast.show("success", `Uploaded ${displayName} to Drive`);
      }
    } catch (e: any) {
      setUploading(null);
      // Friendlier copy for the policy-driven rejections. Both client-side
      // (UploadTooLargeError) and server-side (ApiError 413/415) come
      // through here.
      let title = "Upload failed";
      let desc = e?.message ?? String(e);
      if (e instanceof UploadTooLargeError) {
        title = "File too large";
      } else if (e instanceof ApiError) {
        if (e.status === 413) title = "File too large";
        else if (e.status === 415) title = "File type not allowed";
      }
      setErr(desc);
      toast.show("error", title, { description: desc });
    }
  }

  // uploadMany sequences a batch of dropped files through the existing
  // upload() pipeline. Sequential (not parallel) on purpose:
  //
  //   - Storage presign + complete + template-detect happen per file;
  //     parallelizing them would multiply the load on the API for
  //     little user-visible win on a typical 1–10 file drop.
  //   - The conflict dialog is single-instance — running uploads in
  //     parallel would race two files into the same prompt and the
  //     UX would devolve into confusion.
  //   - load() runs once at the end so the file list updates in a
  //     single re-render instead of flickering on every completion.
  async function uploadMany(files: File[]) {
    for (const f of files) {
      // Skip files that show up empty (rare but possible — e.g. user
      // drops a 0-byte file on macOS). The presign endpoint would
      // accept it; we'd just have a useless empty file in Drive.
      if (f.size === 0) {
        toast.show("info", `Skipped empty file ${f.name}`);
        continue;
      }
      // upload() already handles its own toasts and conflict prompt.
      // Awaiting in serial means the conflict dialog can't be
      // double-mounted by a second drop arriving mid-prompt.
      // eslint-disable-next-line no-await-in-loop
      await upload(f);
    }
  }

  // openInDesigner: thin wrapper around the shared helper for the
  // PDF / form-style designer flows (image / markdown / html / pdf /
  // text + office docs that already have a ready PDF preview). DOCX
  // and friends *without* a preview route to ONLYOFFICE via
  // openInOnlyOffice — the document editor is the right surface for
  // native DOCX editing, the PDF designer is not.
  async function openInDesigner(f: FileItem) {
    try {
      const id = await openInDesignerShared(f, (href) => router.push(href));
      if (!id) {
        toast.show("error", "No designer available for this file type.");
      }
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function download(id: string) {
    try {
      const { downloadUrl } = await api<{ downloadUrl: string }>(
        `/v1/files/${id}/download`
      );
      window.open(downloadUrl, "_blank");
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  // Optimistic star toggle — flip local state first, fire POST or
  // DELETE depending on the new direction, roll back on failure.
  // Keeps the star icon feeling instant even on high-latency links.
  async function toggleStar(file: FileItem) {
    const next = !file.starred;
    setFiles((xs) =>
      xs.map((x) => (x.id === file.id ? { ...x, starred: next } : x))
    );
    try {
      await api(`/v1/files/${file.id}/star`, {
        method: next ? "POST" : "DELETE",
      });
    } catch (e: any) {
      setFiles((xs) =>
        xs.map((x) => (x.id === file.id ? { ...x, starred: !next } : x))
      );
      toast.show("error", "Couldn't update star", { description: e.message });
    }
  }

  async function remove(file: FileItem) {
    const ok = await confirm({
      title: `Move "${file.name}" to trash?`,
      description: "You can restore it later from the trash view.",
      confirmLabel: "Move to trash",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/files/${file.id}`, { method: "DELETE" });
      toast.show("success", "Moved to trash");
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function newFolder() {
    const name = await prompt({
      title: "New folder",
      label: "Folder name",
      placeholder: "e.g. Invoices 2026",
      confirmLabel: "Create",
      validate: (v) => (v.trim().length < 1 ? "Name is required" : null),
    });
    if (!name) return;
    try {
      await api("/v1/folders", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          parentId: currentFolderId || null,
        }),
      });
      toast.show("success", "Folder created");
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function renameFolder(f: Folder) {
    const name = await prompt({
      title: "Rename folder",
      label: "Folder name",
      defaultValue: f.name,
      confirmLabel: "Rename",
      validate: (v) => (v.trim().length < 1 ? "Name is required" : null),
    });
    if (!name || name === f.name) return;
    try {
      await api(`/v1/folders/${f.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim() }),
      });
      toast.show("success", "Folder renamed");
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function deleteFolder(f: Folder) {
    const ok = await confirm({
      title: `Delete folder "${f.name}"?`,
      description: "The folder must be empty to delete.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/folders/${f.id}`, { method: "DELETE" });
      toast.show("success", "Folder deleted");
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  // Toggle the vault lock on a folder. Locking adds the folder to the
  // vault — anyone (including the owner) listing or downloading from
  // it has to re-authenticate first. Unlocking is owner/admin-only and
  // is the only way to remove a folder from the vault permanently;
  // re-auth only opens a 5-minute window.
  async function toggleFolderLock(f: Folder) {
    const next = !f.locked;
    const ok = await confirm({
      title: next ? `Lock "${f.name}"?` : `Remove lock from "${f.name}"?`,
      description: next
        ? "Anyone accessing this folder will need to re-enter their password."
        : "The folder will be accessible without re-authentication.",
      confirmLabel: next ? "Lock folder" : "Remove lock",
    });
    if (!ok) return;
    try {
      await api(`/v1/folders/${f.id}/lock`, {
        method: next ? "POST" : "DELETE",
      });
      toast.show("success", next ? "Folder locked" : "Lock removed");
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function moveFile(file: FileItem) {
    const target = await prompt({
      title: `Move "${file.name}"`,
      description:
        "Paste a folder ID from its URL, or leave blank to move to the root.",
      label: "Target folder ID",
      defaultValue: file.folderId || "",
      placeholder: "Leave empty for root",
      confirmLabel: "Move",
    });
    if (target === null) return;
    try {
      await api(`/v1/files/${file.id}`, {
        method: "PATCH",
        body: JSON.stringify({ folderId: target.trim() || null }),
      });
      toast.show("success", "File moved");
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function createHtml() {
    const name = await prompt({
      title: "Create HTML template",
      description: "Design a document in the rich-text editor with {{placeholders}}.",
      label: "Template name",
      placeholder: "e.g. Invoice template",
      defaultValue: "Untitled template",
      confirmLabel: "Create",
      validate: (v) => (v.trim().length < 1 ? "Name is required" : null),
    });
    if (!name) return;
    setCreating(true);
    try {
      const { templateId } = await createHtmlTemplate({
        name: name.trim(),
        folderId: currentFolderId || undefined,
      });
      toast.show("success", "Template created", {
        description: "Opening the editor…",
      });
      router.push(`/templates/${templateId}/designer`);
    } catch (e: any) {
      toast.show("error", "Couldn't create template", {
        description: e.message,
      });
    } finally {
      setCreating(false);
    }
  }

  async function createMarkdown() {
    const name = await prompt({
      title: "Create Markdown template",
      description: "Write in Markdown with {{ .placeholders }} — render to PDF via Chromium.",
      label: "Template name",
      placeholder: "e.g. Weekly report",
      defaultValue: "Untitled markdown",
      confirmLabel: "Create",
      validate: (v) => (v.trim().length < 1 ? "Name is required" : null),
    });
    if (!name) return;
    setCreating(true);
    try {
      const { templateId } = await createMarkdownTemplate({
        name: name.trim(),
        folderId: currentFolderId || undefined,
      });
      toast.show("success", "Markdown template created");
      router.push(`/templates/${templateId}/designer`);
    } catch (e: any) {
      toast.show("error", "Couldn't create template", {
        description: e.message,
      });
    } finally {
      setCreating(false);
    }
  }

  async function buildForm(opts: Omit<CreateFormOpts, "folderId">) {
    setCreating(true);
    try {
      const { templateId } = await createFormTemplate({
        ...opts,
        folderId: currentFolderId || undefined,
      });
      toast.show("success", "Form created", {
        description: "Opening the designer…",
      });
      setFormBuilderOpen(false);
      router.push(`/templates/${templateId}/designer`);
    } catch (e: any) {
      toast.show("error", "Couldn't build form", {
        description: e.message,
      });
    } finally {
      setCreating(false);
    }
  }

  async function createBlankPdf(opts: Omit<BlankPdfOpts, "folderId">) {
    setCreating(true);
    try {
      const { templateId } = await createBlankPdfTemplate({
        ...opts,
        folderId: currentFolderId || undefined,
      });
      toast.show("success", "Blank PDF created");
      setBlankPdfOpen(false);
      router.push(`/templates/${templateId}/designer`);
    } catch (e: any) {
      toast.show("error", "Couldn't create blank PDF", {
        description: e.message,
      });
    } finally {
      setCreating(false);
    }
  }

  async function createFromStarter(s: Starter) {
    setCreatingStarterId(s.id);
    try {
      const suggestedName =
        s.id === "blank" ? "Untitled template" : `${s.name} — ${new Date().toLocaleDateString()}`;

      // Convert the starter's HTML+Go-template source into the doc AST
      // and seed a doc-mode template.  getStarterDoc uses the browser's
      // native DOMParser here.  Any info-level diagnostics (e.g. a <dl>
      // with embedded control flow that downgraded to a Raw block) are
      // surfaced as a secondary toast so users know something was
      // preserved rather than lost.
      const { stored, diagnostics } = getStarterDoc(s);
      const { templateId } = await createDocTemplate({
        name: suggestedName,
        seedDoc: stored.doc,
        themeCss: stored.themeCss,
        folderId: currentFolderId || undefined,
      });
      toast.show("success", `Created ${s.name}`, {
        description:
          diagnostics.length > 0
            ? `${diagnostics.length} block${diagnostics.length === 1 ? "" : "s"} kept as raw HTML — open the doc to clean up. Opening the editor…`
            : "Opening the editor…",
      });
      setBrowserOpen(false);
      router.push(`/templates/${templateId}/designer-v2`);
    } catch (e: any) {
      toast.show("error", "Couldn't create template", {
        description: e.message,
      });
    } finally {
      setCreatingStarterId(null);
    }
  }

  async function logout() {
    const ok = await confirm({
      title: "Sign out?",
      description: "You'll need to sign in again to continue.",
      confirmLabel: "Sign out",
    });
    if (!ok) return;
    clearSession();
    router.replace("/login");
  }

  // Drag & drop handlers for the whole drop zone.
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragActive(false);
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      const file = e.dataTransfer.files?.[0];
      if (file) upload(file);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentFolderId]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let f = q
      ? folders.filter((x) => x.name.toLowerCase().includes(q))
      : folders.slice();
    let files2 = q
      ? files.filter(
          (x) =>
            x.name.toLowerCase().includes(q) ||
            x.mime.toLowerCase().includes(q)
        )
      : files.slice();

    if (typeFilter !== "all") {
      files2 = files2.filter((x) => {
        if (typeFilter === "templates") return !!x.templateId;
        if (typeFilter === "pdf") return x.mime === "application/pdf";
        if (typeFilter === "html") return x.mime === "text/html";
        if (typeFilter === "markdown")
          return (
            x.mime === "text/markdown" ||
            x.name.toLowerCase().endsWith(".md")
          );
        if (typeFilter === "image") return x.mime.startsWith("image/");
        if (typeFilter === "other") {
          return (
            !x.templateId &&
            x.mime !== "application/pdf" &&
            x.mime !== "text/html" &&
            x.mime !== "text/markdown" &&
            !x.mime.startsWith("image/")
          );
        }
        return true;
      });
      // When filtering by file types, hide folders unless sub-filter allows it.
      f = [];
    }

    const dir = sortDir === "asc" ? 1 : -1;
    const byName = (a: string, b: string) =>
      a.toLowerCase().localeCompare(b.toLowerCase()) * dir;
    const byDate = (a: string, b: string) =>
      (new Date(a).getTime() - new Date(b).getTime()) * dir;

    f.sort((a, b) =>
      sortBy === "name" ? byName(a.name, b.name) : byDate(a.createdAt, b.createdAt)
    );
    files2.sort((a, b) => {
      if (sortBy === "name") return byName(a.name, b.name);
      if (sortBy === "size") return (a.size - b.size) * dir;
      if (sortBy === "type") return byName(a.mime || "", b.mime || "");
      return byDate(a.createdAt, b.createdAt);
    });

    return { folders: f, files: files2 };
  }, [search, folders, files, typeFilter, sortBy, sortDir]);

  const allSelected =
    filtered.files.length > 0 &&
    filtered.files.every((f) => selected.has(f.id));

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    setSelected((prev) => {
      if (allSelected) return new Set();
      const next = new Set(prev);
      filtered.files.forEach((f) => next.add(f.id));
      return next;
    });
  }
  function clearSelection() {
    setSelected(new Set());
  }

  async function bulkTrash() {
    if (selected.size === 0) return;
    const ok = await confirm({
      title: `Move ${selected.size} item${selected.size === 1 ? "" : "s"} to trash?`,
      description: "You can restore them later from the trash view.",
      confirmLabel: "Move to trash",
      destructive: true,
    });
    if (!ok) return;
    try {
      await Promise.all(
        Array.from(selected).map((id) =>
          api(`/v1/files/${id}`, { method: "DELETE" })
        )
      );
      toast.show("success", `${selected.size} item(s) moved to trash`);
      clearSelection();
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  // Streams a server-built ZIP for an arbitrary `{ ids, folderIds }`
  // payload. The previous browser-side approach (loop `window.open`
  // over presigned URLs) was killed by every popup blocker after the
  // first 1–2 files. The server now does the authorization /
  // vault-unlock / AV pre-flight up front, then streams a single
  // `application/zip` response which the client saves via a
  // transient anchor.
  //
  // The `progressLabel` parameter is the user-facing description
  // for the "Preparing…" toast that fires while the server runs its
  // O(N) pre-flight queries. For folders that can balloon into
  // hundreds of descendants this matters — silence feels broken.
  async function downloadZip(
    payload: { ids?: string[]; folderIds?: string[] },
    progressLabel: string,
  ) {
    let res: Response;
    try {
      const token = getToken();
      res = await fetch(`${API_URL}/v1/files/zip`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      });
    } catch (e: any) {
      // Network error before the response started (CORS, DNS, the
      // server died). Distinct from a server-side 4xx/5xx — those
      // surface a structured envelope below.
      toast.show("error", "Couldn't reach the server", {
        description: e?.message,
      });
      return;
    }

    if (!res.ok) {
      // Server rejected the bulk request before streaming. The body
      // is a normal JSON error envelope at this point — every gate
      // (authz, vault, AV) writes its error UPFRONT precisely so
      // we can surface a real message here.
      const body = await res
        .json()
        .catch(() => ({ error: { message: res.statusText } }));
      toast.show(
        "error",
        body?.error?.message ?? "Couldn't prepare download",
      );
      return;
    }

    // Successful 200: the body is the zip bytes. Buffer into a Blob
    // and trigger the save. Using fetch+Blob (not <a href=…>) is
    // necessary because the endpoint is POST, not GET, so we can't
    // express it as a same-origin link click.
    const blob = await res.blob();

    // Pull the filename from Content-Disposition rather than
    // hard-coding it client-side — the server picks the name (folder
    // name for single-folder requests, timestamp otherwise) and is
    // the source of truth.
    const cd = res.headers.get("content-disposition") || "";
    const m = /filename="?([^"]+)"?/i.exec(cd);
    const fname =
      m?.[1] ||
      `docforge-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Hand the blob back to the GC. Keeping the object URL alive
    // pins the entire archive in memory until the page reloads.
    URL.revokeObjectURL(url);

    toast.show("success", `Downloaded ${progressLabel} as ${fname}`);
  }

  // Bulk download → server-streams a multi-file ZIP of every
  // currently-selected file. Single-file case short-circuits to the
  // original presign flow so the user gets the file under its real
  // name instead of unnecessarily wrapped inside a one-entry zip.
  async function bulkDownload() {
    if (selected.size === 0) return;
    if (selected.size === 1) {
      const [only] = Array.from(selected);
      await download(only);
      return;
    }
    const ids = Array.from(selected);
    toast.show("info", `Preparing ${ids.length} files…`, {
      description: "We'll save a ZIP when it's ready.",
    });
    await downloadZip({ ids }, `${ids.length} files`);
  }

  // Single-folder download → server walks the folder + every
  // descendant and streams a `<FolderName>.zip`. The pre-flight is
  // O(N) descendants, so we surface a "Preparing…" toast like
  // bulkDownload — the user only sees a save dialog once the server
  // has finished authorising every file in the tree.
  async function downloadFolder(folder: { id: string; name: string }) {
    toast.show("info", `Preparing "${folder.name}"…`, {
      description: "We'll save a ZIP when it's ready.",
    });
    await downloadZip({ folderIds: [folder.id] }, `"${folder.name}"`);
  }

  async function moveFileToFolder(fileId: string, folderId: string | null) {
    try {
      await api(`/v1/files/${fileId}`, {
        method: "PATCH",
        body: JSON.stringify({ folderId }),
      });
      toast.show("success", "File moved");
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  // Keyboard shortcuts: "/" focuses search, Esc clears selection/details, Del trashes selected.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const isEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (e.target as HTMLElement)?.isContentEditable;
      if (e.key === "/" && !isEditable) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape") {
        if (selected.size > 0) clearSelection();
      } else if ((e.key === "Delete" || e.key === "Backspace") && !isEditable) {
        if (selected.size > 0) {
          e.preventDefault();
          bulkTrash();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  if (!user) return null;

  // "trulyEmpty": the folder itself has nothing — show the onboarding empty state.
  // "noMatches": files/folders exist but current search/filter hides them all — show a filter-aware empty state (keep the toolbar visible).
  const trulyEmpty =
    !loading && files.length === 0 && folders.length === 0;
  const noMatches =
    !loading &&
    !trulyEmpty &&
    filtered.folders.length === 0 &&
    filtered.files.length === 0;
  const filtersActive = !!search || typeFilter !== "all";

  const stats = {
    totalFiles: files.length,
    totalFolders: folders.length,
    templates: files.filter((f) => f.templateId).length,
    storage: files.reduce((s, f) => s + (f.size || 0), 0),
  };

  const initials = (user.email || "U")
    .split("@")[0]
    .split(/[.\-_ ]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p: string) => p[0]?.toUpperCase())
    .join("");

  return (
    <AppShell
      search={{
        value: search,
        onChange: setSearch,
        placeholder: "Search files and folders…",
      }}
    >
      {/* Drag-and-drop upload. Listens at window level so the user
          can drop anywhere inside /drive — the visual overlay only
          appears while a file drag is in progress. We disable it
          while an upload is mid-flight so a second drop can't
          double-fire the conflict dialog. */}
      <UploadDropzone
        disabled={!!uploading}
        label="Drop to upload"
        sublabel={
          breadcrumbs.length > 0
            ? `Uploading to ${breadcrumbs[breadcrumbs.length - 1].name}`
            : "Uploading to My Drive"
        }
        onFiles={(files) => void uploadMany(files)}
        onFolderRejected={() =>
          toast.show("info", "Folder uploads aren't supported yet", {
            description: "Drop individual files, or zip the folder first.",
          })
        }
      />
      <div>
        {/* Breadcrumb */}
        <nav aria-label="Breadcrumb" className="mb-3">
          <ol className="flex flex-wrap items-center gap-0.5 text-xs">
            <li>
              <Link
                href="/drive"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Home className="h-3 w-3" />
                My Drive
              </Link>
            </li>
            {breadcrumbs.map((b) => (
              <li key={b.id} className="flex items-center gap-0.5">
                <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
                <Link
                  href={`/drive?folder=${b.id}`}
                  className="rounded px-1.5 py-0.5 font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
                >
                  {b.name}
                </Link>
              </li>
            ))}
          </ol>
        </nav>

        {/* Hero: title + description + primary actions */}
        <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {currentFolderId && breadcrumbs.length > 0
                ? breadcrumbs[breadcrumbs.length - 1].name
                : "My Drive"}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {currentFolderId
                ? "Files and folders inside this folder."
                : "All your documents, templates, and form submissions in one place."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={load}
                  aria-label="Refresh"
                  className="h-9 w-9"
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh</TooltipContent>
            </Tooltip>
            <Button
              variant="outline"
              size="sm"
              onClick={newFolder}
              className="h-9"
            >
              <FolderPlus className="h-4 w-4" />
              New folder
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
              className="h-9"
            >
              <Upload className="h-4 w-4" />
              Upload
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" loading={creating} className="h-9">
                  <Plus className="h-4 w-4" />
                  Create
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuLabel>New document</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => setBrowserOpen(true)}>
                  <BookTemplate className="h-4 w-4" />
                  Browse templates…
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    Starters
                  </span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-[10px]">
                  Blank
                </DropdownMenuLabel>
                <DropdownMenuItem onClick={createHtml}>
                  <FileCode2 className="h-4 w-4" />
                  HTML template
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    Rich editor
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={createMarkdown}>
                  <Hash className="h-4 w-4" />
                  Markdown template
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    .md → PDF
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setBlankPdfOpen(true)}>
                  <FileType2 className="h-4 w-4" />
                  Blank PDF
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    Static designer
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setFormBuilderOpen(true)}>
                  <ClipboardList className="h-4 w-4" />
                  Form builder
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    Auto-layout
                  </span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => inputRef.current?.click()}>
                  <Upload className="h-4 w-4" />
                  Upload a file…
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setCameraOpen(true)}>
                  <Camera className="h-4 w-4" />
                  Capture image…
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    Camera
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                // Route through uploadMany so the picker behaves the
                // same as the drag-and-drop overlay — sequential
                // uploads, single re-render at the end.
                const list = e.target.files;
                if (list && list.length > 0) {
                  const files: File[] = [];
                  for (let i = 0; i < list.length; i++) files.push(list[i]);
                  void uploadMany(files);
                }
                e.target.value = "";
              }}
            />
          </div>
        </div>

        {/* Mobile search */}
        <div className="relative mb-4 md:hidden">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search files and folders…"
            className="pl-9"
          />
        </div>

        {/* Stats strip */}
        {!loading && (
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              icon={FileType2}
              label="Files"
              value={stats.totalFiles.toLocaleString()}
              tone="primary"
            />
            <StatCard
              icon={FolderIcon}
              label="Folders"
              value={stats.totalFolders.toLocaleString()}
              tone="amber"
            />
            <StatCard
              icon={BookTemplate}
              label="Templates"
              value={stats.templates.toLocaleString()}
              tone="violet"
            />
            <StatCard
              icon={UploadCloud}
              label="Storage"
              value={fmtSize(stats.storage)}
              tone="slate"
            />
          </div>
        )}

        {err && (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <X className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="flex-1">{err}</span>
            <button
              onClick={() => setErr(null)}
              className="rounded p-0.5 hover:bg-destructive/10"
              aria-label="Dismiss error"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Drive toolbar: view toggle, sort, type filter */}
        {!loading && !trulyEmpty && (
          <div className="mb-3 flex flex-col gap-3 rounded-lg border bg-card p-2.5 shadow-subtle md:flex-row md:items-center">
            <div className="flex items-center gap-2">
              <ViewToggle value={viewMode} onChange={setViewMode} />

              <Separator orientation="vertical" className="h-6" />

              <div className="flex items-center gap-1">
                <Select
                  value={sortBy}
                  onValueChange={(v) => setSortBy(v as any)}
                >
                  <SelectTrigger className="h-8 w-[150px] text-xs">
                    <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="modified">Last modified</SelectItem>
                    <SelectItem value="name">Name</SelectItem>
                    <SelectItem value="size">Size</SelectItem>
                    <SelectItem value="type">Type</SelectItem>
                  </SelectContent>
                </Select>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() =>
                        setSortDir((d) => (d === "asc" ? "desc" : "asc"))
                      }
                      aria-label={`Sort ${sortDir === "asc" ? "descending" : "ascending"}`}
                    >
                      {sortDir === "asc" ? (
                        <ArrowUpAZ className="h-4 w-4" />
                      ) : (
                        <ArrowDownAZ className="h-4 w-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {sortDir === "asc" ? "Ascending" : "Descending"}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            <Separator orientation="vertical" className="hidden h-6 md:block" />

            <div className="flex flex-wrap items-center gap-1 overflow-x-auto">
              {(
                [
                  { v: "all", label: "All", count: files.length },
                  {
                    v: "templates",
                    label: "Templates",
                    count: files.filter((f) => f.templateId).length,
                  },
                  {
                    v: "pdf",
                    label: "PDF",
                    count: files.filter(
                      (f) => f.mime === "application/pdf"
                    ).length,
                  },
                  {
                    v: "html",
                    label: "HTML",
                    count: files.filter((f) => f.mime === "text/html").length,
                  },
                  {
                    v: "markdown",
                    label: "Markdown",
                    count: files.filter(
                      (f) =>
                        f.mime === "text/markdown" ||
                        f.name.toLowerCase().endsWith(".md")
                    ).length,
                  },
                  {
                    v: "image",
                    label: "Images",
                    count: files.filter((f) => f.mime.startsWith("image/"))
                      .length,
                  },
                ] as const
              ).map((t) => (
                <button
                  key={t.v}
                  onClick={() => setTypeFilter(t.v)}
                  className={cn(
                    "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] font-medium transition-all",
                    typeFilter === t.v
                      ? "border-primary/30 bg-primary/10 text-primary shadow-subtle"
                      : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  {t.label}
                  {t.count > 0 && (
                    <span
                      className={cn(
                        "rounded-sm px-1 font-mono text-[10px]",
                        typeFilter === t.v
                          ? "bg-primary/20 text-primary"
                          : "bg-muted text-muted-foreground"
                      )}
                    >
                      {t.count}
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="hidden lg:inline">Press</span>
              <kbd className="kbd hidden lg:inline-flex">/</kbd>
              <span className="hidden lg:inline">to search</span>
            </div>
          </div>
        )}

        {/* Bulk action bar */}
        {selected.size > 0 && (
          <div className="mb-3 flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
            <CheckSquare className="h-4 w-4 text-primary" />
            <span className="font-medium">
              {selected.size} selected
            </span>
            <div className="ml-auto flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={bulkDownload}>
                <Download className="h-4 w-4" />
                Download
              </Button>
              {/* Merge into a single PDF — only relevant for 2+ files,
                  and only when at least one is something we can convert
                  (PDF, image, or office doc). The dialog enforces the
                  details; this gate just keeps the button unobtrusive
                  when the selection is e.g. all .zip archives. */}
              {selected.size >= 2 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setMergeOpen(true)}
                  title="Stitch the selected files into a single PDF"
                >
                  <FileType2 className="h-4 w-4" />
                  Merge to PDF
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={bulkTrash}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
                Trash
              </Button>
              <Button variant="ghost" size="sm" onClick={clearSelection}>
                <X className="h-4 w-4" />
                Clear
              </Button>
            </div>
          </div>
        )}

        <div
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={cn(
            "relative overflow-hidden rounded-lg border bg-card transition-colors",
            dragActive && "border-primary ring-2 ring-primary/30"
          )}
        >
          {dragActive && (
            <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-primary/5">
              <div className="flex flex-col items-center gap-2 text-primary">
                <UploadCloud className="h-10 w-10" />
                <span className="text-sm font-medium">
                  Drop the file to upload
                </span>
              </div>
            </div>
          )}

          {loading ? (
            <div className="divide-y">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-4 py-3">
                  <Skeleton className="h-8 w-8 rounded-md" />
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="ml-auto h-4 w-20" />
                  <Skeleton className="h-4 w-24" />
                </div>
              ))}
            </div>
          ) : trulyEmpty ? (
            <div className="surface-gradient grid place-items-center px-6 py-16">
              <div className="flex max-w-md flex-col items-center text-center">
                <div className="relative mb-5">
                  <div className="absolute inset-0 -z-10 rounded-full bg-primary/10 blur-2xl" />
                  <div className="grid h-20 w-20 place-items-center rounded-2xl border bg-card shadow-card">
                    <FolderOpen className="h-8 w-8 text-primary" />
                  </div>
                </div>
                <h3 className="text-lg font-semibold tracking-tight">
                  {currentFolderId
                    ? "This folder is empty"
                    : "Start your first document"}
                </h3>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  Upload an existing PDF or HTML, start from a template, or
                  build one from scratch — all in one place.
                </p>
                <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                  <Button size="sm" onClick={() => setBrowserOpen(true)}>
                    <BookTemplate className="h-4 w-4" />
                    Browse templates
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => inputRef.current?.click()}
                  >
                    <Upload className="h-4 w-4" />
                    Upload file
                  </Button>
                  <Button variant="outline" size="sm" onClick={newFolder}>
                    <FolderPlus className="h-4 w-4" />
                    New folder
                  </Button>
                </div>
              </div>
            </div>
          ) : noMatches ? (
            <div className="grid place-items-center px-6 py-14">
              <div className="flex max-w-md flex-col items-center text-center">
                <div className="mb-4 grid h-14 w-14 place-items-center rounded-xl border bg-muted/40">
                  <Search className="h-6 w-6 text-muted-foreground" />
                </div>
                <h3 className="text-base font-semibold tracking-tight">
                  No results found
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {search && typeFilter !== "all" ? (
                    <>
                      No <span className="font-medium">{typeFilter}</span>{" "}
                      items match &quot;{search}&quot;.
                    </>
                  ) : search ? (
                    <>
                      Nothing matches &quot;
                      <span className="font-medium">{search}</span>&quot;.
                    </>
                  ) : (
                    <>
                      You don&apos;t have any{" "}
                      <span className="font-medium">{typeFilter}</span> items
                      yet.
                    </>
                  )}
                </p>
                {filtersActive && (
                  <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                    {search && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSearch("")}
                      >
                        <X className="h-4 w-4" />
                        Clear search
                      </Button>
                    )}
                    {typeFilter !== "all" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setTypeFilter("all")}
                      >
                        <X className="h-4 w-4" />
                        Show all types
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : viewMode === "list" ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th scope="col" className="w-10 px-3 py-2">
                    <button
                      onClick={toggleSelectAll}
                      aria-label={allSelected ? "Deselect all" : "Select all"}
                      className="grid h-4 w-4 place-items-center rounded border bg-background transition-colors hover:border-primary/50"
                    >
                      {allSelected ? (
                        <Check className="h-3 w-3 text-primary" />
                      ) : null}
                    </button>
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Name
                  </th>
                  <th scope="col" className="hidden px-3 py-2 md:table-cell">
                    Type
                  </th>
                  <th scope="col" className="hidden px-3 py-2 md:table-cell">
                    Size
                  </th>
                  <th scope="col" className="hidden px-3 py-2 lg:table-cell">
                    Modified
                  </th>
                  <th scope="col" className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.folders.map((f) => (
                  <tr
                    key={f.id}
                    onDragOver={(e) => {
                      if (e.dataTransfer.types.includes("application/x-formly-file")) {
                        e.preventDefault();
                        setDropTargetFolder(f.id);
                      }
                    }}
                    onDragLeave={() => setDropTargetFolder(null)}
                    onDrop={(e) => {
                      const fileId = e.dataTransfer.getData(
                        "application/x-formly-file"
                      );
                      setDropTargetFolder(null);
                      if (fileId) {
                        e.preventDefault();
                        e.stopPropagation();
                        moveFileToFolder(fileId, f.id);
                      }
                    }}
                    className={cn(
                      "group border-b last:border-0 transition-colors hover:bg-muted/40",
                      dropTargetFolder === f.id &&
                        "bg-primary/5 ring-1 ring-primary/30"
                    )}
                  >
                    <td className="px-3 py-2"></td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/drive?folder=${f.id}`}
                        className="inline-flex items-center gap-2.5"
                      >
                        <span className="grid h-7 w-7 place-items-center rounded-md bg-amber-500/10 text-amber-500 transition-transform group-hover:scale-110 dark:bg-amber-500/15">
                          <FolderIcon className="h-4 w-4" />
                        </span>
                        <span className="font-medium text-foreground group-hover:text-primary">
                          {f.name}
                        </span>
                        {f.locked && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                            title="Locked folder — re-auth required"
                          >
                            <Lock className="h-3 w-3" />
                            Locked
                          </span>
                        )}
                      </Link>
                    </td>
                    <td className="hidden px-3 py-2 text-xs text-muted-foreground md:table-cell">
                      Folder
                    </td>
                    <td className="hidden px-3 py-2 text-xs text-muted-foreground md:table-cell">
                      —
                    </td>
                    <td className="hidden px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                      {new Date(f.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Actions for ${f.name}`}
                            className="h-7 w-7 opacity-0 group-hover:opacity-100"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem onClick={() => renameFolder(f)}>
                            <PencilLine className="h-4 w-4" />
                            Rename
                          </DropdownMenuItem>
                          {/* Server walks the folder tree and streams
                              a ZIP — replaces the previous
                              "select-each-file-then-bulk" workaround
                              for "I just want this folder." */}
                          <DropdownMenuItem
                            onClick={() => downloadFolder(f)}
                          >
                            <Download className="h-4 w-4" />
                            Download as ZIP
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              setSharePeopleFor({
                                id: f.id,
                                name: f.name,
                                type: "folder",
                              })
                            }
                          >
                            <Users className="h-4 w-4" />
                            Share with people
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => toggleFolderLock(f)}>
                            {f.locked ? (
                              <>
                                <LockOpen className="h-4 w-4" />
                                Remove lock
                              </>
                            ) : (
                              <>
                                <Lock className="h-4 w-4" />
                                Lock folder
                              </>
                            )}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => deleteFolder(f)}
                            destructive
                          >
                            <Trash2 className="h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
                {filtered.files.map((file) => {
                  const Icon = iconForMime(file.mime);
                  const isSelected = selected.has(file.id);
                  return (
                    <tr
                      key={file.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(
                          "application/x-formly-file",
                          file.id
                        );
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onClick={async (e) => {
                        if ((e.target as HTMLElement).closest("button,a")) return;
                        // DOCX / RTF / ODT / TXT always route to the
                        // ONLYOFFICE document editor on click. The
                        // document editor edits the source bytes, which
                        // is what users intuitively expect from a
                        // double-click on a .docx or .txt. The form/
                        // static designer is still available via the
                        // row menu for files that have a templateId or
                        // a ready PDF preview attached.
                        if (canOpenInOnlyOffice(file)) {
                          openInOnlyOffice(file, (href) => router.push(href));
                          return;
                        }
                        // Source code / config / plain-text route to
                        // the in-app CodeMirror editor. Sits between
                        // ONLYOFFICE (which owns docx/xlsx/pptx) and
                        // the designer (which owns pdf/image/html/md).
                        if (canOpenInCodeEditor(file)) {
                          openInCodeEditor(file, (href) => router.push(href));
                          return;
                        }
                        // PDF / image / markdown / html / native templates
                        // route to the form/static designer.
                        if (canOpenInDesigner(file)) {
                          await openInDesigner(file);
                          return;
                        }
                        if (file.mime === "application/pdf") {
                          setPreviewFor(file);
                          return;
                        }
                        // Audio / video → in-app player. Routed before
                        // the download fallback so a click on a video
                        // row plays it inline instead of forcing the
                        // user to save-then-open. PDF wins above
                        // because it has dedicated AcroForm overlays
                        // we don't want to skip.
                        if (mediaKindFor(file.mime)) {
                          setMediaPreviewFor(file);
                          return;
                        }
                        download(file.id);
                      }}
                      className={cn(
                        "group cursor-pointer border-b last:border-0 transition-colors hover:bg-muted/40",
                        isSelected && "bg-primary/5"
                      )}
                    >
                      <td className="px-3 py-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSelect(file.id);
                          }}
                          aria-label={isSelected ? "Deselect" : "Select"}
                          className={cn(
                            "grid h-4 w-4 place-items-center rounded border bg-background transition-colors",
                            isSelected
                              ? "border-primary"
                              : "opacity-0 hover:border-primary/50 group-hover:opacity-100"
                          )}
                        >
                          {isSelected ? (
                            <Check className="h-3 w-3 text-primary" />
                          ) : null}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2.5">
                          <span
                            className={cn(
                              "grid h-7 w-7 shrink-0 place-items-center rounded-md transition-transform group-hover:scale-110",
                              file.mime === "application/pdf" &&
                                "bg-red-500/10 text-red-500 dark:bg-red-500/15",
                              file.mime === "text/html" &&
                                "bg-orange-500/10 text-orange-500 dark:bg-orange-500/15",
                              (file.mime === "text/markdown" ||
                                file.name.toLowerCase().endsWith(".md")) &&
                                "bg-sky-500/10 text-sky-500 dark:bg-sky-500/15",
                              file.mime.startsWith("image/") &&
                                "bg-violet-500/10 text-violet-500 dark:bg-violet-500/15",
                              !(
                                file.mime === "application/pdf" ||
                                file.mime === "text/html" ||
                                file.mime === "text/markdown" ||
                                file.name.toLowerCase().endsWith(".md") ||
                                file.mime.startsWith("image/")
                              ) && "bg-muted text-muted-foreground"
                            )}
                          >
                            <Icon className="h-4 w-4" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate font-medium">
                                {file.name}
                              </span>
                              {file.templateId && (
                                <Badge
                                  variant="secondary"
                                  className="text-[9px]"
                                >
                                  Template
                                </Badge>
                              )}
                            </div>
                            <div className="mt-0.5 text-[10px] text-muted-foreground md:hidden">
                              {prettyMime(file.mime)} · {fmtSize(file.size)}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="hidden px-3 py-2 text-xs text-muted-foreground md:table-cell">
                        {prettyMime(file.mime)}
                      </td>
                      <td className="hidden px-3 py-2 font-mono text-xs text-muted-foreground md:table-cell">
                        {fmtSize(file.size)}
                      </td>
                      <td className="hidden px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                        {new Date(file.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-2 py-2 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Actions for ${file.name}`}
                              className="h-7 w-7 opacity-0 group-hover:opacity-100"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            {/* Office files (DOCX/RTF/ODT/TXT) get the
                                document editor only. Any templateId on
                                these is leftover from earlier auto-
                                detect runs (e.g. .txt → markdown) and
                                surfacing a "Open designer" entry on top
                                of it just confuses the user. The form/
                                static designer is the right tool for
                                derived PDFs, not for the source bytes
                                of a Word doc. */}
                            {canOpenInOnlyOffice(file) ? (
                              <DropdownMenuItem
                                onClick={() =>
                                  openInOnlyOffice(file, (href) =>
                                    router.push(href)
                                  )
                                }
                              >
                                <PencilLine className="h-4 w-4" />
                                Open in document editor
                              </DropdownMenuItem>
                            ) : canOpenInCodeEditor(file) ? (
                              <DropdownMenuItem
                                onClick={() =>
                                  openInCodeEditor(file, (href) =>
                                    router.push(href)
                                  )
                                }
                              >
                                <PencilLine className="h-4 w-4" />
                                Open in code editor
                              </DropdownMenuItem>
                            ) : file.templateId ? (
                              <DropdownMenuItem asChild>
                                <Link
                                  href={`/templates/${file.templateId}/designer`}
                                >
                                  <PencilLine className="h-4 w-4" />
                                  Open designer
                                </Link>
                              </DropdownMenuItem>
                            ) : canOpenInDesigner(file) ? (
                              <DropdownMenuItem onClick={() => openInDesigner(file)}>
                                <PencilLine className="h-4 w-4" />
                                Open designer
                              </DropdownMenuItem>
                            ) : null}
                            {!file.templateId &&
                              file.mime === "application/pdf" && (
                                <DropdownMenuItem
                                  onClick={() => setPreviewFor(file)}
                                >
                                  <Eye className="h-4 w-4" />
                                  Preview
                                </DropdownMenuItem>
                              )}
                            {/* Audio / video preview — same Eye icon
                                as the PDF preview entry so the action
                                affordance stays consistent across
                                file types. */}
                            {mediaKindFor(file.mime) && (
                              <DropdownMenuItem
                                onClick={() => setMediaPreviewFor(file)}
                              >
                                <Eye className="h-4 w-4" />
                                {mediaKindFor(file.mime) === "video"
                                  ? "Play video"
                                  : "Play audio"}
                              </DropdownMenuItem>
                            )}
                            {/* Insert pages from another file into this
                                PDF in place. Only meaningful for native
                                PDFs (the splice happens against an
                                existing PDF; non-PDF rows would need to
                                be exported first via a separate flow). */}
                            {!file.templateId &&
                              file.mime === "application/pdf" && (
                                <DropdownMenuItem
                                  onClick={() =>
                                    setInsertFor({
                                      id: file.id,
                                      name: file.name,
                                    })
                                  }
                                >
                                  <FileType2 className="h-4 w-4" />
                                  Insert pages…
                                </DropdownMenuItem>
                              )}
                            <DropdownMenuItem
                              onClick={() => download(file.id)}
                            >
                              <Download className="h-4 w-4" />
                              Download
                            </DropdownMenuItem>
                            {canExportPDF(file) && (
                              <DropdownMenuItem
                                onClick={async () => {
                                  try {
                                    await requestPDFExport(file.id);
                                    toast.show(
                                      "success",
                                      "Exporting to PDF",
                                      {
                                        description:
                                          "We'll add the PDF as a sibling file when it's ready.",
                                      }
                                    );
                                    setFiles((xs) =>
                                      xs.map((x) =>
                                        x.id === file.id
                                          ? { ...x, convertStatus: "pending" }
                                          : x
                                      )
                                    );
                                  } catch (e: any) {
                                    toast.show("error", e.message);
                                  }
                                }}
                                disabled={file.convertStatus === "pending"}
                              >
                                <Download className="h-4 w-4" />
                                {file.convertStatus === "pending"
                                  ? "Exporting…"
                                  : "Export as PDF"}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              onClick={() =>
                                setSharePeopleFor({
                                  id: file.id,
                                  name: file.name,
                                  type: "file",
                                })
                              }
                            >
                              <Users className="h-4 w-4" />
                              Share with people
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setShareFor(file)}
                            >
                              <Share2 className="h-4 w-4" />
                              Get link…
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => moveFile(file)}
                            >
                              <Move className="h-4 w-4" />
                              Move…
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => toggleStar(file)}
                            >
                              <Star
                                className={cn(
                                  "h-4 w-4",
                                  file.starred &&
                                    "fill-amber-400 text-amber-500"
                                )}
                              />
                              {file.starred ? "Unstar" : "Star"}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => remove(file)}
                              destructive
                            >
                              <Trash2 className="h-4 w-4" />
                              Move to trash
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="space-y-6 p-4">
              {filtered.folders.length > 0 && (
                <section>
                  <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Folders
                  </h3>
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {filtered.folders.map((f) => (
                      <FolderGridCard
                        key={f.id}
                        folder={f}
                        isDropTarget={dropTargetFolder === f.id}
                        onDragEnter={() => setDropTargetFolder(f.id)}
                        onDragLeave={() => setDropTargetFolder(null)}
                        onDrop={(fileId) => moveFileToFolder(fileId, f.id)}
                        onRename={() => renameFolder(f)}
                        onDelete={() => deleteFolder(f)}
                        onShare={() =>
                          setSharePeopleFor({
                            id: f.id,
                            name: f.name,
                            type: "folder",
                          })
                        }
                        onToggleLock={() => toggleFolderLock(f)}
                        onDownload={() => downloadFolder(f)}
                      />
                    ))}
                  </div>
                </section>
              )}

              {filtered.files.length > 0 && (
                <section>
                  <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Files
                  </h3>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {filtered.files.map((file) => (
                      <FileGridCard
                        key={file.id}
                        file={file}
                        actorInitials={initials}
                        selected={selected.has(file.id)}
                        bulkSelectActive={selected.size > 0}
                        onToggleSelect={() => toggleSelect(file.id)}
                        onToggleStar={() => toggleStar(file)}
                        // Clicking a template card opens the designer;
                        // clicking a regular file card used to trigger a
                        // silent download, which was surprising and
                        // hard to undo. Regular files are now inert on
                        // single-click — use the Download menu option
                        // (or double-click) to explicitly fetch. This
                        // keeps primary actions discoverable and stops
                        // the "menu click also downloaded the file"
                        // confusion.
                        onOpenDetails={
                          // Office files always route to the document
                          // editor on card click. Designer access for
                          // templated files lives in the menuItems list
                          // below so it stays one click away without
                          // hijacking the primary open action.
                          canOpenInOnlyOffice(file)
                            ? () => openInOnlyOffice(file, (href) => router.push(href))
                            : canOpenInCodeEditor(file)
                            ? () => openInCodeEditor(file, (href) => router.push(href))
                            : file.templateId
                            ? () => router.push(`/templates/${file.templateId}/designer`)
                            : file.mime === "application/pdf"
                              ? () => setPreviewFor(file)
                              : mediaKindFor(file.mime)
                                ? () => setMediaPreviewFor(file)
                                : file.mime.startsWith("image/") && !file.mime.includes("svg")
                                ? async () => {
                                    // Backfill the image template on demand — same
                                    // path as the list-view click. Keeps parity
                                    // between the two presentation modes so users
                                    // see consistent behaviour from both.
                                    try {
                                      const { templateId } = await api<{ templateId: string }>(
                                        `/v1/files/${file.id}/ensure-template`,
                                        { method: "POST" }
                                      );
                                      if (templateId) router.push(`/templates/${templateId}/designer`);
                                    } catch (err: any) {
                                      toast.show("error", err.message);
                                    }
                                  }
                                : undefined
                        }
                        onDownload={() => download(file.id)}
                        menuItems={[
                          canOpenInOnlyOffice(file) ? {
                            label: "Open in document editor",
                            icon: <PencilLine className="h-4 w-4" />,
                            onClick: () => openInOnlyOffice(file, (href) => router.push(href)),
                          } : null,
                          !canOpenInOnlyOffice(file) && canOpenInCodeEditor(file) ? {
                            label: "Open in code editor",
                            icon: <PencilLine className="h-4 w-4" />,
                            onClick: () => openInCodeEditor(file, (href) => router.push(href)),
                          } : null,
                          !canOpenInOnlyOffice(file) && !canOpenInCodeEditor(file) && file.templateId ? {
                            label: "Open designer",
                            icon: <PencilLine className="h-4 w-4" />,
                            href: `/templates/${file.templateId}/designer`,
                          } : !canOpenInOnlyOffice(file) && !canOpenInCodeEditor(file) && canOpenInDesigner(file)
                            ? {
                                label: "Open designer",
                                icon: <PencilLine className="h-4 w-4" />,
                                onClick: () => openInDesigner(file),
                              }
                            : null,
                          !file.templateId && file.mime === "application/pdf" ? {
                            label: "Preview",
                            icon: <Eye className="h-4 w-4" />,
                            onClick: () => setPreviewFor(file),
                          } : null,
                          // Audio / video preview menu entry. Verb
                          // changes ("Play video" / "Play audio")
                          // because "Preview" feels static for media
                          // — the user expects a play action, not a
                          // still frame.
                          mediaKindFor(file.mime) ? {
                            label: mediaKindFor(file.mime) === "video" ? "Play video" : "Play audio",
                            icon: <Eye className="h-4 w-4" />,
                            onClick: () => setMediaPreviewFor(file),
                          } : null,
                          { label: "Download", icon: <Download className="h-4 w-4" />, onClick: () => download(file.id) },
                          canExportPDF(file) ? {
                            label: file.convertStatus === "pending" ? "Exporting…" : "Export as PDF",
                            icon: <Download className="h-4 w-4" />,
                            onClick: async () => {
                              try {
                                await requestPDFExport(file.id);
                                toast.show("success", "Exporting to PDF", {
                                  description: "We'll add the PDF as a sibling file when it's ready.",
                                });
                                setFiles((xs) =>
                                  xs.map((x) =>
                                    x.id === file.id ? { ...x, convertStatus: "pending" } : x
                                  )
                                );
                              } catch (e: any) {
                                toast.show("error", e.message);
                              }
                            },
                          } : null,
                          { label: "Share with people", icon: <Users className="h-4 w-4" />, onClick: () => setSharePeopleFor({ id: file.id, name: file.name, type: "file" }) },
                          { label: "Get link…", icon: <Share2 className="h-4 w-4" />, onClick: () => setShareFor(file) },
                          { label: "Move…", icon: <Move className="h-4 w-4" />, onClick: () => moveFile(file) },
                          {
                            label: file.starred ? "Unstar" : "Star",
                            icon: (
                              <Star
                                className={cn(
                                  "h-4 w-4",
                                  file.starred && "fill-amber-400 text-amber-500"
                                )}
                              />
                            ),
                            onClick: () => toggleStar(file),
                          },
                          { label: "Move to trash", icon: <Trash2 className="h-4 w-4" />, onClick: () => remove(file), destructive: true, separatorBefore: true },
                        ].filter(Boolean) as GridCardMenuItem[]}
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </div>

      {uploading && (
        <div className="fixed bottom-4 right-4 z-[60] w-80 animate-fade-in-up">
          <Card className="shadow-xl">
            <CardContent className="flex items-start gap-3 p-4">
              <span className="mt-0.5 grid h-9 w-9 place-items-center rounded-md bg-primary/10 text-primary">
                <UploadCloud className="h-4 w-4" />
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {uploading.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {uploading.pct}%
                  </span>
                </div>
                <Progress value={uploading.pct} className="mt-2" />
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <UploadConflictDialog
        conflict={conflict}
        onResolve={(choice) => {
          conflict?.resolve(choice);
          setConflict(null);
        }}
      />

      {shareFor && (
        <ShareModal
          fileId={shareFor.id}
          fileName={shareFor.name}
          open={!!shareFor}
          onOpenChange={(o) => !o && setShareFor(null)}
        />
      )}

      {sharePeopleFor && (
        <SharePeopleModal
          resourceId={sharePeopleFor.id}
          resourceType={sharePeopleFor.type}
          resourceName={sharePeopleFor.name}
          open={!!sharePeopleFor}
          onOpenChange={(o) => !o && setSharePeopleFor(null)}
        />
      )}

      {previewFor && (
        <FilePreviewDialog
          fileId={previewFor.id}
          fileName={previewFor.name}
          open={!!previewFor}
          onOpenChange={(o) => !o && setPreviewFor(null)}
          onShare={() => {
            setShareFor(previewFor);
            setPreviewFor(null);
          }}
        />
      )}

      {/* Audio / video preview. Mounted alongside the PDF preview
          dialog (rather than dispatching from a single state) so the
          two dialogs stay independent — closing the media preview
          shouldn't ever knock out a PDF preview that happened to be
          open behind it, and vice versa. */}
      {mediaPreviewFor && mediaKindFor(mediaPreviewFor.mime) && (
        <MediaPreviewDialog
          fileId={mediaPreviewFor.id}
          fileName={mediaPreviewFor.name}
          kind={mediaKindFor(mediaPreviewFor.mime)!}
          open={!!mediaPreviewFor}
          onOpenChange={(o) => !o && setMediaPreviewFor(null)}
          onShare={() => {
            setShareFor(mediaPreviewFor);
            setMediaPreviewFor(null);
          }}
        />
      )}

      {/* Multi-file → single-PDF stitch. We feed the dialog the
          currently-selected files so the user sees the same set they
          ticked in the toolbar. Drop into the active folder so the
          merged PDF lands next to its inputs. */}
      {mergeOpen && (
        <MergeFilesDialog
          open={mergeOpen}
          onOpenChange={setMergeOpen}
          files={files
            .filter((f) => selected.has(f.id))
            .map((f) => ({
              id: f.id,
              name: f.name,
              mime: f.mime,
              size: f.size,
            }))}
          defaultFolderId={currentFolderId || null}
          onMerged={async (id) => {
            // Refresh so the new file appears, then clear the
            // selection — it's no longer relevant.
            await load();
            clearSelection();
            void id;
          }}
        />
      )}

      {/* Single-PDF page splice. Target row's id/name comes from the
          row-action callback; the dialog handles source picker + page
          range + splice point internally. */}
      {insertFor && (
        <InsertPagesDialog
          open={!!insertFor}
          onOpenChange={(o) => !o && setInsertFor(null)}
          targetId={insertFor.id}
          targetName={insertFor.name}
          onInserted={() => {
            void load();
          }}
        />
      )}

      <StarterBrowser
        open={browserOpen}
        onOpenChange={setBrowserOpen}
        onSelect={createFromStarter}
        creatingId={creatingStarterId}
      />

      <BlankPdfDialog
        open={blankPdfOpen}
        onOpenChange={setBlankPdfOpen}
        onCreate={createBlankPdf}
        busy={creating}
      />

      <FormBuilderDialog
        open={formBuilderOpen}
        onOpenChange={setFormBuilderOpen}
        onCreate={buildForm}
        busy={creating}
      />

      <CameraCaptureDialog
        open={cameraOpen}
        onOpenChange={setCameraOpen}
        onCapture={(file) => {
          // Reuse the same upload pipeline as drag-and-drop / picker:
          // conflict prompt, presign, complete, toast — everything is
          // already there. The capture File is built with a unique
          // timestamped name so collisions are unlikely, but the
          // existing flow will still ask the user if one happens.
          void upload(file);
        }}
      />
    </AppShell>
  );
}


function StatCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone: "primary" | "amber" | "violet" | "slate";
}) {
  const toneMap = {
    primary:
      "bg-primary/10 text-primary dark:bg-primary/15",
    amber:
      "bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400",
    violet:
      "bg-violet-500/10 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400",
    slate:
      "bg-slate-500/10 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300",
  };
  return (
    <div className="group relative overflow-hidden rounded-lg border bg-card p-3 shadow-subtle transition-shadow hover:shadow-card">
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "grid h-9 w-9 place-items-center rounded-md",
            toneMap[tone]
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </div>
          <div className="text-lg font-semibold tracking-tight">{value}</div>
        </div>
      </div>
    </div>
  );
}

function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * Classify a MIME for the in-app media preview. Returns the kind the
 * `MediaPreviewDialog` expects, or null when the file isn't audio /
 * video. Kept local (rather than added to lib/file-icons) because
 * the dialog's `kind` prop is the only consumer — moving it to a
 * shared module would just create a second source of truth for the
 * same two-line check.
 */
function mediaKindFor(mime: string): "audio" | "video" | null {
  if (!mime) return null;
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return null;
}

function prettyMime(mime: string) {
  if (!mime) return "File";
  if (mime === "application/pdf") return "PDF";
  if (mime.startsWith("image/")) return "Image";
  if (mime === "text/html") return "HTML";
  if (mime === "text/csv") return "CSV";
  return mime.split("/")[1]?.toUpperCase() || mime;
}
