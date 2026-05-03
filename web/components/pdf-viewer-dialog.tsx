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

import { useCallback, useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  FileText,
  Sparkles,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
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
import { PdfPreview } from "@/components/acroform/pdf-preview";
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

// One side panel at a time — keeps the dialog readable and avoids
// having to budget for two ~400px columns plus the PDF body.
type PdfSidePanel = "none" | "text" | "ai";

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
  /** Optional file ID. When provided AND the operator has AI's
   *  `summarize` feature enabled, the dialog renders an AI side panel
   *  toggle (and the panel itself when toggled on). Generated-PDF
   *  previews leave this unset because there's no persisted file row
   *  to summarise. */
  aiFileId?: string;
}

export function PdfViewerDialog({
  open,
  onOpenChange,
  url,
  fileName,
  subtitle,
  actions,
  showDownload = true,
  aiFileId,
}: PdfViewerDialogProps) {
  // Side panel visibility. Off-by-default so the dialog opens at its
  // historical width; toggling on slides the panel out and the PDF
  // body re-flows into the remaining space (PdfPreview measures its
  // container, so it auto-resizes without explicit prop wiring).
  const [panel, setPanel] = useState<PdfSidePanel>("none");
  const aiAvailable = useIsAIFeatureOn("summarize") && !!aiFileId;
  const textAvailable = !!aiFileId; // /extract-text doesn't need AI
  const toast = useToast();
  // Cached extract-text output. `null` = not requested yet, `""` =
  // server returned empty (rendered as a "no text found" message),
  // non-empty = the body. We keep it across panel toggles so flipping
  // back to the text panel doesn't re-OCR.
  const [text, setText] = useState<string | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [textTruncated, setTextTruncated] = useState(false);
  const [textCopied, setTextCopied] = useState(false);
  // Structured fields + LLM-cleaned summary returned alongside the
  // raw text when a non-generic profile is in use. Both can be empty
  // (Generic profile, or AI off) and the panel renders the raw text
  // section regardless.
  const [textFields, setTextFields] = useState<Record<string, unknown> | null>(
    null,
  );
  const [textCleaned, setTextCleaned] = useState<string>("");

  // OCR profile picker state. Slug rehydrated synchronously from
  // localStorage so the user's last choice ships in the very first
  // /extract-text request body. Profile metadata fetched lazily on
  // first dropdown open.
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
      // Picker stays empty; default profile still works.
    }
  }, [profiles.length]);
  const activeProfile = profiles.find((p) => p.slug === profileSlug);
  // Reset the panel-open state when the dialog itself closes — opening
  // the dialog on a new file should not re-show the panel just
  // because the previous file had it open.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setPanel("none");
        setText(null);
        setTextLoading(false);
        setTextTruncated(false);
        setTextCopied(false);
        setTextFields(null);
        setTextCleaned("");
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  // Fire /extract-text on first open of the text panel; subsequent
  // opens reuse the cached body. Cache key is implicitly (aiFileId,
  // profileSlug) — switching profile clears the cache via onPickProfile
  // below so the next click re-OCRs with the new tuning.
  const openTextPanel = useCallback(async () => {
    if (!aiFileId) return;
    if (text !== null) {
      setPanel("text");
      return;
    }
    setPanel("text");
    setTextLoading(true);
    try {
      const r = await api<{
        text: string;
        mime: string;
        truncated: boolean;
        profile?: string;
        fields?: Record<string, unknown>;
        cleaned?: string;
      }>(`/v1/files/${aiFileId}/extract-text`, {
        method: "POST",
        body: JSON.stringify({ profile: profileSlug }),
      });
      setText(r.text);
      setTextTruncated(r.truncated);
      setTextFields(r.fields ?? null);
      setTextCleaned(r.cleaned ?? "");
    } catch (e: any) {
      toast.show("error", "Couldn't read text", { description: e.message });
      setPanel("none");
    } finally {
      setTextLoading(false);
    }
  }, [aiFileId, profileSlug, text, toast]);

  // Picking a different profile invalidates the cached OCR result —
  // a Receipt extraction is meaningless to someone who just switched
  // to a different document type. Persist the choice so the next file
  // inherits it.
  const onPickProfile = useCallback((slug: string) => {
    setProfileSlug(slug);
    rememberProfileSlug(slug);
    setText(null);
    setTextFields(null);
    setTextCleaned("");
    setTextTruncated(false);
  }, []);

  const onCopyText = useCallback(async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setTextCopied(true);
      window.setTimeout(() => setTextCopied(false), 2000);
    } catch (e: any) {
      toast.show("error", "Couldn't copy", { description: e.message });
    }
  }, [text, toast]);
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
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        // The Dialog needs to be big — PdfPreview fits to its container
        // width. We also want it vertically tall so the full page is
        // visible without scrolling the modal itself. When the AI
        // panel is toggled on we widen the max width so the PDF
        // doesn't squeeze too narrow on smaller laptops.
        className={cn(
          "w-[95vw] h-[92vh] p-0 gap-0 overflow-hidden",
          "flex flex-col",
          panel !== "none" ? "max-w-[1500px]" : "max-w-[1100px]",
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
              {/* Fast OCR-only path. Always shown when we have a
                  file ID — pure OCR sidecar, no LLM required.
                  Sub-second for typical text-extractable PDFs; for
                  image-only scans it round-trips through the
                  PaddleOCR sidecar (PDF rasterized + PP-OCRv4
                  detection/recognition) which adds a couple of
                  seconds per page. */}
              {textAvailable ? (
                <div className="flex items-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={panel === "text" ? "default" : "outline"}
                        size="sm"
                        onClick={() =>
                          panel === "text"
                            ? setPanel("none")
                            : void openTextPanel()
                        }
                        disabled={textLoading}
                        className="gap-1.5 rounded-r-none border-r-0"
                        aria-pressed={panel === "text"}
                      >
                        <FileText className="h-4 w-4" />
                        <span className="hidden sm:inline">
                          {panel === "text"
                            ? "Hide text"
                            : textLoading
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
                        "Read the text in this document with OCR. Fast — no AI involved."
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
                        variant={panel === "text" ? "default" : "outline"}
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
              ) : null}
              {aiAvailable ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant={panel === "ai" ? "default" : "outline"}
                      size="sm"
                      onClick={() =>
                        setPanel((p) => (p === "ai" ? "none" : "ai"))
                      }
                      className="gap-1.5"
                      aria-pressed={panel === "ai"}
                    >
                      <Sparkles className="h-4 w-4" />
                      <span className="hidden sm:inline">
                        {panel === "ai" ? "Hide AI" : "Summarize / Ask"}
                      </span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    AI summary &amp; Q&amp;A about this document
                  </TooltipContent>
                </Tooltip>
              ) : null}
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

        {/* Body — the PDF itself, plus the AI panel when toggled on. */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="min-h-0 flex-1 overflow-hidden bg-muted/30">
            {url ? (
              <PdfPreview url={url} overlayForPage={() => null} />
            ) : (
              <div className="grid h-full place-items-center text-sm text-muted-foreground">
                Loading preview…
              </div>
            )}
          </div>
          {panel === "text" && aiFileId ? (
            <ExtractedTextPanel
              loading={textLoading}
              text={text}
              truncated={textTruncated}
              copied={textCopied}
              fields={textFields}
              cleaned={textCleaned}
              profileSlug={profileSlug}
              profileName={activeProfile?.name ?? null}
              onCopy={onCopyText}
              onClose={() => setPanel("none")}
            />
          ) : null}
          {panel === "ai" && aiAvailable && aiFileId ? (
            <DocChatPanel
              fileId={aiFileId}
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

/** Side panel for the OCR'd text. Mirrors the layout used in
 *  ImagePreviewDialog so the two preview surfaces feel symmetric. */
function ExtractedTextPanel({
  loading,
  text,
  truncated,
  copied,
  fields,
  cleaned,
  profileSlug,
  profileName,
  onCopy,
  onClose,
}: {
  loading: boolean;
  text: string | null;
  truncated: boolean;
  copied: boolean;
  fields: Record<string, unknown> | null;
  cleaned: string;
  profileSlug: string;
  profileName: string | null;
  onCopy: () => void;
  onClose: () => void;
}) {
  // Strip empty/null/undefined values up front so the table never
  // renders a row with a blank value column. The backend already
  // drops these but a defensive filter keeps the renderer simple.
  const fieldRows = fields
    ? Object.entries(fields).filter(
        ([, v]) => v !== null && v !== undefined && String(v).trim() !== "",
      )
    : [];
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
            Reading text from document…
          </div>
        ) : text === null ? (
          <div className="p-3 text-sm text-muted-foreground">No text yet.</div>
        ) : text.trim() === "" ? (
          <div className="p-3 text-sm text-muted-foreground">
            No readable text was found. The document may be scanned at low
            resolution or contain only graphics.
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
                    <PdfFieldRow key={k} label={k} value={String(v)} />
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
          Output was truncated. Long documents are clipped to keep the
          response fast.
        </div>
      ) : null}
    </aside>
  );
}

/** Single label/value row in the structured-fields table. The label
 *  is humanised from the key client-side so the backend doesn't have
 *  to ship a separate label dictionary. */
function PdfFieldRow({ label, value }: { label: string; value: string }) {
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
