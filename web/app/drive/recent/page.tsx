"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Clock, Download, PencilLine, Trash2 } from "lucide-react";
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

export default function RecentPage() {
  const router = useRouter();
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
      const r = await api<{ files: FileItem[] }>("/v1/files?view=recent");
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

  async function remove(f: FileItem) {
    const ok = await confirm({
      title: `Move "${f.name}" to trash?`,
      confirmLabel: "Move to trash",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/files/${f.id}`, { method: "DELETE" });
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  return (
    <AppShell
      search={{
        value: search,
        onChange: setSearch,
        placeholder: "Search recent…",
      }}
    >
      <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Recent</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The 50 most recently uploaded or generated files across your
            workspace.
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
          actorLabel="You opened"
          actions={(f) => [
            ...(f.templateId
              ? [
                  {
                    label: "Open designer",
                    icon: <PencilLine className="h-4 w-4" />,
                    onClick: () =>
                      router.push(`/templates/${f.templateId}/designer`),
                  },
                ]
              : []),
            {
              label: "Download",
              icon: <Download className="h-4 w-4" />,
              onClick: download,
            },
            {
              label: "Move to trash",
              icon: <Trash2 className="h-4 w-4" />,
              onClick: remove,
              destructive: true,
            },
          ]}
          emptyState={
            <EmptyState
              icon={Clock}
              title="Nothing here yet"
              description="Recent uploads and generations show up here, newest first."
            />
          }
        />
      )}
    </AppShell>
  );
}
