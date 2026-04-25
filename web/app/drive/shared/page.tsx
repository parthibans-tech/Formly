"use client";

// "Shared with me" — flat list of files + templates that other people
// have granted the current user access to (directly, via a group, or via
// a shared folder).
//
// Backend: GET /v1/shared-with-me returns a flat `files` array where each
// item extends the usual FileItem DTO with `ownerEmail`, `role`, and
// `sharedVia` ("user" | "group" | "folder") so we can surface *who*
// shared it and *how*.
//
// This page mirrors the /drive/recent + /drive/templates skeleton so the
// look-and-feel is consistent with the rest of the workspace nav.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Eye, PencilLine, Share2, Star } from "lucide-react";
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
import { AppShell } from "@/components/app-shell";
import { FileList, type FileItem } from "@/components/file-list";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ViewToggle } from "@/components/view-toggle";
import { useViewMode } from "@/hooks/use-view-mode";
import { userInitials } from "@/lib/user";
import { Badge } from "@/components/ui/badge";

// Server returns the normal FileItem plus a few join fields telling us
// where this access came from. We only surface them in the header
// breakdown — the row actions don't care.
type SharedFileItem = FileItem & {
  ownerEmail?: string;
  role?: "viewer" | "editor";
  sharedVia?: "user" | "group" | "folder";
};

export default function SharedWithMePage() {
  const router = useRouter();
  const toast = useToast();
  const [files, setFiles] = useState<SharedFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [view, setView] = useViewMode();
  const initials = userInitials(getUser());

  async function load() {
    setLoading(true);
    try {
      const r = await api<{ files: SharedFileItem[] }>(`/v1/shared-with-me`);
      setFiles(r.files || []);
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

  // Small "how many came from direct shares vs groups vs folder cascade"
  // breakdown. Purely informational but helps users who share lots of
  // stuff understand why an item showed up.
  const sourceCounts = useMemo(() => {
    const c = { user: 0, group: 0, folder: 0 };
    for (const f of files) {
      if (f.sharedVia === "user") c.user++;
      else if (f.sharedVia === "group") c.group++;
      else if (f.sharedVia === "folder") c.folder++;
    }
    return c;
  }, [files]);

  // Optimistic star toggle — same pattern as Recent / Drive. Users can
  // star items that were shared with them; the star lives on their
  // own user_id row so the owner never sees it.
  async function toggleStar(f: FileItem) {
    const next = !f.starred;
    setFiles((xs) =>
      xs.map((x) => (x.id === f.id ? { ...x, starred: next } : x))
    );
    try {
      await api(`/v1/files/${f.id}/star`, {
        method: next ? "POST" : "DELETE",
      });
    } catch (e: any) {
      setFiles((xs) =>
        xs.map((x) => (x.id === f.id ? { ...x, starred: !next } : x))
      );
      toast.show("error", "Couldn't update star", { description: e.message });
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
        placeholder: "Search shared items…",
      }}
    >
      <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Share2 className="h-6 w-6 text-primary" />
            Shared with me
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Files and templates other people have given you access to —
            directly, through a group, or via a folder share.
          </p>
          {!loading && files.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
              <Badge variant="secondary">
                {files.length} item{files.length === 1 ? "" : "s"}
              </Badge>
              {sourceCounts.user > 0 && (
                <Badge variant="outline" className="font-normal">
                  {sourceCounts.user} direct
                </Badge>
              )}
              {sourceCounts.group > 0 && (
                <Badge variant="outline" className="font-normal">
                  {sourceCounts.group} via group
                </Badge>
              )}
              {sourceCounts.folder > 0 && (
                <Badge variant="outline" className="font-normal">
                  {sourceCounts.folder} via folder
                </Badge>
              )}
            </div>
          )}
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
          actorLabel="Shared"
          onToggleStar={toggleStar}
          actions={(f) => {
            const shared = f as SharedFileItem;
            const canEdit = shared.role === "editor";
            return [
              // Editors see the right "Open …" entry. DOCX-style files
              // route to the document editor (ONLYOFFICE); everything
              // else flows through the PDF designer. Viewers get a
              // read-only Preview entry below.
              ...(canEdit && canOpenInOnlyOffice(f)
                ? [
                    {
                      label: "Open in document editor",
                      icon: <PencilLine className="h-4 w-4" />,
                      onClick: () =>
                        openInOnlyOffice(f, (href) => router.push(href)),
                    },
                  ]
                : []),
              ...(canEdit &&
              !canOpenInOnlyOffice(f) &&
              canOpenInCodeEditor(f)
                ? [
                    {
                      label: "Open in code editor",
                      icon: <PencilLine className="h-4 w-4" />,
                      onClick: () =>
                        openInCodeEditor(f, (href) => router.push(href)),
                    },
                  ]
                : []),
              ...(canEdit &&
              !canOpenInOnlyOffice(f) &&
              !canOpenInCodeEditor(f) &&
              canOpenInDesigner(f)
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
              ...(f.templateId && !canEdit
                ? [
                    {
                      label: "Preview template",
                      icon: <Eye className="h-4 w-4" />,
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
                label: f.starred ? "Unstar" : "Star",
                icon: <Star className="h-4 w-4" />,
                onClick: toggleStar,
              },
              // Intentionally no "Move to trash" — the current user
              // doesn't own the file, so they shouldn't delete it. If
              // they want it gone from this list they need to ask the
              // owner to revoke their access.
            ];
          }}
          emptyState={
            <EmptyState
              icon={Share2}
              title="Nothing shared with you yet"
              description="When a teammate shares a file, folder, or template with you — directly or through a group — it will appear here."
            />
          }
        />
      )}
    </AppShell>
  );
}
