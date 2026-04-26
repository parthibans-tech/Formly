"use client";

/**
 * DocAITools — the "Extract text" + "Summarize / Ask" pair of header
 * buttons, packaged as a single drop-in toolbar so any designer or
 * preview surface can offer both affordances without re-implementing
 * the wiring.
 *
 * Why this lives in its own component:
 *   - Drive's image preview, PDF preview, and every template designer
 *     (static / html / markdown / image / acroform / doc) all want the
 *     same two buttons in their header. Re-coding the state machine
 *     (request, cache, panel toggle, copy-to-clipboard, AI gate) inside
 *     each of them was the previous pattern and it diverged immediately
 *     — Image preview had Extract text + Summarize, PDF preview only
 *     had Summarize, the designers had nothing.
 *   - Designers already own complex headers + side panels (schema
 *     panel, mappings, layers). A bolted-on side panel would collide
 *     with those layouts. Sheets (right-side drawers) overlay the
 *     viewport and don't perturb the underlying surface, which is
 *     why this component uses Sheets instead of inlined `<aside>`
 *     panels like the preview dialogs do.
 *
 * # Document-type profiles
 *
 * Users can pick a "document type" (Aadhaar, PAN, Receipt, Generic…)
 * via a dropdown attached to the Extract-text button. The selection
 * is persisted in localStorage so the next click on a similar file
 * inherits it. The chosen profile drives:
 *
 *   - Tesseract knobs (PSM, language, preprocessing) tuned for that
 *     document family.
 *   - Regex extractors that pull structured fields (Aadhaar number,
 *     name, DOB) out of the raw OCR.
 *   - An optional LLM cleanup pass that fixes O↔0 / I↔1 mistranscriptions
 *     and returns a typed JSON payload.
 *
 * The UI overlays the result drawer with a Fields table on top and
 * the raw text below, so users can see both views at once without
 * having to toggle.
 *
 * Contract:
 *   <DocAITools fileId="…" fileName="…" />
 *
 *   - `fileId`     required, drives /extract-text + /summarize + /ask
 *   - `fileName`   shown as the Sheet title; falls back to "Document"
 *                  if empty so the title bar never collapses
 *   - `compact`    optional; when true the buttons render icon-only
 *                  with tooltips for ultra-narrow headers (image
 *                  designer toolbar, mobile breakpoints)
 *   - `disabled`   optional; mirror the parent's read-only / loading
 *                  state so a viewer-shared template can't fire OCR
 *                  against a file they may not have grant for. The
 *                  buttons stay visible (less surprising than a
 *                  vanishing toolbar) but become inert.
 *
 * Endpoints consumed:
 *   GET  /v1/ocr/profiles               → { profiles: [...] }
 *   POST /v1/files/{id}/extract-text    → { text, mime, truncated, profile, fields, cleaned }
 *   POST /v1/files/{id}/summarize       via DocChatPanel
 *   POST /v1/files/{id}/ask             via DocChatPanel
 */

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  FileText,
  Sparkles,
} from "lucide-react";

import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/components/toast";
import { useIsAIFeatureOn } from "@/components/ai-feature";
import { DocChatPanel } from "@/components/doc-chat-panel";
import {
  fetchOcrProfiles,
  loadPreferredProfileSlug,
  rememberProfileSlug,
  type OcrProfile,
} from "@/lib/ocr-profiles";

export interface DocAIToolsProps {
  fileId: string;
  fileName?: string;
  /** Render icon-only buttons (with tooltips). Useful when slotting
   *  into a dense toolbar. Defaults to false (icon + label). */
  compact?: boolean;
  /** Make both buttons inert without hiding them. */
  disabled?: boolean;
  /** Optional className for the wrapper. */
  className?: string;
}

