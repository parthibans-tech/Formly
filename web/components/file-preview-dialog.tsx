"use client";

/**
 * Drive-side PDF preview.
 *
 * Opens when the user clicks a PDF file row from Drive that isn't a
 * template (plain PDFs used to have no click-to-view — the only way
 * to see them was Download, which was poor UX). Wraps the shared
 * `PdfViewerDialog` and lazily fetches a presigned URL on first open.
 *
 * Callers supply a `onShare` callback if they want to hand off to a
 * ShareModal on click. We intentionally don't embed the share modal
 * here because share state (roles / expiry / password) is orthogonal
 * to preview state and nesting two dialogs creates focus-trap chaos.
 */

import { useEffect, useState } from "react";
import { Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import { PdfViewerDialog } from "@/components/pdf-viewer-dialog";

export interface FilePreviewDialogProps {
  fileId: string;
  fileName: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Optional: when provided, a Share button is rendered in the header
   *  that invokes this callback. The parent is responsible for opening
   *  the actual ShareModal. */
  onShare?: () => void;
}

export function FilePreviewDialog({
  fileId,
  fileName,
  open,
  onOpenChange,
  onShare,
}: FilePreviewDialogProps) {
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await api<{ downloadUrl: string }>(
          `/v1/files/${fileId}/download`,
        );
        if (!cancelled) setUrl(r.downloadUrl);
      } catch (e) {
        if (!cancelled) {
          toast.show("error", (e as Error).message);
          onOpenChange(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileId, open, onOpenChange, toast]);

  return (
    <PdfViewerDialog
      open={open}
      onOpenChange={onOpenChange}
      url={url}
      fileName={fileName}
      actions={
        onShare ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onShare}
            className="gap-1.5"
          >
            <Share2 className="h-4 w-4" />
            <span className="hidden sm:inline">Share</span>
          </Button>
        ) : null
      }
    />
  );
}
