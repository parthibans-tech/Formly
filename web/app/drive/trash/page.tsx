"use client";

import { useEffect, useState } from "react";
import { Download, RotateCcw, Trash2 } from "lucide-react";
import { api, getUser } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/ui/confirm";
import { AppShell } from "@/components/app-shell";
import { FileList, type FileItem } from "@/components/file-list";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ViewToggle } from "@/components/view-toggle";
import { useViewMode } from "@/hooks/use-view-mode";
import { userInitials } from "@/lib/user";

export default function TrashPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [view, setView] = useViewMode();
  const initials = userInitials(getUser());

  async function load() {
    setLoading(true);
    try {
      const r = await api<{ files: FileItem[] }>("/v1/files?view=trashed");
      setFiles(r.files);
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
        <ViewToggle value={view} onChange={setView} />
      </div>

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
