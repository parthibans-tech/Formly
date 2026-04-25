"use client";

import Link from "next/link";
import {
  Folder as FolderIcon,
  Lock,
  LockOpen,
  MoreHorizontal,
  PencilLine,
  Trash2,
  Users,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type GridFolder = {
  id: string;
  parentId: string | null;
  name: string;
  createdAt: string;
  locked?: boolean;
};

type Props = {
  folder: GridFolder;
  isDropTarget: boolean;
  onDragEnter: () => void;
  onDragLeave: () => void;
  onDrop: (fileId: string) => void;
  onRename: () => void;
  onDelete: () => void;
  onShare?: () => void;
  onToggleLock?: () => void;
};

export function FolderGridCard({
  folder,
  isDropTarget,
  onDragEnter,
  onDragLeave,
  onDrop,
  onRename,
  onDelete,
  onShare,
  onToggleLock,
}: Props) {
  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-formly-file")) {
          e.preventDefault();
          onDragEnter();
        }
      }}
      onDragLeave={onDragLeave}
      onDrop={(e) => {
        const fileId = e.dataTransfer.getData("application/x-formly-file");
        onDragLeave();
        if (fileId) {
          e.preventDefault();
          e.stopPropagation();
          onDrop(fileId);
        }
      }}
      className={cn(
        "group flex items-center gap-2 rounded-lg border bg-card px-3 py-2.5 shadow-subtle transition-all hover:border-border hover:bg-muted/30 hover:shadow-card",
        isDropTarget &&
          "border-primary bg-primary/5 shadow-card ring-1 ring-primary/30"
      )}
    >
      <Link
        href={`/drive?folder=${folder.id}`}
        className="flex min-w-0 flex-1 items-center gap-2.5"
      >
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-amber-500 text-white shadow-subtle">
          <FolderIcon className="h-3.5 w-3.5" fill="currentColor" />
        </span>
        <span className="truncate text-[13px] font-medium text-foreground">
          {folder.name}
        </span>
        {folder.locked && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
            title="Locked folder — re-auth required"
          >
            <Lock className="h-3 w-3" />
          </span>
        )}
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Actions for ${folder.name}`}
            className="h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={onRename}>
            <PencilLine className="h-4 w-4" />
            Rename
          </DropdownMenuItem>
          {onShare && (
            <DropdownMenuItem onClick={onShare}>
              <Users className="h-4 w-4" />
              Share with people
            </DropdownMenuItem>
          )}
          {onToggleLock && (
            <DropdownMenuItem onClick={onToggleLock}>
              {folder.locked ? (
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
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onDelete} destructive>
            <Trash2 className="h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
