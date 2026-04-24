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
  Copy,
  Download,
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
  Info,
  KeyRound,
  LayoutList,
  Link2,
  MoreHorizontal,
  Move,
  PencilLine,
  Plus,
  RefreshCw,
  Search,
  Share2,
  SlidersHorizontal,
  Trash2,
  Upload,
  UploadCloud,
  X,
} from "lucide-react";
import { api, clearSession, getToken, getUser } from "@/lib/api";
import { useToast } from "@/components/toast";
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
import { createMarkdownTemplate } from "@/lib/create-markdown";
import { createBlankPdfTemplate, type BlankPdfOpts } from "@/lib/create-pdf";
import { AppShell } from "@/components/app-shell";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { StarterBrowser } from "@/components/starter-browser";
import { BlankPdfDialog } from "@/components/blank-pdf-dialog";
import { FormBuilderDialog } from "@/components/form-builder-dialog";
import {
  createFormTemplate,
  type CreateFormOpts,
} from "@/lib/create-form";
import type { Starter } from "@/lib/starters";
import { iconForMime, colorForMime } from "@/lib/file-icons";
import { FileGridCard } from "@/components/file-grid-card";
import { FolderGridCard } from "@/components/folder-grid-card";
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
};

type Folder = {
  id: string;
  parentId: string | null;
  name: string;
  createdAt: string;
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
  const [err, setErr] = useState<string | null>(null);
  const [shareFor, setShareFor] = useState<FileItem | null>(null);
  const [search, setSearch] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [creatingStarterId, setCreatingStarterId] = useState<string | null>(null);
  const [blankPdfOpen, setBlankPdfOpen] = useState(false);
  const [formBuilderOpen, setFormBuilderOpen] = useState(false);

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
  const [detailsFor, setDetailsFor] = useState<FileItem | null>(null);
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

  async function upload(file: File) {
    setErr(null);
    setUploading({ name: file.name, pct: 0 });
    try {
      const { fileId, uploadUrl } = await api<{
        fileId: string;
        uploadUrl: string;
      }>("/v1/files/upload-url", {
        method: "POST",
        body: JSON.stringify({ name: file.name, mime: file.type }),
      });
      await putWithProgress(uploadUrl, file, (pct) =>
        setUploading({ name: file.name, pct })
      );
      const complete = await api<{ templateId?: string }>(
        `/v1/files/${fileId}/complete`,
        { method: "POST" }
      );
      if (currentFolderId) {
        await api(`/v1/files/${fileId}`, {
          method: "PATCH",
          body: JSON.stringify({ folderId: currentFolderId }),
        });
      }
      setUploading(null);
      await load();
      if (complete.templateId) {
        toast.show("success", "AcroForm detected", {
          description: "Opening the designer…",
        });
        router.push(`/templates/${complete.templateId}/designer`);
      } else {
        toast.show("success", `Uploaded ${file.name}`);
      }
    } catch (e: any) {
      setErr(e.message);
      setUploading(null);
      toast.show("error", "Upload failed", { description: e.message });
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
      const { templateId } = await createHtmlTemplate({
        name: suggestedName,
        content: s.html,
        folderId: currentFolderId || undefined,
      });
      toast.show("success", `Created ${s.name}`, {
        description: "Opening the editor…",
      });
      setBrowserOpen(false);
      router.push(`/templates/${templateId}/designer`);
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

  async function bulkDownload() {
    for (const id of Array.from(selected)) {
      try {
        const { downloadUrl } = await api<{ downloadUrl: string }>(
          `/v1/files/${id}/download`
        );
        window.open(downloadUrl, "_blank");
      } catch (e: any) {
        toast.show("error", e.message);
      }
    }
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
        if (detailsFor) setDetailsFor(null);
        else if (selected.size > 0) clearSelection();
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
  }, [selected, detailsFor]);

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
              </DropdownMenuContent>
            </DropdownMenu>
            <input
              ref={inputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload(f);
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
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest("button,a")) return;
                        setDetailsFor(file);
                      }}
                      className={cn(
                        "group cursor-pointer border-b last:border-0 transition-colors hover:bg-muted/40",
                        isSelected && "bg-primary/5",
                        detailsFor?.id === file.id && "bg-primary/5"
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
                            {file.templateId && (
                              <DropdownMenuItem asChild>
                                <Link
                                  href={`/templates/${file.templateId}/designer`}
                                >
                                  <PencilLine className="h-4 w-4" />
                                  Open designer
                                </Link>
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              onClick={() => setDetailsFor(file)}
                            >
                              <Info className="h-4 w-4" />
                              View details
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => download(file.id)}
                            >
                              <Download className="h-4 w-4" />
                              Download
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setShareFor(file)}
                            >
                              <Share2 className="h-4 w-4" />
                              Share
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => moveFile(file)}
                            >
                              <Move className="h-4 w-4" />
                              Move…
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
                        highlighted={detailsFor?.id === file.id}
                        onToggleSelect={() => toggleSelect(file.id)}
                        onOpenDetails={() => setDetailsFor(file)}
                        onDownload={() => download(file.id)}
                        onShare={() => setShareFor(file)}
                        onMove={() => moveFile(file)}
                        onRemove={() => remove(file)}
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

      {shareFor && (
        <ShareModal
          file={shareFor}
          open={!!shareFor}
          onOpenChange={(o) => !o && setShareFor(null)}
        />
      )}

      <DetailsPanel
        file={detailsFor}
        open={!!detailsFor}
        onOpenChange={(o) => !o && setDetailsFor(null)}
        onOpenShare={() => {
          if (detailsFor) setShareFor(detailsFor);
        }}
        onDownload={() => detailsFor && download(detailsFor.id)}
        onMove={() => detailsFor && moveFile(detailsFor)}
        onRemove={() => {
          if (detailsFor) {
            remove(detailsFor);
            setDetailsFor(null);
          }
        }}
      />

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
    </AppShell>
  );
}