export function DocAITools({
  fileId,
  fileName,
  compact = false,
  disabled = false,
  className,
}: DocAIToolsProps) {
  const toast = useToast();
  const aiAvailable = useIsAIFeatureOn("summarize");

  // Profile registry. Loaded lazily on first dropdown open (we don't
  // want every designer mount to fire a /v1/ocr/profiles request) but
  // the *selected slug* is rehydrated from localStorage immediately so
  // the request body we send in onOpenText reflects the user's last
  // pick on the very first click.
  const [profiles, setProfiles] = useState<OcrProfile[]>([]);
  const [profileSlug, setProfileSlug] = useState<string>(() =>
    loadPreferredProfileSlug(),
  );
  const ensureProfilesLoaded = useCallback(async () => {
    if (profiles.length > 0) return;
    try {
      const list = await fetchOcrProfiles();
      setProfiles(list);
    } catch {
      // Quiet failure — the dropdown stays empty (showing only the
      // default option) and Extract still works. The picker isn't
      // critical to the feature.
    }
  }, [profiles.length]);

  // Sheet open-state. We keep them as separate booleans (rather than
  // a single "which panel" union) so the Sheets' own animation /
  // unmount lifecycle is independent — closing one shouldn't trigger
  // a re-render that disturbs the other.
  const [textOpen, setTextOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  // Cached extract result, keyed implicitly by (fileId, profileSlug):
  // the cache is invalidated whenever the user picks a different
  // profile so the next open re-runs OCR with the new tuning.
  const [text, setText] = useState<string | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [textTruncated, setTextTruncated] = useState(false);
  const [fields, setFields] = useState<Record<string, unknown> | null>(null);
  const [cleaned, setCleaned] = useState<string>("");
  const [resultProfile, setResultProfile] = useState<string>("");

  // Reset cached output when the chosen profile changes — a Receipt
  // result wouldn't be useful to anyone who just switched to Aadhaar.
  useEffect(() => {
    setText(null);
    setFields(null);
    setCleaned("");
    setResultProfile("");
    setTextTruncated(false);
  }, [profileSlug]);

  // First-open of the text sheet triggers the OCR call. Subsequent
  // opens just re-show the cached body so re-clicking is instant.
  const onOpenText = useCallback(async () => {
    setTextOpen(true);
    if (text !== null || textLoading) return;
    setTextLoading(true);
    try {
      const r = await api<ExtractTextResp>(
        `/v1/files/${fileId}/extract-text`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: profileSlug }),
        },
      );
      setText(r.text);
      setTextTruncated(r.truncated);
      setFields(r.fields ?? null);
      setCleaned(r.cleaned ?? "");
      setResultProfile(r.profile ?? profileSlug);
    } catch (e: any) {
      // Common: 415 not_textual when the file's bytes aren't
      // text-extractable (e.g. encrypted PDF, plain video). Surface
      // as a toast and bail out of the sheet so the user isn't left
      // staring at a perpetual "Reading…" state.
      toast.show("error", "Couldn't read text", { description: e.message });
      setTextOpen(false);
    } finally {
      setTextLoading(false);
    }
  }, [fileId, profileSlug, text, textLoading, toast]);

  // Picking a profile from the dropdown. Updates the selection +
  // persists it; the cache-reset effect above wipes any stale result
  // so the next Extract click re-OCRs with the new tuning.
  const onPickProfile = useCallback((slug: string) => {
    setProfileSlug(slug);
    rememberProfileSlug(slug);
  }, []);

  const activeProfile = profiles.find((p) => p.slug === profileSlug);

  return (
    <TooltipProvider delayDuration={200}>
      <div className={className ?? "flex items-center gap-1.5"}>
        {/* Extract-text + profile picker combo. The profile dropdown
            sits flush against the Extract button so it reads as one
            "Extract text [▼ profile]" affordance. */}
        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={onOpenText}
                disabled={disabled || textLoading}
                className="gap-1.5 rounded-r-none border-r-0"
                aria-label="Extract text"
              >
                <FileText className="h-4 w-4" />
                {compact ? null : (
                  <span className="hidden sm:inline">
                    {textLoading ? "Reading…" : "Extract text"}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {activeProfile ? (
                <span>
                  Extract using the <b>{activeProfile.name}</b> preset.
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
                variant="outline"
                size="sm"
                disabled={disabled}
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

        {/* Summarize / Ask — gated on the operator having AI on. */}
        {aiAvailable ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAiOpen(true)}
                disabled={disabled}
                className="gap-1.5"
                aria-label="Summarize or ask about this document"
              >
                <Sparkles className="h-4 w-4" />
                {compact ? null : (
                  <span className="hidden sm:inline">Summarize / Ask</span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Generate a written summary or ask questions. Slower — uses an
              AI model.
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      {/* Extract-text drawer ----------------------------------------- */}
      <Sheet open={textOpen} onOpenChange={setTextOpen}>
        <SheetContent
          side="right"
          // 520px is wider than the legacy text-only drawer because we
          // also render the structured-fields table on top — receipts
          // and IDs both have wide value columns and benefit from the
          // extra horizontal room.
          className="w-full sm:max-w-[520px] gap-0 p-0 flex flex-col"
        >
          <SheetHeader className="flex flex-row items-center justify-between gap-2 border-b">
            <div className="flex min-w-0 items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <SheetTitle className="truncate">
                {fileName ? `Text in ${fileName}` : "Extracted text"}
              </SheetTitle>
            </div>
            <CopyButton text={text} disabled={!text || textLoading} />
          </SheetHeader>
          <ExtractedTextBody
            loading={textLoading}
            text={text}
            truncated={textTruncated}
            fields={fields}
            cleaned={cleaned}
            profileSlug={resultProfile}
            profileName={
              profiles.find((p) => p.slug === resultProfile)?.name ?? null
            }
          />
        </SheetContent>
      </Sheet>

      {/* Summarize / Ask drawer -------------------------------------- */}
      {aiAvailable ? (
        <Sheet open={aiOpen} onOpenChange={setAiOpen}>
          <SheetContent
            side="right"
            // 460px matches the natural width of DocChatPanel inside
            // PdfViewerDialog so the panel proportions feel consistent
            // when users hop between Drive preview and a designer.
            className="w-full sm:max-w-[460px] gap-0 p-0"
          >
            <SheetHeader className="flex flex-row items-center gap-2 border-b">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              <SheetTitle className="truncate">
                {fileName ? `Ask about ${fileName}` : "Summarize / Ask"}
              </SheetTitle>
            </SheetHeader>
            {/* DocChatPanel handles its own scroll + composer +
                summary auto-fire. We feed it the same `open` state
                so it resets turns when the sheet closes. */}
            <div className="min-h-0 flex-1 overflow-hidden">
              <DocChatPanel
                fileId={fileId}
                fileName={fileName ?? "Document"}
                open={aiOpen}
                onClose={() => setAiOpen(false)}
              />
            </div>
          </SheetContent>
        </Sheet>
      ) : null}
    </TooltipProvider>
  );
}

type ExtractTextResp = {
  text: string;
  mime: string;
  truncated: boolean;
  profile?: string;
  fields?: Record<string, unknown>;
  cleaned?: string;
};

/** Inline copy-to-clipboard button with a 2-second checkmark flash. */
function CopyButton({
  text,
  disabled,
}: {
  text: string | null;
  disabled: boolean;
}) {
  const toast = useToast();
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
    <Button
      variant="ghost"
      size="sm"
      onClick={onCopy}
      disabled={disabled}
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
  );
}

function ExtractedTextBody({
  loading,
  text,
  truncated,
  fields,
  cleaned,
  profileSlug,
  profileName,
}: {
  loading: boolean;
  text: string | null;
  truncated: boolean;
  fields: Record<string, unknown> | null;
  cleaned: string;
  profileSlug: string;
  profileName: string | null;
}) {
  const fieldRows = fields
    ? Object.entries(fields).filter(
        ([, v]) => v !== null && v !== undefined && String(v).trim() !== "",
      )
    : [];
  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="p-3 text-sm text-muted-foreground">
            Reading text from document…
          </div>
        ) : text === null ? (
          <div className="p-3 text-sm text-muted-foreground">No text yet.</div>
        ) : text.trim() === "" ? (
          <div className="p-3 text-sm text-muted-foreground">
            No readable text was found in this document. The file may be
            blurry, low-contrast, or contain only graphics.
          </div>
        ) : (
          <>
            {/* Profile + structured fields header. We render this
                even when the profile produced no fields (Generic) so
                the user has a visible signal of which preset ran. */}
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
                    <FieldRow key={k} label={k} value={String(v)} />
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
    </>
  );
}

/** One label/value row in the structured-fields table. The label is
 *  humanised from the key (`aadhaar_number` → "Aadhaar Number") so
 *  the backend doesn't have to ship a separate label dictionary. */
function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{humanLabel(label)}</dt>
      <dd className="break-words font-medium">{value}</dd>
    </>
  );
}

function humanLabel(key: string): string {
  return key
    .split("_")
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "dob" || lower === "pan" || lower === "dl" || lower === "gst" || lower === "vat") {
        return part.toUpperCase();
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}
