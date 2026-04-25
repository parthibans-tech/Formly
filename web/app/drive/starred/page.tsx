"use client";

// Starred page — files the current user has explicitly starred.
//
// Server contract (see api/internal/files/files.go):
//   GET  /v1/files?view=starred   → { files: FileItem[] } (all starred=true)
//   POST /v1/files/:id/star       → mark starred
//   DELETE /v1/files/:id/star     → remove star
//
// Unstarring from this page makes the row disappear (it's the only view
// where starred is the inclusion criterion). Everywhere else we keep the
// row and just flip the icon. To avoid a jarring full refetch, we
// optimistically splice the row out of local state and roll back on
// error — same pattern used by `remove()` in other views.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Download,
  Eye,
  PencilLine,
  Share2,
  Star,
  Trash2,
  Users,
} from "lucide-react";
import { api, getUser } from "@/lib/api";
import {
  canOpenInCodeEditor,
  canOpenInDesigner,
  canOpenInOnlyOffice,
  openInCodeEditor,
  openInDesigner,
  openInOnlyOffice,
} from "@/lib/file-open";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/ui/confirm";
import { AppShell } from "@/components/app-shell";
import { FileList, type FileItem } from "@/components/file-list";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ViewToggle } from "@/components/view-toggle";
import { useViewMode } from "@/hooks/use-view-mode";
import { userInitials } from "@/lib/user";
import { SharePeopleModal } from "@/components/share-people-modal";
import { ShareModal } from "@/components/share-modal";
import { FilePreviewDialog } from "@/components/file-preview-dialog";
import { MediaPreviewDialog } from "@/components/media-preview-dialog";

/**
 * Same MIME → media-kind classifier used in /drive/page.tsx. Kept
 * inline here to avoid promoting a two-line check into a shared
 * module — the only consumer is the MediaPreviewDialog `kind` prop.
 */
function mediaKindFor(mime: string): "audio" | "video" | null {
  if (!mime) return null;
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return null;
}

export default function StarredPage() {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [view, setView] = useViewMode();
  const [previewFor, setPreviewFor] = useState<FileItem | null>(null);
  const [mediaPreviewFor, setMediaPreviewFor] = useState<FileItem | null>(
    null,
  );
  const [shareFor, setShareFor] = useState<FileItem | null>(null);
  const [sharePeopleFor, setSharePeopleFor] = useState<
    { id: string; name: string; type: "file" | "folder" } | null
  >(null);
  const initials = userInitials(getUser());

  async function load() {
    setLoading(true);
    try {
      const r = await api<{ files: FileItem[] }>("/v1/files?view=starred");
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
      description: "You can restore it later from the trash view.",
      confirmLabel: "Move to trash",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/files/${f.id}`, { method: "DELETE" });
      toast.show("success", "Moved to trash");
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  // Unstar from the Starred view. Optimistic: we splice the row out
  // locally before the request returns so the list feels snappy. On
  // error we roll back by reloading, which is cheap and keeps state
  // honest.
  async function toggleStar(f: FileItem) {
    const prev = files;
    setFiles((xs) => xs.filter((x) => x.id !== f.id));
    try {
      await api(`/v1/files/${f.id}/star`, { method: "DELETE" });
      toast.show("info", `Unstarred ${f.name}`);
    } catch (e: any) {
      setFiles(prev);
      toast.show("error", "Couldn't unstar", { description: e.message });
    }
  }

  return (
    <AppShell
      search={{
        value: search,
        onChange: setSearch,
        placeholder: "Search starred…",
      }}
    >
      <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Star className="h-6 w-6 fill-amber-400 text-amber-500" />
            Starred
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Files you've starred for quick access. Click the star again to
            remove.
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
          actorLabel="Starred"
          onToggleStar={toggleStar}
          actions={(f) => [
            ...(canOpenInOnlyOffice(f)
              ? [
                  {
                    label: "Open in document editor",
                    icon: <PencilLine className="h-4 w-4" />,
                    onClick: () =>
                      openInOnlyOffice(f, (href) => router.push(href)),
                  },
                ]
              : []),
            ...(!canOpenInOnlyOffice(f) && canOpenInCodeEditor(f)
              ? [
                  {
                    label: "Open in code editor",
                    icon: <PencilLine className="h-4 w-4" />,
                    onClick: () =>
                      openInCodeEditor(f, (href) => router.push(href)),
                  },
                ]
              : []),
            ...(!canOpenInOnlyOffice(f) && !canOpenInCodeEditor(f) && canOpenInDesigner(f)
              ? [
                  {
                    label: "Open designer",
                    icon: <PencilLine className="h-4 w-4" />,
                    onClick: async () => {
                      try {
                        const id = await openInDesigner(f, (href) =>
                          router.push(href)
                        );
                        if (!id) {
                          toast.show(
                            "error",
                            "No designer available for this file type."
                          );
                        }
                      } catch (e: any) {
                        toast.show("error", e.message);
                      }
                    },
                  },
                ]
              : []),
            ...(!f.templateId && f.mime === "application/pdf"
              ? [
                  {
                    label: "Preview",
                    icon: <Eye className="h-4 w-4" />,
                    onClick: (file: FileItem) => setPreviewFor(file),
                  },
                ]
              : []),
            // Audio / video play action. "Play" verb instead of
            // "Preview" so users know they're getting a media
            // player, not a still thumbnail.
            ...(mediaKindFor(f.mime)
              ? [
                  {
                    label:
                      mediaKindFor(f.mime) === "video"
                        ? "Play video"
                        : "Play audio",
                    icon: <Eye className="h-4 w-4" />,
                    onClick: (file: FileItem) => setMediaPreviewFor(file),
                  },
                ]
              : []),
            {
              label: "Download",
              icon: <Download className="h-4 w-4" />,
              onClick: download,
            },
            {
              label: "Share with people",
              icon: <Users className="h-4 w-4" />,
              onClick: (file: FileItem) =>
                setSharePeopleFor({
                  id: file.id,
                  name: file.name,
                  type: "file",
                }),
            },
            {
              label: "Get link…",
              icon: <Share2 className="h-4 w-4" />,
              onClick: (file: FileItem) => setShareFor(file),
            },
            {
              label: "Unstar",
              icon: <Star className="h-4 w-4" />,
              onClick: toggleStar,
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
              icon={Star}
              title="No starred files"
              description="Click the star icon on any file to keep it in easy reach here."
            />
          }
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
    </AppShell>
  );
}
