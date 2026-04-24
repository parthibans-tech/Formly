"use client";

/**
 * Post-generate PDF preview.
 *
 * Designers used to `window.open(downloadUrl)` the moment generate
 * finished — which dumped a PDF on the user's disk with no chance to
 * eyeball it first. This dialog replaces that: the generated PDF is
 * shown in-app, and the user picks the next action (download / share
 * / open in Drive / close) explicitly.
 *
 * Every generate path (sync + async) now persists the output as a
 * regular file in Drive, so "share" and "open in Drive" are always
 * available. When for some reason we don't have an `outputFileId`
 * (forward-compat guard), those two buttons hide and only Download +
 * Close remain.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FolderOpen, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PdfViewerDialog } from "@/components/pdf-viewer-dialog";
import { ShareModal } from "@/components/share-modal";

export interface GeneratedPreviewDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Presigned download URL for the generated PDF. */
  downloadUrl: string | null;
  /** File ID of the persisted copy in Drive. When absent (rare), the
   *  Share and Open-in-Drive buttons hide — we can't do either without
   *  a stable file handle. */
  outputFileId?: string;
  /** Suggested filename shown in the header + used for download. */
  fileName: string;
  /** Optional status line rendered under the filename ("Generated just
   *  now" etc.). */
  subtitle?: string;
}

export function GeneratedPreviewDialog({
  open,
  onOpenChange,
  downloadUrl,
  outputFileId,
  fileName,
  subtitle,
}: GeneratedPreviewDialogProps) {
  const router = useRouter();
  const [shareOpen, setShareOpen] = useState(false);

  const canShare = !!outputFileId;
  const canOpenInDrive = !!outputFileId;

  return (
    <>
      <PdfViewerDialog
        open={open}
        onOpenChange={onOpenChange}
        url={downloadUrl}
        fileName={fileName}
        subtitle={subtitle ?? "Saved to Drive"}
        actions={
          <>
            {canShare ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShareOpen(true)}
                className="gap-1.5"
              >
                <Share2 className="h-4 w-4" />
                <span className="hidden sm:inline">Share</span>
              </Button>
            ) : null}
            {canOpenInDrive ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push("/drive")}
                className="gap-1.5"
              >
                <FolderOpen className="h-4 w-4" />
                <span className="hidden sm:inline">Open in Drive</span>
              </Button>
            ) : null}
          </>
        }
      />
      {canShare && outputFileId ? (
        <ShareModal
          fileId={outputFileId}
          fileName={fileName}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      ) : null}
    </>
  );
}
