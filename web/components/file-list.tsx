"use client";

import Link from "next/link";
import { useMemo } from "react";
import { MoreHorizontal, PencilLine, Download, RotateCcw, Trash2 } from "lucide-react";
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
};

type RowAction = {
  label: string;
  icon: React.ReactNode;
  onClick: (file: FileItem) => void;
  destructive?: boolean;
};

type Props = {
  files: FileItem[];
  filter?: string;
  emptyState?: React.ReactNode;
  actions?: (file: FileItem) => RowAction[];
  view?: ViewMode;
  actorInitials?: string;
  actorLabel?: string;
};

export function FileList({
  files,
  filter,
  emptyState,
  actions,
  view = "grid",
  actorInitials = "?",
  actorLabel = "Modified",
}: Props) {
  const filtered = useMemo(() => {
    const q = filter?.trim().toLowerCase();
    if (!q) return files;
    return files.filter(
      (f) =>
        f.name.toLowerCase().includes(q) || f.mime.toLowerCase().includes(q)
    );
  }, [files, filter]);

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
            return (
              <tr
                key={file.id}
                className="group border-b last:border-0 transition-colors hover:bg-accent/40"
              >
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
