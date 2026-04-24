"use client";

/**
 * Low-level PDF viewer dialog — the shared shell used by
 * `FilePreviewDialog` (from Drive) and `GeneratedPreviewDialog`
 * (after a template generate). Keeps dialog chrome, title bar,
 * action buttons, and download fallback in one place.
 *
 * Both call sites reuse `PdfPreview` (the virtualized react-pdf
 * component already living in `components/acroform`) — it wants an
 * `overlayForPage` callback, which for a plain read-only preview is
 * a no-op returning `null`.
 *
 * The `actions` prop is rendered in the dialog header to the right of
 * the title, so each caller can slot in its own buttons (Download /
 * Share / Open in Drive / Save a copy). A few sensible defaults live
 * here so callers don't have to rewire the obvious ones.
 */

import { useCallback } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PdfPreview } from "@/components/acroform/pdf-preview";
import { cn } from "@/lib/utils";

export interface PdfViewerDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Presigned PDF URL to render. If null, the body renders a spinner
   *  state — useful while a parent dialog is still fetching the URL. */
  url: string | null;
  /** Filename shown in the header + used as the download attribute. */
  fileName: string;
  /** Optional descriptor rendered below the filename (e.g. "Generated
   *  just now · 42 KB"). */
  subtitle?: string;
  /** Buttons rendered to the right of the header, before the built-in
   *  Download button. Use this to add Share / Open in Drive / etc. */
  actions?: React.ReactNode;
  /** When false, hides the built-in Download button — useful for a
   *  share-only preview that doesn't allow save. Defaults to true. */
  showDownload?: boolean;
}

export function PdfViewerDialog({
  open,
  onOpenChange,
  url,
  fileName,
  subtitle,
  actions,
  showDownload = true,
}: PdfViewerDialogProps) {
  // Force-download via a transient anchor. Using `target=_blank` alone
  // makes the browser preview the PDF in a tab, which defeats the
  // user's explicit "Download" intent — we want Save-As behaviour.
  const downloadNow = useCallback(() => {
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.rel = "noopener noreferrer";
    // Presigned URLs are cross-origin; Chrome ignores `download` on
    // cross-origin anchors, so the user may still see a tab open — but
    // because the URL's `Content-Disposition` is set server-side on
    // presign, the browser will save it rather than render inline.
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [url, fileName]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // The Dialog needs to be big — PdfPreview fits to its container
        // width. We also want it vertically tall so the full page is
        // visible without scrolling the modal itself.
        className={cn(
          "w-[95vw] max-w-[1100px] h-[92vh] p-0 gap-0 overflow-hidden",
          "flex flex-col",
        )}
      >
        {/* Header ---------------------------------------------------- */}
        <div className="flex items-center gap-3 border-b px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-semibold">
              {fileName}
            </DialogTitle>
            {subtitle ? (
              <div className="truncate text-[11px] text-muted-foreground">
                {subtitle}
              </div>
            ) : null}
          </div>
          <TooltipProvider delayDuration={200}>
            <div className="flex items-center gap-1.5">
              {actions}
              {showDownload ? (
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
                  <TooltipContent>Save PDF to your device</TooltipContent>
                </Tooltip>
              ) : null}
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

        {/* Body — the PDF itself ------------------------------------- */}
        <div className="min-h-0 flex-1 overflow-hidden bg-muted/30">
          {url ? (
            <PdfPreview url={url} overlayForPage={() => null} />
          ) : (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">
              Loading preview…
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
