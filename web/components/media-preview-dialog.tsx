"use client";

/**
 * Drive-side audio / video preview.
 *
 * Counterpart to `FilePreviewDialog` (which owns PDFs). Opens when
 * the user clicks an `audio/*` or `video/*` row that doesn't route to
 * the code editor / designer / OnlyOffice. Fetches a presigned
 * download URL and hands it to a native `<video>` or `<audio>`
 * element with `controls` — S3 / MinIO honour HTTP byte-range
 * requests on presigned URLs, so seeking and partial fetches Just
 * Work without any of our code touching the bytes.
 *
 * Why a separate dialog (rather than extending FilePreviewDialog):
 *
 *   - The PDF dialog ships heavy machinery (react-pdf, pdf.js worker,
 *     virtualized page list, overlay slot for AcroForm widgets). None
 *     of that is relevant for media, and lazy-loading react-pdf for
 *     a video click is wasteful.
 *   - Sizing differs. Video wants 80vh for a tall modal; audio wants
 *     "as small as the controls allow" so we don't render a giant
 *     black void around a 50px-tall control strip.
 *
 * Read-only by design — no playback-rate menu, no captions track, no
 * picture-in-picture. The point is "let the user click play before
 * deciding to download," not to reinvent a media app.
 *
 * CSP: relies on `media-src 'self' blob: <storage>` in
 * `next.config.js` — the `<video src>` / `<audio src>` URL is the
 * presigned storage origin (MinIO in dev, S3/CloudFront in prod), so
 * the storage origin must be in the directive or the browser blocks
 * the load with a console error and a black box.
 */

import { useCallback, useEffect, useState } from "react";
import { Download, Share2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";

export interface MediaPreviewDialogProps {
  fileId: string;
  fileName: string;
  /**
   * Pre-classified media kind. Callers should derive this from the
   * MIME prefix (`audio/` vs `video/`) — keeping the classification at
   * the call site means this component stays oblivious to the file
   * row shape and we don't have to plumb the full mime through.
   */
  kind: "audio" | "video";
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /**
   * Optional: when provided, a Share button is rendered in the
   * header. Parent owns the actual ShareModal — same contract as
   * `FilePreviewDialog` so the two dialogs feel identical from the
   * Drive page's perspective.
   */
  onShare?: () => void;
}

export function MediaPreviewDialog({
  fileId,
  fileName,
  kind,
  open,
  onOpenChange,
  onShare,
}: MediaPreviewDialogProps) {
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      // Drop the URL on close so a re-open re-fetches a fresh
      // presigned URL — the previous one may have hit its (short)
      // TTL while the dialog was closed and the browser would
      // otherwise re-use a stale Range request against an expired
      // signature.
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

  // Force-download via a transient anchor — same trick as
  // PdfViewerDialog.downloadNow. Cross-origin presigned URLs ignore
  // the `download` attribute in Chrome, but the API sets
  // Content-Disposition: attachment on presign so the browser still
  // saves the file rather than rendering it inline in a new tab.
  const downloadNow = useCallback(() => {
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [url, fileName]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "w-[95vw] gap-0 overflow-hidden p-0",
          // Video gets a tall modal so widescreen sources have room
          // to breathe; audio autosizes around the control strip
          // (see body sizing below) so a 50px-tall <audio> doesn't
          // sit in the middle of a giant empty viewport.
          kind === "video"
            ? "max-w-[1100px] h-[80vh] flex flex-col"
            : "max-w-[640px]",
        )}
      >
        {/* Header --------------------------------------------------- */}
        <div className="flex items-center gap-3 border-b px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-semibold">
              {fileName}
            </DialogTitle>
          </div>
          <TooltipProvider delayDuration={200}>
            <div className="flex items-center gap-1.5">
              {onShare ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onShare}
                  className="gap-1.5"
                >
                  <Share2 className="h-4 w-4" />
                  <span className="hidden sm:inline">Share</span>
                </Button>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={downloadNow}
                    disabled={!url}
                    className="gap-1.5"
                  >
                    <Download className="h-4 w-4" />
                    <span className="hidden sm:inline">Download</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Save {kind === "video" ? "video" : "audio"} to your device
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onOpenChange(false)}
                    aria-label="Close preview"
                    className="h-8 w-8"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Close (Esc)</TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        </div>

        {/* Body ----------------------------------------------------- */}
        {/*
          Video: black backdrop, fills the remaining modal height,
          centers the element so portrait sources don't smear.
          Audio: light backdrop, padded — the <audio> control strip
          is the whole UI, so the surrounding chrome should look
          like a card, not a void.
        */}
        <div
          className={cn(
            "flex items-center justify-center",
            kind === "video"
              ? "min-h-0 flex-1 bg-black"
              : "bg-muted/30 px-6 py-8",
          )}
        >
          {!url ? (
            <div className="grid w-full place-items-center py-12 text-sm text-muted-foreground">
              Loading preview…
            </div>
          ) : kind === "video" ? (
            // playsInline keeps iOS Safari from yanking the player
            // into fullscreen on tap. preload="metadata" pulls just
            // enough of the moov atom to show duration without
            // streaming the whole file. No autoPlay — a dialog that
            // starts blasting audio the moment it opens is a rude
            // pattern, especially in shared workspaces.
            <video
              src={url}
              controls
              playsInline
              preload="metadata"
              className="max-h-full max-w-full"
            >
              Your browser can&apos;t play this video. Try downloading it
              instead.
            </video>
          ) : (
            <audio
              src={url}
              controls
              preload="metadata"
              className="w-full"
            >
              Your browser can&apos;t play this audio. Try downloading it
              instead.
            </audio>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
