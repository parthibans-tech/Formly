"use client";

// Trash page — shows soft-deleted files. Items sit here until the user
// either:
//   • restores them (POST /v1/files/:id/restore), or
//   • permanently deletes one (DELETE /v1/files/:id/purge), or
//   • bulk-restores or bulk-purges a selection, or
//   • empties the whole bin (POST /v1/trash/empty).
//
// The permanent-delete actions call the "purge" endpoints — those remove
// the DB row AND the blob in storage, so there's no going back. Every
// destructive action is wrapped in a confirm dialog and labelled with an
// explicit count / file name so the user can't nuke things by mistake.

import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCcw, Trash2, X, XCircle, Download } from "lucide-react";
import { api, getUser } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/ui/confirm";
import { AppShell } from "@/components/app-shell";
import {
  FileList,
  type FileItem,
  type FileListSelection,
} from "@/components/file-list";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ViewToggle } from "@/components/view-toggle";
import { useViewMode } from "@/hooks/use-view-mode";
import { userInitials } from "@/lib/user";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function TrashPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [emptying, setEmptying] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [view, setView] = useViewMode();
  // Set of file IDs currently selected for a bulk action. Lives here (not
  // in FileList) so the action bar can read it without prop-drilling.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const initials = userInitials(getUser());

  async function load() {
    setLoading(true);
    try {
      const r = await api<{ files: FileItem[] }>("/v1/files?view=trashed");
      setFiles(r.files);
      // After every successful refresh, drop any selections that point to
      // files that no longer exist (post-purge / post-restore). Without
      // this the action bar keeps dangling IDs and "Delete N" shows a
      // stale count.
      setSelectedIds((prev) => {
        if (prev.size === 0) return prev;
        const alive = new Set(r.files.map((f) => f.id));
        const next = new Set<string>();
        for (const id of prev) if (alive.has(id)) next.add(id);
        return next;
      });
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toggle a single file in/out of the selection. Memoised so FileList's
  // memoised children don't re-render on unrelated state changes.
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Select-all behaviour: toggles between "every visible file selected"
  // and "no visible files selected". The "visible" distinction matters
  // because the user might be filtering by search — we only act on what
  // they see. (Hidden-but-selected rows are left alone.)
  const toggleSelectAll = useCallback((visibleIds: string[]) => {
    setSelectedIds((prev) => {
      const allVisibleSelected =
        visibleIds.length > 0 && visibleIds.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  }, []);

  const selection: FileListSelection = useMemo(
    () => ({
      ids: selectedIds,
      onToggle: toggleSelect,
      onToggleAll: toggleSelectAll,
    }),
    [selectedIds, toggleSelect, toggleSelectAll]
  );

  function clearSelection() {
    setSelectedIds(new Set());
  }

  // --- single-file handlers ------------------------------------------------

  async function restore(f: FileItem) {
    try {
      await api(`/v1/files/${f.id}/restore`, { method: "POST" });
      toast.show("success", `Restored ${f.name}`);
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function download(f: FileItem) {
    try {
      const { downloadUrl } = await api<{ downloadUrl: string }>(
        `/v1/files/${f.id}/download`
      );
      window.open(downloadUrl, "_blank");
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function purge(f: FileItem) {
    const ok = await confirm({
      title: `Delete "${f.name}" permanently?`,
      description:
        "This file will be removed from the database and from storage. This cannot be undone.",
      confirmLabel: "Delete permanently",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/files/${f.id}/purge`, { method: "DELETE" });
      toast.show("success", `"${f.name}" deleted permanently`);
      await load();
    } catch (e: any) {
      toast.show("error", "Couldn't delete file", { description: e.message });
    }
  }

  // --- bulk handlers -------------------------------------------------------

  // Fires N requests in parallel, collects successes + failures, surfaces
  // a single summary toast. The server doesn't have a batch endpoint yet
  // (would be nice) — Promise.allSettled keeps this good enough.
  async function bulkRestore() {
    const ids = [...selectedIds];
    if (ids.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(
        ids.map((id) => api(`/v1/files/${id}/restore`, { method: "POST" }))
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const fail = results.length - ok;
      if (fail === 0) {
        toast.show(
          "success",
          `Restored ${ok} file${ok === 1 ? "" : "s"}`
        );
      } else if (ok === 0) {
        toast.show("error", `Couldn't restore ${fail} file${fail === 1 ? "" : "s"}`);
      } else {
        toast.show(
          "info",
          `Restored ${ok}, ${fail} failed`,
          { description: "Check permissions or refresh and try again." }
        );
      }
      clearSelection();
      await load();
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkPurge() {
    const ids = [...selectedIds];
    if (ids.length === 0 || bulkBusy) return;
    const ok = await confirm({
      title: `Delete ${ids.length} file${
        ids.length === 1 ? "" : "s"
      } permanently?`,
      description:
        "Selected files will be removed from the database and from storage. This cannot be undone.",
      confirmLabel: `Delete ${ids.length}`,
      destructive: true,
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(
        ids.map((id) => api(`/v1/files/${id}/purge`, { method: "DELETE" }))
      );
      const done = results.filter((r) => r.status === "fulfilled").length;
      const fail = results.length - done;
      if (fail === 0) {
        toast.show(
          "success",
          `Deleted ${done} file${done === 1 ? "" : "s"} permanently`
        );
      } else if (done === 0) {
        toast.show("error", `Couldn't delete ${fail} file${fail === 1 ? "" : "s"}`);
      } else {
        toast.show(
          "info",
          `Deleted ${done}, ${fail} failed`,
          { description: "Some files may have already been restored or removed." }
        );
      }
      clearSelection();
      await load();
    } finally {
      setBulkBusy(false);
    }
  }

  async function emptyTrash() {
    if (files.length === 0 || emptying) return;
    const ok = await confirm({
      title: "Empty trash?",
      description: `All ${files.length} file${
        files.length === 1 ? "" : "s"
      } in the trash will be permanently deleted from both the database and storage. This cannot be undone.`,
      confirmLabel: "Empty trash",
      destructive: true,
    });
    if (!ok) return;
    setEmptying(true);
    try {
      const r = await api<{ deleted: number }>(`/v1/trash/empty`, {
        method: "POST",
      });
      toast.show(
        "success",
        `Deleted ${r.deleted} file${r.deleted === 1 ? "" : "s"} permanently`
      );
      clearSelection();
      await load();
    } catch (e: any) {
      toast.show("error", "Couldn't empty trash", { description: e.message });
    } finally {
      setEmptying(false);
    }
  }

  const selectedCount = selectedIds.size;

  return (
    <AppShell
      search={{
        value: search,
        onChange: setSearch,
        placeholder: "Search trash…",
      }}
    >
      <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trash</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Files moved to trash stay here until you restore or permanently
            delete them.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle value={view} onChange={setView} />
          {/* Empty-trash is hidden when the bulk action bar is visible —
              the two together would be redundant noise. */}
          {!loading && files.length > 0 && selectedCount === 0 && (
            <Button
              variant="outline"
              onClick={emptyTrash}
              disabled={emptying}
              className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <XCircle className="h-4 w-4" />
              {emptying ? "Emptying…" : "Empty trash"}
            </Button>
          )}
        </div>
      </div>

      {/* Bulk action bar. Slides in the moment the user selects their
          first file; replaces the "Empty trash" button in the header so
          the page has one obvious primary action at a time. */}
      {selectedCount > 0 && (
        <div
          className={cn(
            "sticky top-0 z-20 mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 shadow-sm",
            "backdrop-blur supports-[backdrop-filter]:bg-primary/10"
          )}
        >
          <span className="text-sm font-medium text-primary">
            {selectedCount} selected
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={bulkRestore}
              disabled={bulkBusy}
            >
              <RotateCcw className="h-4 w-4" />
              {bulkBusy ? "Working…" : `Restore ${selectedCount}`}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={bulkPurge}
              disabled={bulkBusy}
              className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
              Delete {selectedCount} permanently
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={clearSelection}
              disabled={bulkBusy}
              aria-label="Clear selection"
              title="Clear selection"
              className="h-8 w-8"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-2 rounded-lg border bg-card p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : (
        <FileList
          files={files}
          filter={search}
          view={view}
          actorInitials={initials}
          actorLabel="Trashed"
          selection={selection}
          actions={(f) => [
            {
              label: "Restore",
              icon: <RotateCcw className="h-4 w-4" />,
              onClick: restore,
            },
            {
              label: "Download",
              icon: <Download className="h-4 w-4" />,
              onClick: download,
            },
            {
              label: "Delete permanently",
              icon: <Trash2 className="h-4 w-4" />,
              onClick: purge,
              destructive: true,
            },
          ]}
          emptyState={
            <EmptyState
              icon={Trash2}
              title="Trash is empty"
              description="Files you delete from the drive appear here for recovery."
            />
          }
        />
      )}
    </AppShell>
  );
}
