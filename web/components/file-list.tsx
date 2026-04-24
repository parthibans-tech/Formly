"use client";

import Link from "next/link";
import { useMemo } from "react";
import { MoreHorizontal, PencilLine, Download, RotateCcw, Star, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { iconForMime, colorForMime } from "@/lib/file-icons";
import { cn } from "@/lib/utils";
import {
  FileGridCard,
  type GridCardMenuItem,
} from "@/components/file-grid-card";
import type { ViewMode } from "@/hooks/use-view-mode";

export type FileItem = {
  id: string;
  name: string;
  mime: string;
  size: number;
  status?: string;
  templateId?: string;
  folderId?: string | null;
  createdAt: string;
  // Per-user starred flag — true when the current caller has starred
  // this file. Optional because the server may omit it on views that
  // don't join starred_files (older handlers, public share endpoints).
  starred?: boolean;
};

type RowAction = {
  label: string;
  icon: React.ReactNode;
  onClick: (file: FileItem) => void;
  destructive?: boolean;
};

/**
 * Optional multi-select plumbing. Opt in by passing `selection` — existing
 * callers (recent, templates, shared) don't need to change anything. The
 * Trash page uses this to wire up bulk restore / bulk permanent-delete.
 */
export type FileListSelection = {
  /** Selected file IDs. Order doesn't matter; Set for O(1) lookup. */
  ids: Set<string>;
  /** Toggle a single file in/out of the selection. */
  onToggle: (id: string) => void;
  /**
   * "Select all visible" handler. Receives the IDs of files that pass the
   * current filter (since the user probably only wants to act on what
   * they can actually see on screen). If omitted, the select-all
   * checkbox is hidden.
   */
  onToggleAll?: (visibleIds: string[]) => void;
};

type Props = {
  files: FileItem[];
  filter?: string;
  emptyState?: React.ReactNode;
  actions?: (file: FileItem) => RowAction[];
  view?: ViewMode;
  actorInitials?: string;
  actorLabel?: string;
  selection?: FileListSelection;
  /**
   * Optional per-file star toggle. When provided, the grid cards render
   * a star overlay on the thumbnail and list rows render a star cell
   * before the name column. The callback is fired whenever the user
   * clicks either affordance; the parent owns optimistic-update logic
   * (flip `file.starred` locally, issue POST/DELETE, roll back on error).
   */
  onToggleStar?: (file: FileItem) => void;
};

export function FileList({
  files,
  filter,
  emptyState,
  actions,
  view = "grid",
  actorInitials = "?",
  actorLabel = "Modified",
  selection,
  onToggleStar,
}: Props) {
  const filtered = useMemo(() => {
    const q = filter?.trim().toLowerCase();
    if (!q) return files;
    return files.filter(
      (f) =>
        f.name.toLowerCase().includes(q) || f.mime.toLowerCase().includes(q)
    );
  }, [files, filter]);

  // Aggregate select-all state: unchecked / indeterminate / checked, based
  // on how many visible files are in the selection set.
  const visibleIds = useMemo(() => filtered.map((f) => f.id), [filtered]);
  const visibleSelectedCount = useMemo(() => {
    if (!selection) return 0;
    let n = 0;
    for (const id of visibleIds) if (selection.ids.has(id)) n++;
    return n;
  }, [selection, visibleIds]);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleSelectedCount === visibleIds.length;
  const someVisibleSelected =
    visibleSelectedCount > 0 && !allVisibleSelected;
  // True when the parent is in bulk-select mode (at least one selection).
  // Drives the always-visible checkboxes on grid cards.
  const bulkSelectActive = (selection?.ids.size ?? 0) > 0;

  if (filtered.length === 0) {
    return <>{emptyState}</>;
  }

  if (view === "grid") {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {filtered.map((file) => {
          const rowActions = actions ? actions(file) : [];
          const menuItems: GridCardMenuItem[] = rowActions.map((a) => ({
            label: a.label,
            icon: a.icon,
            onClick: () => a.onClick(file),
            destructive: a.destructive,
          }));
          // Insert a separator before the first destructive action.
          const firstDestructive = menuItems.findIndex((m) => m.destructive);
          if (firstDestructive > 0) {
            menuItems[firstDestructive] = {
              ...menuItems[firstDestructive],
              separatorBefore: true,
            };
          }
          return (
            <FileGridCard
              key={file.id}
              file={{ ...file, status: file.status || "ready" }}
              actorInitials={actorInitials}
              actorLabel={actorLabel}
              menuItems={menuItems}
              draggable={false}
              selected={selection?.ids.has(file.id)}
              onToggleSelect={
                selection ? () => selection.onToggle(file.id) : undefined
              }
              bulkSelectActive={bulkSelectActive}
              onToggleStar={
                onToggleStar ? () => onToggleStar(file) : undefined
              }
            />
          );
        })}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            {/* Only render the select-all header cell when bulk selection
                is actually wired up by the caller (selection + onToggleAll).
                Recent / Templates / Shared don't pass `selection`, so they
                get the original 5-column layout unchanged. */}
            {selection && selection.onToggleAll && (
              <th scope="col" className="w-10 px-4 py-2.5">
                <input
                  type="checkbox"
                  aria-label={
                    allVisibleSelected
                      ? "Clear selection"
                      : "Select all visible"
                  }
                  checked={allVisibleSelected}
                  ref={(el) => {
                    // Native indeterminate state must be set imperatively
                    // — React doesn't have a prop for it.
                    if (el) el.indeterminate = someVisibleSelected;
                  }}
                  onChange={() => selection.onToggleAll!(visibleIds)}
                  className="h-4 w-4 cursor-pointer"
                />
              </th>
            )}
            {onToggleStar && (
              // Star column. Narrow fixed width so it doesn't shove the
              // other columns around. No header label — the column is
              // self-explanatory and a "Star" header reads like a bulk
              // action the user expected to click.
              <th scope="col" className="w-10 px-2 py-2.5" aria-label="Starred" />
            )}
            <th scope="col" className="px-4 py-2.5 font-medium">Name</th>
            <th scope="col" className="px-4 py-2.5 font-medium">Type</th>
            <th scope="col" className="px-4 py-2.5 font-medium">Size</th>
            <th scope="col" className="px-4 py-2.5 font-medium">Created</th>
            <th scope="col" className="px-4 py-2.5"></th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((file) => {
            const Icon = iconForMime(file.mime);
            const rowActions = actions ? actions(file) : [];
            const isSelected = selection?.ids.has(file.id) ?? false;
            return (
              <tr
                key={file.id}
                className={cn(
                  "group border-b last:border-0 transition-colors hover:bg-accent/40",
                  isSelected && "bg-primary/5"
                )}
              >
                {selection && selection.onToggleAll && (
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label={isSelected ? "Deselect" : "Select"}
                      checked={isSelected}
                      onChange={() => selection.onToggle(file.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="h-4 w-4 cursor-pointer"
                    />
                  </td>
                )}
                {onToggleStar && (
                  <td className="px-2 py-3">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleStar(file);
                      }}
                      aria-label={file.starred ? "Unstar" : "Star"}
                      aria-pressed={!!file.starred}
                      title={file.starred ? "Starred — click to unstar" : "Star"}
                      className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <Star
                        className={cn(
                          "h-4 w-4",
                          file.starred
                            ? "fill-amber-400 text-amber-500"
                            : "opacity-60"
                        )}
                      />
                    </button>
                  </td>
                )}
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <span
                      className={cn(
                        "grid h-8 w-8 place-items-center rounded-md bg-muted",
                        colorForMime(file.mime)
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {file.templateId ? (
                          <Link
                            href={`/templates/${file.templateId}/designer`}
                            className="hover:underline"
                          >
                            {file.name}
                          </Link>
                        ) : (
                          file.name
                        )}
                      </div>
                      {file.templateId && (
                        <Badge
                          variant="secondary"
                          className="mt-0.5 text-[10px]"
                        >
                          Template
                        </Badge>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {prettyMime(file.mime)}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {fmtSize(file.size)}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {new Date(file.createdAt).toLocaleDateString()}
                </td>
                <td className="px-4 py-3 text-right">
                  {rowActions.length > 0 && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Actions for ${file.name}`}
                          className="opacity-60 group-hover:opacity-100"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        {rowActions.map((a, i) => (
                          <div key={i}>
                            {a.destructive &&
                              i > 0 &&
                              !rowActions[i - 1].destructive && (
                                <DropdownMenuSeparator />
                              )}
                            <DropdownMenuItem
                              onClick={() => a.onClick(file)}
                              destructive={a.destructive}
                            >
                              {a.icon}
                              {a.label}
                            </DropdownMenuItem>
                          </div>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function prettyMime(mime: string) {
  if (!mime) return "File";
  if (mime === "application/pdf") return "PDF";
  if (mime.startsWith("image/")) return "Image";
  if (mime === "text/html") return "HTML";
  if (mime === "text/csv") return "CSV";
  if (mime === "text/markdown") return "Markdown";
  return mime.split("/")[1]?.toUpperCase() || mime;
}

export function defaultRowIcons() {
  return {
    openDesigner: <PencilLine className="h-4 w-4" />,
    download: <Download className="h-4 w-4" />,
    restore: <RotateCcw className="h-4 w-4" />,
    trash: <Trash2 className="h-4 w-4" />,
  };
}
