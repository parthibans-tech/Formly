"use client";

/**
 * Drive-side image preview with two distinct text affordances:
 *
 *   1. **Extract text** (fast, deterministic, no LLM)
 *      Hits POST /v1/files/{id}/extract-text → renders the raw OCR
 *      output in a side panel with a Copy button. Sub-second for a
 *      typical PAN/Aadhaar/receipt; never blocks on model load.
 *
 *   2. **Summarize / Ask** (slower, AI-powered)
 *      Mounts the existing DocChatPanel which round-trips through
 *      /summarize + /ask. Inherits ollama's cold-load tail latency
 *      (90s+ on a 4 GB host the first time after a model swap).
 *
 * Splitting these into separate buttons (rather than one "AI" toggle)
 * came from real user feedback: "I just want to see the text on this
 * card, why am I waiting two minutes?" The fast path now gives that
 * answer in well under a second; the LLM path is opt-in for users who
 * want a written summary or Q&A.
 *
 * Counterpart to `FilePreviewDialog` (PDFs) and `MediaPreviewDialog`
 * (audio / video). Opens when the user clicks an `image/*` row that
 * isn't routed to the designer or OnlyOffice. Fetches a presigned
 * URL and hands it to a plain `<img>` — the browser handles decode,
 * EXIF orientation, and color profiles for free.
 *
 * # Why a separate dialog (rather than extending FilePreviewDialog or
 *   MediaPreviewDialog)
 *
 *   - `FilePreviewDialog` ships react-pdf and the AcroForm overlay
 *     machinery. None of that is relevant for images, and lazy-loading
 *     pdf.js for an image click is wasteful.
 *   - `MediaPreviewDialog` is shaped around timeline media controls
 *     (`controls`, `preload="metadata"`, byte-range seeking). Threading
 *     a third `kind: "image"` branch through it would make every prop
 *     conditional on kind and bloat the component.
 *   - Sizing differs. Images want centered + object-contain, with the
 *     dialog growing horizontally when a side panel is toggled — same
 *     pattern as PdfViewerDialog.
 *
 * # CSP
 *
 * Relies on `img-src 'self' blob: <storage>` covering the presigned
 * storage origin. Same dependency as the existing thumbnail rendering
 * in Drive, so this file inherits whatever directive Drive thumbnails
 * already work under — no new CSP entry required.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  FileText,
  Share2,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useIsAIFeatureOn } from "@/components/ai-feature";
import { DocChatPanel } from "@/components/doc-chat-panel";
import {
  fetchOcrProfiles,
  loadPreferredProfileSlug,
  rememberProfileSlug,
  type OcrProfile,
} from "@/lib/ocr-profiles";
import { cn } from "@/lib/utils";

export interface ImagePreviewDialogProps {
  fileId: string;
  fileName: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Optional: when provided, a Share button is rendered in the header
   *  that invokes this callback. Parent owns the actual ShareModal —
   *  same contract as the other preview dialogs. */
  onShare?: () => void;
}

// Which side panel is currently visible. At most one is open at a
// time so the image stays readable; flipping between them is a single
// state transition rather than two boolean toggles that could collide.
type SidePanel = "none" | "text" | "ai";