function ShareModal({
  file,
  open,
  onOpenChange,
}: {
  file: FileItem;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [shares, setShares] = useState<Share[]>([]);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState("viewer");
  const [expiry, setExpiry] = useState("0");
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [oneTime, setOneTime] = useState(false);
  const [downloadLimit, setDownloadLimit] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const r = await api<{ shares: Share[] }>(
          `/v1/files/${file.id}/shares`
        );
        setShares(r.shares);
      } finally {
        setLoading(false);
      }
    })();
  }, [file.id]);

  async function create() {
    setCreating(true);
    try {
      const r = await api<Share>(`/v1/files/${file.id}/share`, {
        method: "POST",
        body: JSON.stringify({
          role,
          expiresIn: parseInt(expiry, 10),
          password: password || undefined,
          oneTime,
          downloadLimit: downloadLimit ? parseInt(downloadLimit, 10) : 0,
        }),
      });
      setShares([r, ...shares]);
      setPassword("");
      setOneTime(false);
      setDownloadLimit("");
      toast.show("success", "Share link created");
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    const ok = await confirm({
      title: "Revoke share link?",
      description: "Anyone with this link will no longer be able to access the file.",
      confirmLabel: "Revoke",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/shares/${id}`, { method: "DELETE" });
      setShares(shares.filter((s) => s.id !== id));
      toast.show("success", "Link revoked");
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function copyLink(s: Share) {
    const url = `${window.location.origin}/share/${s.token}`;
    await navigator.clipboard.writeText(url);
    setCopiedId(s.id);
    toast.show("success", "Link copied");
    setTimeout(() => setCopiedId((c) => (c === s.id ? null : c)), 2000);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-primary" />
            Share &quot;{file.name}&quot;
          </DialogTitle>
          <DialogDescription>
            Create a public link with access and expiry controls.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="share-role">Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id="share-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">Viewer</SelectItem>
                  <SelectItem value="downloader">Downloader</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="share-expiry">Expires</Label>
              <Select value={expiry} onValueChange={setExpiry}>
                <SelectTrigger id="share-expiry">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Never</SelectItem>
                  <SelectItem value="3600">1 hour</SelectItem>
                  <SelectItem value="86400">1 day</SelectItem>
                  <SelectItem value="604800">7 days</SelectItem>
                  <SelectItem value="2592000">30 days</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={create} loading={creating}>
              <Link2 className="h-4 w-4" />
              Create link
            </Button>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((s) => !s)}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {showAdvanced ? "Hide" : "Show"} advanced options
            </button>
            {showAdvanced && (
              <div className="mt-2 space-y-3 rounded-md border bg-muted/20 p-3">
                <div className="space-y-1.5">
                  <Label htmlFor="share-password">
                    Password (optional)
                  </Label>
                  <Input
                    id="share-password"
                    type="text"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Recipients will be prompted for this"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="share-dl-limit">
                    Download limit (optional)
                  </Label>
                  <Input
                    id="share-dl-limit"
                    type="number"
                    min={0}
                    value={downloadLimit}
                    onChange={(e) => setDownloadLimit(e.target.value)}
                    placeholder="e.g. 3 — leave empty for unlimited"
                  />
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={oneTime}
                    onChange={(e) => setOneTime(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border accent-primary"
                  />
                  <span>
                    <span className="font-medium">One-time link</span>
                    <span className="block text-xs text-muted-foreground">
                      Expires immediately after the first download.
                    </span>
                  </span>
                </label>
              </div>
            )}
          </div>

          <Separator />

          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Active links
            </div>
            {loading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : shares.length === 0 ? (
              <p className="rounded-md border border-dashed bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
                No share links yet. Create one above.
              </p>
            ) : (
              <ul className="space-y-2">
                {shares.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center gap-2 rounded-md border bg-card px-3 py-2"
                  >
                    <code className="flex-1 truncate text-xs text-muted-foreground">
                      /share/{s.token}
                    </code>
                    <Badge variant="secondary" className="capitalize">
                      {s.role}
                    </Badge>
                    {s.passwordProtected && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="outline"
                            className="gap-1 border-amber-500/40 text-amber-600"
                          >
                            <KeyRound className="h-3 w-3" />
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>Password protected</TooltipContent>
                      </Tooltip>
                    )}
                    {s.oneTime && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="outline"
                            className="border-sky-500/40 text-sky-600"
                          >
                            1×
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>One-time use</TooltipContent>
                      </Tooltip>
                    )}
                    {s.downloadLimit != null && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="outline"
                            className="font-mono text-[10px]"
                          >
                            {s.downloadCount ?? 0}/{s.downloadLimit}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>
                          Downloads used / limit
                        </TooltipContent>
                      </Tooltip>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => copyLink(s)}
                          aria-label="Copy link"
                        >
                          {copiedId === s.id ? (
                            <Check className="h-4 w-4 text-success" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {copiedId === s.id ? "Copied!" : "Copy link"}
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => revoke(s.id)}
                          aria-label="Revoke link"
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Revoke</TooltipContent>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

function DetailsPanel({
  file,
  open,
  onOpenChange,
  onOpenShare,
  onDownload,
  onMove,
  onRemove,
}: {
  file: FileItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenShare: () => void;
  onDownload: () => void;
  onMove: () => void;
  onRemove: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full max-w-sm flex-col p-0">
        <SheetHeader className="pr-10">
          <SheetTitle>Details</SheetTitle>
        </SheetHeader>

        {file && (
          <>
            <div className="flex-1 overflow-y-auto p-4">
              {/* File icon + name */}
              <div className="mb-4 flex flex-col items-center text-center">
                <span
                  className={cn(
                    "grid h-16 w-16 place-items-center rounded-xl bg-muted",
                    colorForMime(file.mime)
                  )}
                >
                  {(() => {
                    const Icon = iconForMime(file.mime);
                    return <Icon className="h-8 w-8" />;
                  })()}
                </span>
                <div className="mt-3 break-words text-sm font-medium">
                  {file.name}
                </div>
                {file.templateId && (
                  <Badge variant="secondary" className="mt-1 text-[10px]">
                    Template
                  </Badge>
                )}
              </div>

              {/* Metadata */}
              <dl className="space-y-3 text-xs">
                <div className="flex items-start justify-between gap-4 border-t pt-3">
                  <dt className="font-medium text-muted-foreground">Type</dt>
                  <dd className="text-right">{prettyMime(file.mime)}</dd>
                </div>
                <div className="flex items-start justify-between gap-4 border-t pt-3">
                  <dt className="font-medium text-muted-foreground">Size</dt>
                  <dd className="text-right">{fmtSize(file.size)}</dd>
                </div>
                <div className="flex items-start justify-between gap-4 border-t pt-3">
                  <dt className="font-medium text-muted-foreground">Status</dt>
                  <dd className="text-right capitalize">{file.status}</dd>
                </div>
                <div className="flex items-start justify-between gap-4 border-t pt-3">
                  <dt className="font-medium text-muted-foreground">
                    Modified
                  </dt>
                  <dd className="text-right">
                    {new Date(file.createdAt).toLocaleString()}
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-4 border-t pt-3">
                  <dt className="font-medium text-muted-foreground">ID</dt>
                  <dd className="truncate font-mono text-[10px] text-muted-foreground">
                    {file.id}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-2 border-t p-4">
              {file.templateId && (
                <Button asChild variant="outline" size="sm">
                  <Link href={`/templates/${file.templateId}/designer`}>
                    <PencilLine className="h-4 w-4" />
                    Open in designer
                  </Link>
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={onDownload}>
                <Download className="h-4 w-4" />
                Download
              </Button>
              <Button variant="outline" size="sm" onClick={onOpenShare}>
                <Share2 className="h-4 w-4" />
                Share
              </Button>
              <Button variant="outline" size="sm" onClick={onMove}>
                <Move className="h-4 w-4" />
                Move…
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onRemove}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
                Move to trash
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function putWithProgress(
  url: string,
  file: File,
  onProgress: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed: ${xhr.status}`));
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(file);
  });
}

function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function prettyMime(mime: string) {
  if (!mime) return "File";
  if (mime === "application/pdf") return "PDF";
  if (mime.startsWith("image/")) return "Image";
  if (mime === "text/html") return "HTML";
  if (mime === "text/csv") return "CSV";
  return mime.split("/")[1]?.toUpperCase() || mime;
}
