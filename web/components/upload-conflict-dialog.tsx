"use client";

// UploadConflictDialog — shown when the server returns a 409 `name_conflict`
// while creating an upload URL. Lets the user pick one of three paths:
//
//   • Replace — overwrite the existing file, preserving its ID (so shares,
//     comments, and template mappings keep working). Disabled when the
//     existing file is a template; template replacement silently
//     invalidates field geometry, so the backend refuses it.
//   • Keep both — upload with an auto-incremented " (2)" style suffix.
//   • Cancel — abort this upload entirely.
//
// The dialog is purely presentational: it resolves a choice and closes.
// The caller (the upload flow) is responsible for actually re-issuing
// the upload-url request with the chosen `conflict` strategy.

import { Copy, FileWarning, RefreshCw, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export type ConflictChoice = "replace" | "keep" | "cancel";

export type UploadConflict = {
  fileName: string;
  existingFileId: string;
  existingName: string;
  isTemplate: boolean;
};

type Props = {
  conflict: UploadConflict | null;
  onResolve: (choice: ConflictChoice) => void;
};

export function UploadConflictDialog({ conflict, onResolve }: Props) {
  const open = conflict !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        // Closing via the backdrop / Esc counts as "cancel" so we always
        // resolve the pending upload one way or the other — never leave
        // the caller waiting on a promise that'll never fulfil.
        if (!v) onResolve("cancel");
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileWarning className="h-5 w-5 text-amber-500" />
            File already exists
          </DialogTitle>
          <DialogDescription>
            {conflict && (
              <>
                A file named{" "}
                <span className="font-medium text-foreground">
                  "{conflict.fileName}"
                </span>{" "}
                already exists in this folder.
                {conflict.isTemplate && (
                  <>
                    {" "}
                    <Badge variant="secondary" className="ml-1">
                      Template
                    </Badge>
                  </>
                )}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {conflict?.isTemplate && (
          // Small nudge so the user understands why "Replace" is
          // disabled without having to click it to find out.
          <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
            Replacing is disabled because the existing file is a template.
            Swapping the PDF would break saved field mappings. Pick{" "}
            <span className="font-medium text-foreground">Keep both</span> to
            upload alongside it, or rename the new file.
          </p>
        )}

        <DialogFooter className="sm:flex-col sm:items-stretch sm:gap-2">
          {/* Primary action first, cancel last. "Keep both" is the safer
              default (non-destructive) so it gets the solid-primary
              treatment; replace is outlined-destructive so muscle memory
              doesn't nuke the existing file. */}
          <Button
            onClick={() => onResolve("keep")}
            className="w-full justify-center"
          >
            <Copy className="h-4 w-4" />
            Keep both (upload as a copy)
          </Button>
          <Button
            variant="outline"
            onClick={() => onResolve("replace")}
            disabled={conflict?.isTemplate}
            className="w-full justify-center border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className="h-4 w-4" />
            Replace existing file
          </Button>
          <Button
            variant="ghost"
            onClick={() => onResolve("cancel")}
            className="w-full justify-center"
          >
            <X className="h-4 w-4" />
            Cancel upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