export function ImagePreviewDialog({
  fileId,
  fileName,
  open,
  onOpenChange,
  onShare,
}: ImagePreviewDialogProps) {
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);

  const [panel, setPanel] = useState<SidePanel>("none");
  // Extracted-text state. `null` = haven't requested yet, `""` = OCR
  // returned empty (rendered as a "no text found" message), non-empty
  // string = render the body. `loading` covers the request in flight.
  const [extractedText, setExtractedText] = useState<string | null>(null);
  const [extractLoading, setExtractLoading] = useState(false);
  const [extractTruncated, setExtractTruncated] = useState(false);
  // Structured fields + LLM-cleaned summary returned alongside the
  // raw text when a non-generic profile is in use. Both can be empty
  // (Generic profile, or AI off) and the panel renders the raw text
  // section regardless.
  const [extractFields, setExtractFields] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [extractCleaned, setExtractCleaned] = useState<string>("");

  // OCR profile picker state. The slug is rehydrated synchronously
  // from localStorage so the user's last choice is the one that ships
  // in the very first /extract-text request body — no need to round-trip
  // through an effect. Profile metadata is fetched lazily on first
  // dropdown open to avoid a network call on every dialog mount.
  const [profileSlug, setProfileSlug] = useState<string>(() =>
    loadPreferredProfileSlug(),
  );
  const [profiles, setProfiles] = useState<OcrProfile[]>([]);
  const ensureProfilesLoaded = useCallback(async () => {
    if (profiles.length > 0) return;
    try {
      const list = await fetchOcrProfiles();
      setProfiles(list);
    } catch {
      // Silent — picker stays empty, default profile still works.
    }
  }, [profiles.length]);
  const activeProfile = profiles.find((p) => p.slug === profileSlug);

  const aiAvailable = useIsAIFeatureOn("summarize");

  useEffect(() => {
    if (!open) {
      // Drop the URL on close so a re-open re-fetches a fresh
      // presigned URL — the previous one may have hit its (short)
      // TTL while the dialog was closed.
      setUrl(null);
      // Reset side-panel state so opening a different image doesn't
      // re-show stale extracted text from the previous file.
      setPanel("none");
      setExtractedText(null);
      setExtractLoading(false);
      setExtractTruncated(false);
      setExtractFields(null);
      setExtractCleaned("");
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
  // PdfViewerDialog/MediaPreviewDialog. Cross-origin presigned URLs
  // ignore `download` in Chrome but the API sets
  // Content-Disposition: attachment on presign so the browser saves
  // the file rather than opening it inline.
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

  // Fetch /extract-text and open the text panel. Cached after the
  // first successful call — re-clicking the button just toggles the
  // panel, doesn't re-OCR. Errors leave the panel hidden so the user
  // is dropped back to the image rather than staring at "failed."
  const openTextPanel = useCallback(async () => {
    // If we already have text, just show the panel.
    if (extractedText !== null) {
      setPanel("text");
      return;
    }
    setExtractLoading(true);
    setPanel("text");
    try {
      const r = await api<{
        text: string;
        mime: string;
        truncated: boolean;
        profile?: string;
        fields?: Record<string, unknown>;
        cleaned?: string;
      }>(`/v1/files/${fileId}/extract-text`, {
        method: "POST",
        body: JSON.stringify({ profile: profileSlug }),
      });
      setExtractedText(r.text);
      setExtractTruncated(r.truncated);
      setExtractFields(r.fields ?? null);
      setExtractCleaned(r.cleaned ?? "");
    } catch (e: any) {
      // 415 not_textual is expected for some fringe MIMEs (e.g. SVG
      // shouldn't even reach this dialog, but just in case). Surface
      // it as a toast and close the panel rather than rendering a
      // broken state.
      toast.show("error", "Couldn't read text", {
        description: e.message,
      });
      setPanel("none");
    } finally {
      setExtractLoading(false);
    }
  }, [extractedText, fileId, profileSlug, toast]);

  // Picking a different profile invalidates the cached OCR result —
  // a Receipt extraction is meaningless to someone who just switched
  // to Aadhaar. Next click on Extract Text re-OCRs with the new
  // tuning. Persist the choice so the next file inherits it.
  const onPickProfile = useCallback((slug: string) => {
    setProfileSlug(slug);
    rememberProfileSlug(slug);
    setExtractedText(null);
    setExtractFields(null);
    setExtractCleaned("");
    setExtractTruncated(false);
  }, []);

  // Toggle handlers for the two header buttons. Symmetric: clicking
  // the active button closes the panel; clicking the inactive one
  // switches sides.
  const onClickExtract = useCallback(() => {
    if (panel === "text") {
      setPanel("none");
      return;
    }
    void openTextPanel();
  }, [panel, openTextPanel]);

  const onClickAI = useCallback(() => {
    setPanel((p) => (p === "ai" ? "none" : "ai"));
  }, []);

  const sidePanelVisible = panel !== "none";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "w-[95vw] h-[88vh] gap-0 overflow-hidden p-0",
          "flex flex-col",
          // Same widening rule as PdfViewerDialog: panel closed =
          // 1100px so the image fills the dialog edge-to-edge; panel
          // open = 1500px so there's room for the side content
          // without crushing the image.
          sidePanelVisible ? "max-w-[1500px]" : "max-w-[1100px]",
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

              {/* Fast OCR-only button. Filled (primary) when closed
                  so it reads as the recommended action — extracting
                  text is the cheap, deterministic operation users
                  almost always want first. Switches to outline when
                  active so the panel toggle role is obvious. Always
                  available; not gated on AI being enabled because
                  /extract-text is a pure tesseract call. The chevron
                  to its right opens the document-type picker so the
                  user can tune OCR for Aadhaar/PAN/Receipt before the
                  request fires. */}
              <div className="flex items-center">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant={panel === "text" ? "outline" : "default"}
                      size="sm"
                      onClick={onClickExtract}
                      disabled={extractLoading}
                      className="gap-1.5 rounded-r-none border-r-0"
                      aria-pressed={panel === "text"}
                    >
                      <FileText className="h-4 w-4" />
                      <span>
                        {panel === "text"
                          ? "Hide text"
                          : extractLoading
                            ? "Reading…"
                            : "Extract text"}
                      </span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {activeProfile ? (
                      <span>
                        Extract using the <b>{activeProfile.name}</b>{" "}
                        preset.
                      </span>
                    ) : (
                      "Read the text in this image with OCR. Fast — no AI involved."
                    )}
                  </TooltipContent>
                </Tooltip>
                <DropdownMenu
                  onOpenChange={(open) => {
                    if (open) void ensureProfilesLoaded();
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant={panel === "text" ? "outline" : "default"}
                      size="sm"
                      className="rounded-l-none px-1.5"
                      aria-label="Pick a document type"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-72">
                    <DropdownMenuLabel>Document type</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {profiles.length === 0 ? (
                      <DropdownMenuItem
                        onClick={() => onPickProfile("generic")}
                        className="flex flex-col items-start gap-0.5"
                      >
                        <span className="font-medium">Generic Document</span>
                        <span className="text-[11px] text-muted-foreground">
                          Default OCR for any document.
                        </span>
                      </DropdownMenuItem>
                    ) : (
                      profiles.map((p) => (
                        <DropdownMenuItem
                          key={p.slug}
                          onClick={() => onPickProfile(p.slug)}
                          className="flex flex-col items-start gap-0.5"
                        >
                          <span className="flex w-full items-center justify-between gap-2 font-medium">
                            <span>{p.name}</span>
                            {p.slug === profileSlug ? (
                              <Check className="h-3.5 w-3.5 text-primary" />
                            ) : null}
                          </span>
                          {p.description ? (
                            <span className="text-[11px] leading-snug text-muted-foreground">
                              {p.description}
                            </span>
                          ) : null}
                        </DropdownMenuItem>
                      ))
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {/* Slower LLM button. Outline so it doesn't compete
                  with Extract text for primary attention; gated on
                  the operator having AI enabled because the panel
                  hits /summarize and /ask which require a chat
                  model. */}
              {aiAvailable ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant={panel === "ai" ? "default" : "outline"}
                      size="sm"
                      onClick={onClickAI}
                      className="gap-1.5"
                      aria-pressed={panel === "ai"}
                    >
                      <Sparkles className="h-4 w-4" />
                      <span>
                        {panel === "ai" ? "Hide assistant" : "Summarize / Ask"}
                      </span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Generate a written summary or ask questions about
                    this image. Slower — uses an AI model.
                  </TooltipContent>
                </Tooltip>
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
                <TooltipContent>Save image to your device</TooltipContent>
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

        {/* Body — image + optional side panel ------------------------ */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-muted/40 p-4">
            {url ? (
              // object-contain so a 4000x3000 phone photo fits without
              // distortion; max-h/max-w cap so a tiny 200x200 thumbnail
              // doesn't get upscaled into a blurry mural. The browser
              // honours EXIF orientation (image-orientation: from-image
              // is the default in modern browsers) so a portrait phone
              // photo lands the right way up without us touching it.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={url}
                alt={fileName}
                className="max-h-full max-w-full object-contain"
                // Decoding async lets the dialog show even before the
                // (potentially large) image finishes decoding — the
                // grid placement keeps the layout stable.
                decoding="async"
              />
            ) : (
              <div className="text-sm text-muted-foreground">
                Loading preview…
              </div>
            )}
          </div>
          {panel === "text" ? (
            <ExtractedTextPanel
              loading={extractLoading}
              text={extractedText}
              truncated={extractTruncated}
              fields={extractFields}
              cleaned={extractCleaned}
              profileSlug={profileSlug}
              profileName={activeProfile?.name ?? null}
              onClose={() => setPanel("none")}
            />
          ) : null}
          {panel === "ai" && aiAvailable ? (
            <DocChatPanel
              fileId={fileId}
              fileName={fileName}
              open={open && panel === "ai"}
              onClose={() => setPanel("none")}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Side panel rendering the OCR'd text. Kept inline (not a separate
 * file) because it has zero reuse outside this dialog and its API
 * surface is just the props.
 *
 * Layout mirrors DocChatPanel's column shape (border-l, fixed width)
 * so flipping between the two doesn't shift the image's resting
 * position — minor detail but keeps the dialog from feeling jumpy.
 */
function ExtractedTextPanel({
  loading,
  text,
  truncated,
  fields,
  cleaned,
  profileSlug,
  profileName,
  onClose,
}: {
  loading: boolean;
  text: string | null;
  truncated: boolean;
  fields: Record<string, unknown> | null;
  cleaned: string;
  profileSlug: string;
  profileName: string | null;
  onClose: () => void;
}) {
  // Strip empty/null/undefined values up front so the table doesn't
  // render rows with a blank value column. The backend already drops
  // these but a defensive filter keeps the renderer simple.
  const fieldRows = fields
    ? Object.entries(fields).filter(
        ([, v]) => v !== null && v !== undefined && String(v).trim() !== "",
      )
    : [];
  const toast = useToast();
  // Two-second checkmark flash after a successful copy. The
  // navigator.clipboard call returns synchronously on success but the
  // affordance is invisible without UI feedback; users have asked for
  // this kind of confirmation across the app.
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (e: any) {
      toast.show("error", "Couldn't copy", { description: e.message });
    }
  }, [text, toast]);

  return (
    <aside className="flex h-full w-[400px] flex-col border-l bg-background">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Extracted text</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCopy}
            disabled={!text || loading}
            className="h-7 gap-1 px-2"
            aria-label="Copy extracted text"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" />
                <span className="text-xs">Copied</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                <span className="text-xs">Copy</span>
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close text panel"
            className="h-7 w-7"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="p-3 text-sm text-muted-foreground">
            Reading text from image…
          </div>
        ) : text === null ? (
          // Should never render in practice — panel only mounts after
          // openTextPanel sets state — but keeps the type narrowing
          // honest.
          <div className="p-3 text-sm text-muted-foreground">No text yet.</div>
        ) : text.trim() === "" ? (
          <div className="p-3 text-sm text-muted-foreground">
            No readable text was found in this image. The photo may be
            too blurry, low-contrast, or contain only graphics.
          </div>
        ) : (
          <>
            {profileSlug && profileSlug !== "generic" ? (
              <div className="border-b bg-muted/40 px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                Extracted as {profileName ?? profileSlug}
              </div>
            ) : null}

            {fieldRows.length > 0 ? (
              <div className="border-b px-3 py-2">
                <div className="mb-1.5 text-xs font-medium text-foreground">
                  Fields
                </div>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
                  {fieldRows.map(([k, v]) => (
                    <ImageFieldRow key={k} label={k} value={String(v)} />
                  ))}
                </dl>
              </div>
            ) : null}

            {cleaned ? (
              <div className="border-b px-3 py-2">
                <div className="mb-1.5 text-xs font-medium text-foreground">
                  AI-cleaned summary
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground">
                  {cleaned}
                </pre>
              </div>
            ) : null}

            <div className="px-3 py-3">
              <div className="mb-1.5 text-xs font-medium text-foreground">
                Raw text
              </div>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                {text}
              </pre>
            </div>
          </>
        )}
      </div>
      {truncated ? (
        <div className="border-t bg-amber-50 px-3 py-2 text-[11px] text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Output was truncated. Long documents are clipped to keep
          the response fast.
        </div>
      ) : null}
    </aside>
  );
}

/** Single label/value row in the structured-fields table. The label
 *  is humanised from the key client-side so the backend doesn't have
 *  to ship a separate label dictionary. */
function ImageFieldRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{humanFieldLabel(label)}</dt>
      <dd className="break-words font-medium">{value}</dd>
    </>
  );
}

function humanFieldLabel(key: string): string {
  return key
    .split("_")
    .map((part) => {
      const lower = part.toLowerCase();
      // Common abbreviations look weird title-cased.
      if (
        lower === "dob" ||
        lower === "pan" ||
        lower === "dl" ||
        lower === "gst" ||
        lower === "vat"
      ) {
        return part.toUpperCase();
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}
