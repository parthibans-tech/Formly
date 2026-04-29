"use client";

/**
 * StarterFillPage — resume.io-style two-pane layout.
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ Logo · Title · Lang  │  Edit Customize AI Review Tailor │ Download│
 *   ├──────────────────────────────┬──────────────────────────────────┤
 *   │ Completeness                 │                                   │
 *   │ AI shortcut cards            │   Live preview (a single page)    │
 *   │ Personal details (form)      │                                   │
 *   │ Experience (cards)           │                                   │
 *   │ ...                          │   Design picker · 1/N · zoom      │
 *   └──────────────────────────────┴──────────────────────────────────┘
 *
 * Tabs other than `edit` swap the left pane contents (customize / AI review)
 * while the live preview keeps rendering on the right. Customize state and
 * any `data` mutations from review-suggestion "Apply" buttons feed back into
 * the same preview so the user sees their effects immediately.
 *
 * The Download and Save-to-Drive buttons hand the current HTML, data, and
 * customize blob to the backend (`/v1/starters/{id}/export` and
 * `/v1/starters/{id}/save-to-drive`). Starter HTML lives in TS, so we ship
 * it inline rather than maintaining a starters table on the server.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleX,
  Cloud,
  Copy,
  Download,
  FileText,
  Loader2,
  Palette,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { miniRender } from "@/lib/starters/mini-render";
import { autoSchemaFromSample } from "@/lib/starters/auto-schema";
import type { FormSchema, Starter } from "@/lib/starters/types";
import { StarterFillForm } from "./fill-form";
import { useAIConfig } from "@/hooks/use-ai-config";
import { ApiError } from "@/lib/api";
import {
  type CoverLetterPayload,
  type ReviewResponse,
  type ReviewSection,
  type ReviewStatus,
  exportStarter,
  generateCoverLetter,
  generateProfileSummary,
  reviewResume,
  saveStarterToDrive,
} from "@/lib/starter-ai";
import { recalcBilling, type RecalcItem } from "@/lib/starter-billing";
import { StarterApiGuideSheet } from "@/components/starter-api-guide-trigger";

type Tab = "edit" | "customize" | "review";

interface Customize {
  primary?: string;
  accent?: string;
  font?: "sans" | "serif" | "display";
  density?: "compact" | "normal" | "comfy";
}

interface Props {
  starter: Starter;
  alternates?: Starter[];
  // Kept for backwards-compat with callers that still pass it; the page now
  // uses the export endpoint directly so this is effectively unused.
  onUse?: (data: Record<string, unknown>) => void | Promise<void>;
}

export function StarterFillPage({ starter, alternates = [] }: Props) {
  const router = useRouter();
  const toast = useToast();
  const ai = useAIConfig();

  const [data, setData] = useState<Record<string, unknown>>(
    () => structuredClone(starter.sampleData),
  );
  const [activeId, setActiveId] = useState(starter.id);
  const [tab, setTab] = useState<Tab>("edit");
  const [designOpen, setDesignOpen] = useState(false);

  const [customize, setCustomize] = useState<Customize>({});
  const [summaryAlts, setSummaryAlts] = useState<string[]>([]);
  const [coverLetter, setCoverLetter] = useState<CoverLetterPayload | null>(
    null,
  );
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [targetRole, setTargetRole] = useState("");

  const [busyExport, setBusyExport] = useState(false);
  const [busySave, setBusySave] = useState(false);
  const [busySummary, setBusySummary] = useState(false);
  const [busyCover, setBusyCover] = useState(false);
  const [busyReview, setBusyReview] = useState(false);
  const [busyRecalc, setBusyRecalc] = useState(false);

  const all = useMemo(() => [starter, ...alternates], [starter, alternates]);
  const active = useMemo(
    () => all.find((s) => s.id === activeId) ?? starter,
    [all, activeId, starter],
  );

  // Apply customize to the raw template *before* templating runs, so the
  // user's color / font / density choices persist all the way through the
  // pipeline (preview iframe AND the chromium-rendered PDF on the server,
  // because we send this same transformed HTML in the export payload).
  // Falls back to the original HTML when customize is empty so the common
  // path stays allocation-free.
  const themedHtml = useMemo(
    () => applyCustomize(active.html, customize),
    [active.html, customize],
  );

  // Merge __theme into the data tree too — future starters that reference
  // {{ .__theme.* }} get the same blob, no extra work.
  const previewData = useMemo(() => {
    if (!hasCustomize(customize)) return data;
    return { ...data, __theme: customize };
  }, [data, customize]);

  const previewHtml = useMemo(
    () => miniRender(themedHtml, previewData),
    [themedHtml, previewData],
  );

  const schema: FormSchema = useMemo(
    () =>
      active.formSchema ??
      autoSchemaFromSample(active.sampleData as Record<string, unknown>),
    [active.formSchema, active.sampleData],
  );

  const completeness = useMemo(
    () => scoreCompleteness(data, schema),
    [data, schema],
  );

  const aiSummaryEnabled = ai.enabled && ai.features.summarize;

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  async function runProfileSummary() {
    if (busySummary) return;
    setBusySummary(true);
    try {
      const res = await generateProfileSummary({
        starterId: active.id,
        data,
        tone: "confident",
        length: "medium",
        targetRole: targetRole || undefined,
      });
      setData((d) => ({ ...d, summary: res.summary }));
      setSummaryAlts(res.alternatives ?? []);
      toast.show("success", "Profile summary updated");
    } catch (e) {
      toast.show("error", aiErrorMessage(e, "Couldn't generate summary"));
    } finally {
      setBusySummary(false);
    }
  }

  async function runCoverLetter() {
    if (busyCover) return;
    setBusyCover(true);
    try {
      const res = await generateCoverLetter({
        starterId: active.id,
        data,
        tone: "warm",
        length: "medium",
        format: "html",
      });
      setCoverLetter(res.coverLetter);
    } catch (e) {
      toast.show("error", aiErrorMessage(e, "Couldn't draft cover letter"));
    } finally {
      setBusyCover(false);
    }
  }

  async function runReview() {
    if (busyReview) return;
    setBusyReview(true);
    try {
      const res = await reviewResume({
        starterId: active.id,
        data,
        targetRole: targetRole || undefined,
      });
      setReview(res);
    } catch (e) {
      toast.show("error", aiErrorMessage(e, "Couldn't review resume"));
    } finally {
      setBusyReview(false);
    }
  }

  // Recalc — Billing-category only. Reads `items[]` out of the active
  // starter's data tree, asks the server to compute subtotal / tax /
  // total under a stable rounding rule, and writes the totals back into
  // the same shape the invoice/quote/receipt templates expect
  // (`invoice.tax`, `invoice.total` for invoice; `quote.*` for quote).
  // Live preview re-renders automatically because we mutate `data`.
  async function runRecalc() {
    if (busyRecalc) return;
    const items = extractBillingItems(data);
    if (items.length === 0) {
      toast.show("info", "Add at least one line item to recalc.");
      return;
    }
    setBusyRecalc(true);
    try {
      // Pull the existing tax rate / label out of the data tree where
      // present. Different starters key the totals block differently
      // (invoice / quote / receipt); we look at all three and take the
      // first match. The rate is INCLUSIVE of % — invoice templates
      // store "9%" as the label and the dollar amount as `tax`, so we
      // re-derive a numeric rate from the label when possible.
      const totalsBlock = pickTotalsBlock(data);
      const rate = parseTaxRate(totalsBlock?.taxLabel);
      const res = await recalcBilling({
        starterId: active.id,
        items,
        tax:
          rate !== null
            ? { rate, label: String(totalsBlock?.taxLabel ?? "") }
            : undefined,
      });
      setData((d) => writeBillingTotals(d, res));
      toast.show("success", "Totals recalculated");
    } catch (e) {
      toast.show("error", aiErrorMessage(e, "Couldn't recalculate"));
    } finally {
      setBusyRecalc(false);
    }
  }

  async function runExport() {
    if (busyExport) return;
    setBusyExport(true);
    try {
      const res = await exportStarter(active.id, {
        html: themedHtml,
        data,
        customize: hasCustomize(customize)
          ? (customize as Record<string, unknown>)
          : undefined,
        format: "pdf",
        filename: `${active.id}.pdf`,
      });
      // Trigger the browser download. The presigned URL is short-lived but
      // we don't need to hold on to it past this navigation.
      window.location.href = res.url;
    } catch (e) {
      toast.show("error", aiErrorMessage(e, "Couldn't export"));
    } finally {
      setBusyExport(false);
    }
  }

  async function runSaveToDrive() {
    if (busySave) return;
    setBusySave(true);
    try {
      const res = await saveStarterToDrive(active.id, {
        html: themedHtml,
        data,
        customize: hasCustomize(customize)
          ? (customize as Record<string, unknown>)
          : undefined,
        format: "pdf",
        filename: `${active.id}.pdf`,
      });
      toast.show("success", `Saved "${res.filename}" to your drive`);
      // The /drive/d/{fileId} deep link doesn't exist as a route yet — send
      // the user to the drive root where the new file is the most recent.
      router.push("/drive");
    } catch (e) {
      toast.show("error", aiErrorMessage(e, "Couldn't save to drive"));
    } finally {
      setBusySave(false);
    }
  }

  function applySuggestion(path: string, after: string) {
    setData((d) => setByPath(d, path, after));
    toast.show("success", "Suggestion applied");
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex h-screen flex-col bg-muted/30 text-foreground">
      {/* Top bar */}
      <header className="flex items-center gap-3 border-b bg-background px-4 py-2">
        <Link
          href="/drive"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Back to drive"
        >
          <ArrowLeft size={16} />
        </Link>
        <div className="flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-md bg-primary/10 text-primary">
            <FileText size={14} />
          </div>
          <div className="text-sm font-semibold">{active.name}</div>
        </div>

        <div className="mx-auto flex items-center rounded-full border bg-background p-0.5 text-xs">
          <TabBtn active={tab === "edit"} onClick={() => setTab("edit")}>
            Edit
          </TabBtn>
          <TabBtn
            active={tab === "customize"}
            onClick={() => setTab("customize")}
          >
            Customize
          </TabBtn>
          <TabBtn active={tab === "review"} onClick={() => setTab("review")}>
            AI Review
          </TabBtn>
        </div>

        <div className="flex items-center gap-2">
          {/* API integration guide — same starter content the user is
              editing here, presented as endpoint + payload + snippets
              so their backend can generate the same document. */}
          <StarterApiGuideSheet starter={active} />
          <Button
            size="sm"
            variant="outline"
            loading={busySave}
            onClick={runSaveToDrive}
            className="gap-1"
          >
            <Cloud size={14} />
            Save to drive
          </Button>
          <Button
            size="sm"
            loading={busyExport}
            onClick={runExport}
            className="gap-1"
          >
            <Download size={14} />
            Download
          </Button>
        </div>
      </header>

      <div className="grid flex-1 min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,540px)_1fr]">
        {/* Left: form / customize / review column */}
        <div className="min-h-0 overflow-y-auto border-r bg-background">
          <div className="mx-auto w-full max-w-[520px] px-6 py-6">
            {tab === "edit" ? (
              <>
                <CompletenessBar
                  value={completeness}
                  label={completenessLabel(active.category)}
                />
                {/* Resume-only AI shortcuts. Showing "Create quick cover
                    letter" on an Invoice or NDA is confusing — these
                    only fire prompts that expect resume-shaped data. */}
                {aiSummaryEnabled && active.category === "Resume" ? (
                  <div className="mt-6 grid grid-cols-2 gap-3">
                    <ShortcutCard
                      icon={
                        busySummary ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Sparkles size={14} />
                        )
                      }
                      label="Try AI profile summary"
                      onClick={runProfileSummary}
                      disabled={busySummary}
                    />
                    <ShortcutCard
                      icon={
                        busyCover ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <FileText size={14} />
                        )
                      }
                      label="Create quick cover letter"
                      onClick={runCoverLetter}
                      disabled={busyCover}
                    />
                  </div>
                ) : null}
                {/* Billing / Finance — pure-function recalc; doesn't
                    need the AI flag. */}
                {active.category === "Billing" ||
                active.category === "Finance" ? (
                  <div className="mt-3 grid grid-cols-1 gap-3">
                    <ShortcutCard
                      icon={
                        busyRecalc ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Sparkles size={14} />
                        )
                      }
                      label="Recalculate totals"
                      onClick={runRecalc}
                      disabled={busyRecalc}
                    />
                  </div>
                ) : null}

                {summaryAlts.length > 0 ? (
                  <div className="mt-4 space-y-2 rounded-lg border bg-muted/40 p-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Try another phrasing
                    </div>
                    {summaryAlts.map((alt, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() =>
                          setData((d) => ({ ...d, summary: alt }))
                        }
                        className="block w-full rounded-md border bg-background px-3 py-2 text-left text-xs leading-relaxed hover:bg-accent"
                      >
                        {alt}
                      </button>
                    ))}
                  </div>
                ) : null}

                <div className="mt-8">
                  <StarterFillForm
                    schema={schema}
                    value={data}
                    onChange={setData}
                  />
                </div>
              </>
            ) : tab === "customize" ? (
              <CustomizePanel value={customize} onChange={setCustomize} />
            ) : (
              <ReviewPanel
                ai={aiSummaryEnabled}
                review={review}
                busy={busyReview}
                targetRole={targetRole}
                onTargetRole={setTargetRole}
                onRun={runReview}
                onApply={applySuggestion}
              />
            )}
          </div>
        </div>

        {/* Right: preview */}
        <div className="relative flex min-h-0 min-w-0 flex-col bg-muted/40">
          <div className="relative flex-1 overflow-auto">
            <div className="mx-auto my-8 w-[816px] max-w-[calc(100%-3rem)] bg-white shadow-[0_2px_24px_rgba(15,23,42,0.08)] ring-1 ring-border">
              <iframe
                key={active.id}
                title="Live preview"
                srcDoc={previewHtml}
                sandbox="allow-same-origin"
                className="h-[1056px] w-full"
              />
            </div>
          </div>

          {/* Floating palette / design picker */}
          {all.length > 1 ? (
            <button
              type="button"
              onClick={() => setDesignOpen((v) => !v)}
              className="absolute right-6 top-1/2 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg ring-4 ring-background hover:brightness-110"
              aria-label="Change design"
            >
              <Palette size={18} />
            </button>
          ) : null}

          {designOpen ? (
            <DesignPicker
              starters={all}
              activeId={activeId}
              onSelect={(id) => {
                setActiveId(id);
                setDesignOpen(false);
              }}
              onClose={() => setDesignOpen(false)}
              data={previewData}
            />
          ) : null}

          {/* Page count footer */}
          <div className="absolute bottom-4 right-6 inline-flex items-center gap-2 rounded-full bg-foreground/85 px-2.5 py-1 text-[11px] font-medium text-background backdrop-blur">
            <button
              type="button"
              className="grid h-5 w-5 place-items-center rounded-full hover:bg-background/10"
              aria-label="Previous page"
            >
              <ChevronLeft size={12} />
            </button>
            <span className="tabular-nums">1 / 1</span>
            <button
              type="button"
              className="grid h-5 w-5 place-items-center rounded-full hover:bg-background/10"
              aria-label="Next page"
            >
              <ChevronRight size={12} />
            </button>
          </div>
        </div>
      </div>

      {coverLetter ? (
        <CoverLetterModal
          letter={coverLetter}
          onClose={() => setCoverLetter(null)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bits
// ---------------------------------------------------------------------------

function TabBtn({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-full px-3 py-1 text-xs font-medium transition-colors " +
        (active
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:text-foreground")
      }
    >
      {children}
    </button>
  );
}

function CompletenessBar({
  value,
  label = "Form completeness",
}: {
  value: number;
  label?: string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const tone =
    pct >= 80
      ? "bg-emerald-500"
      : pct >= 40
        ? "bg-amber-500"
        : "bg-rose-500";
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-xs">
        <span
          className={
            "rounded-full px-2 py-0.5 text-[11px] font-semibold text-white " +
            tone
          }
        >
          {pct}%
        </span>
        <span className="font-medium text-muted-foreground">{label}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={"h-full transition-all duration-300 " + tone}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function ShortcutCard({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="grid h-7 w-7 place-items-center rounded-md bg-primary/10 text-primary">
        {icon}
      </span>
      <span className="flex-1 text-xs font-medium text-foreground">
        {label}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Customize panel — lightweight theme controls. Stored client-side and shipped
// inline to the export endpoint as `customize`. Starters that opt in can read
// `{{ .__theme.primary }}` etc.; starters that don't simply ignore it.
// ---------------------------------------------------------------------------

const PRIMARY_SWATCHES = [
  "#0f172a",
  "#1d4ed8",
  "#0d9488",
  "#a16207",
  "#be185d",
  "#7c3aed",
];

function CustomizePanel({
  value,
  onChange,
}: {
  value: Customize;
  onChange: (v: Customize) => void;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold">Customize</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Tweak the look of your resume. Changes are reflected in the preview
          and saved into the exported PDF.
        </p>
      </div>

      <section className="space-y-2">
        <label className="text-xs font-semibold text-foreground">
          Primary color
        </label>
        <div className="flex flex-wrap gap-2">
          {PRIMARY_SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onChange({ ...value, primary: c })}
              className={
                "h-8 w-8 rounded-full border transition-shadow " +
                (value.primary === c
                  ? "ring-2 ring-offset-2 ring-foreground"
                  : "")
              }
              style={{ backgroundColor: c }}
              aria-label={`Primary ${c}`}
            />
          ))}
          <button
            type="button"
            onClick={() => onChange({ ...value, primary: undefined })}
            className="h-8 rounded-full border bg-background px-3 text-xs text-muted-foreground hover:bg-accent"
          >
            Reset
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <label className="text-xs font-semibold text-foreground">Font</label>
        <div className="grid grid-cols-3 gap-2">
          {(["sans", "serif", "display"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => onChange({ ...value, font: f })}
              className={
                "rounded-md border px-3 py-2 text-xs capitalize transition-colors " +
                (value.font === f
                  ? "border-foreground bg-foreground text-background"
                  : "bg-background hover:bg-accent")
              }
              style={{
                fontFamily:
                  f === "serif"
                    ? "Georgia, serif"
                    : f === "display"
                      ? "'Playfair Display', Georgia, serif"
                      : undefined,
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <label className="text-xs font-semibold text-foreground">
          Density
        </label>
        <div className="grid grid-cols-3 gap-2">
          {(["compact", "normal", "comfy"] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => onChange({ ...value, density: d })}
              className={
                "rounded-md border px-3 py-2 text-xs capitalize transition-colors " +
                (value.density === d
                  ? "border-foreground bg-foreground text-background"
                  : "bg-background hover:bg-accent")
              }
            >
              {d}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function hasCustomize(c: Customize): boolean {
  return Boolean(c.primary || c.accent || c.font || c.density);
}

// applyCustomize rewrites a starter's raw HTML so the user's customize
// choices actually take effect in the rendered output. Two transforms:
//
//   1. Brand-color recolor — every starter we ship hard-codes a single
//      dominant color (typically slate-900 #0f172a or an equivalent).
//      We string-replace the well-known brand swatches with the picked
//      `primary`. Case-insensitive so #0F172A and #0f172a both hit. This
//      is intentionally simple — a future "themed starter" can opt into
//      `{{ .__theme.primary }}` and skip this path entirely.
//
//   2. Style overrides — we append a `<style data-theme-override>` block
//      just before `</head>` with `!important` rules for font-family,
//      base font-size, and line-height. `!important` is justified here:
//      it's the only way to win against a starter's existing inline
//      `<style>` without parsing CSS.
//
// The function is a no-op when customize is empty (returns the input
// reference unchanged) so it's cheap to call on every render.
function applyCustomize(html: string, c: Customize): string {
  if (!hasCustomize(c)) return html;

  let out = html;

  if (c.primary) {
    // Known brand colors used by ./web/lib/starters/*.ts. Replace each
    // independently so multi-shade starters get a consistent recolor.
    const swatches = [
      "#0f172a", // slate-900 — modern resume, classic
      "#1f2937", // gray-800 — body text in some
      "#111827", // gray-900 — alt sidebar
    ];
    for (const hex of swatches) {
      // Case-insensitive find/replace via regex. Escape the # for regex
      // literal safety even though it's not a metachar — keeps intent
      // obvious.
      const re = new RegExp(escapeRegex(hex), "gi");
      out = out.replace(re, c.primary);
    }
  }

  const overrides: string[] = [];
  if (c.font) {
    const stack =
      c.font === "serif"
        ? "Georgia, 'Times New Roman', serif"
        : c.font === "display"
          ? "'Playfair Display', Georgia, serif"
          : "Inter, system-ui, sans-serif";
    // body * — overrides every descendant including the typographic
    // helpers (`.name`, `.title`) that set their own font-family.
    overrides.push(
      `body, body * { font-family: ${stack} !important; }`,
    );
  }
  if (c.density && c.density !== "normal") {
    const scale = c.density === "compact" ? 0.92 : 1.08;
    overrides.push(
      `body { font-size: ${scale}em !important; line-height: ${(1.45 * scale).toFixed(3)} !important; }`,
    );
  }
  if (overrides.length > 0) {
    const block = `<style data-theme-override>\n${overrides.join("\n")}\n</style>`;
    if (out.includes("</head>")) {
      out = out.replace("</head>", `${block}</head>`);
    } else {
      // No <head>? Prepend so the styles still load before body content.
      out = block + out;
    }
  }

  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// AI Review panel
// ---------------------------------------------------------------------------

function ReviewPanel({
  ai,
  review,
  busy,
  targetRole,
  onTargetRole,
  onRun,
  onApply,
}: {
  ai: boolean;
  review: ReviewResponse | null;
  busy: boolean;
  targetRole: string;
  onTargetRole: (s: string) => void;
  onRun: () => void;
  onApply: (path: string, after: string) => void;
}) {
  if (!ai) {
    return (
      <div className="rounded-lg border bg-muted/40 p-6 text-center">
        <h2 className="text-sm font-semibold">AI Review is unavailable</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Your administrator hasn't enabled AI on this workspace.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold">AI Review</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Get a section-by-section critique with suggested rewrites you can
          apply with one click.
        </p>
      </div>

      <div className="space-y-2">
        <label className="text-xs font-semibold">
          Target role <span className="text-muted-foreground">(optional)</span>
        </label>
        <input
          value={targetRole}
          onChange={(e) => onTargetRole(e.target.value)}
          placeholder="e.g. Senior Product Designer"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <Button onClick={onRun} loading={busy} className="w-full">
        {review ? "Re-run review" : "Run AI review"}
      </Button>

      {review ? (
        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-baseline justify-between">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Score
                </div>
                <div className="text-3xl font-semibold tabular-nums">
                  {review.score}
                  <span className="text-base font-normal text-muted-foreground">
                    /100
                  </span>
                </div>
              </div>
              <div
                className={
                  "rounded-full px-2 py-0.5 text-[11px] font-semibold " +
                  scoreTone(review.score)
                }
              >
                {scoreLabel(review.score)}
              </div>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {review.verdict}
            </p>
          </div>

          {review.sections.map((s) => (
            <ReviewSectionCard
              key={s.id}
              section={s}
              onApply={onApply}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ReviewSectionCard({
  section,
  onApply,
}: {
  section: ReviewSection;
  onApply: (path: string, after: string) => void;
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <StatusIcon status={section.status} />
          <div className="text-sm font-semibold">{section.label}</div>
        </div>
      </div>
      {section.notes ? (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {section.notes}
        </p>
      ) : null}

      {section.missingKeywords && section.missingKeywords.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {section.missingKeywords.map((k) => (
            <span
              key={k}
              className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800"
            >
              {k}
            </span>
          ))}
        </div>
      ) : null}

      {section.suggestions && section.suggestions.length > 0 ? (
        <div className="mt-3 space-y-2">
          {section.suggestions.map((sug, i) => (
            <div key={i} className="rounded-md border bg-muted/40 p-2">
              <div className="text-[10px] font-mono text-muted-foreground">
                {sug.path}
              </div>
              <div className="mt-1 text-xs leading-snug">
                <div className="text-muted-foreground line-through">
                  {sug.before}
                </div>
                <div>{sug.after}</div>
              </div>
              <div className="mt-2 flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onApply(sug.path, sug.after)}
                >
                  Apply
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StatusIcon({ status }: { status: ReviewStatus }) {
  if (status === "good") {
    return <CheckCircle2 size={14} className="text-emerald-600" />;
  }
  if (status === "warn") {
    return <CircleAlert size={14} className="text-amber-600" />;
  }
  return <CircleX size={14} className="text-rose-600" />;
}

function scoreTone(n: number): string {
  if (n >= 80) return "bg-emerald-100 text-emerald-800";
  if (n >= 60) return "bg-amber-100 text-amber-800";
  return "bg-rose-100 text-rose-800";
}

function scoreLabel(n: number): string {
  if (n >= 80) return "Strong";
  if (n >= 60) return "Workable";
  return "Needs work";
}

// ---------------------------------------------------------------------------
// Cover letter modal
// ---------------------------------------------------------------------------

function CoverLetterModal({
  letter,
  onClose,
}: {
  letter: CoverLetterPayload;
  onClose: () => void;
}) {
  const toast = useToast();
  const text = `${letter.greeting}\n\n${stripHTMLToText(letter.body, letter.format)}\n\n${letter.closing}`;
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-foreground/40 p-6"
      onClick={onClose}
    >
      <div
        className="grid max-h-[80vh] w-full max-w-2xl grid-rows-[auto_1fr_auto] rounded-lg bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div className="text-sm font-semibold">Cover letter draft</div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-5">
          <p className="text-sm">{letter.greeting}</p>
          {letter.format === "html" ? (
            <div
              className="prose prose-sm mt-3 max-w-none"
              dangerouslySetInnerHTML={{ __html: letter.body }}
            />
          ) : (
            <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed">
              {letter.body}
            </pre>
          )}
          <p className="mt-3 whitespace-pre-line text-sm">{letter.closing}</p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                toast.show("success", "Copied to clipboard");
              } catch {
                toast.show("error", "Couldn't copy");
              }
            }}
            className="gap-1"
          >
            <Copy size={14} />
            Copy
          </Button>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

// Strip the simplest HTML for plaintext copy. We keep paragraph breaks but
// drop the rest — good enough for a clipboard paste; the canonical version
// stays HTML in `letter.body`.
function stripHTMLToText(s: string, format: "html" | "markdown" | "plain") {
  if (format !== "html") return s;
  return s
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function DesignPicker({
  starters,
  activeId,
  onSelect,
  onClose,
  data,
}: {
  starters: Starter[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  data: Record<string, unknown>;
}) {
  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-end bg-foreground/40 p-6"
      onClick={onClose}
    >
      <div
        className="grid h-full w-[420px] grid-rows-[auto_1fr] rounded-lg bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="text-sm font-semibold">Choose a design</div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </div>
        <div className="space-y-3 overflow-y-auto p-4">
          {starters.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s.id)}
              className={
                "block w-full overflow-hidden rounded-lg border bg-white text-left transition-shadow hover:shadow-md " +
                (s.id === activeId
                  ? "ring-2 ring-primary ring-offset-2"
                  : "")
              }
            >
              <div className="relative h-40 w-full overflow-hidden bg-muted">
                <iframe
                  title={`${s.name} preview`}
                  srcDoc={miniRender(s.html, data)}
                  sandbox="allow-same-origin"
                  className="absolute left-0 top-0 h-[1056px] w-[816px] origin-top-left"
                  style={{ transform: "scale(0.32)" }}
                />
              </div>
              <div className="border-t px-3 py-2">
                <div className="text-sm font-medium">{s.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  {s.description}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers — completeness scoring + dot-path mutation + AI error rendering.
// ---------------------------------------------------------------------------

function scoreCompleteness(
  data: Record<string, unknown>,
  schema: { groups: unknown[] },
): number {
  let total = 0;
  let filled = 0;

  function check(v: unknown): boolean {
    if (v == null) return false;
    if (typeof v === "string") return v.trim() !== "";
    if (Array.isArray(v)) return v.length > 0 && v.some(check);
    if (typeof v === "object") {
      return Object.values(v as Record<string, unknown>).some(check);
    }
    return true;
  }

  for (const g of schema.groups as Array<Record<string, unknown>>) {
    const path = g.path as string;
    const root =
      typeof path === "string"
        ? path.split(".").reduce<unknown>(
            (acc, k) =>
              acc && typeof acc === "object"
                ? (acc as Record<string, unknown>)[k]
                : undefined,
            data,
          )
        : undefined;
    if (g.kind === "object" && Array.isArray(g.fields)) {
      for (const f of g.fields as Array<{ id: string; optional?: boolean }>) {
        if (f.optional) continue;
        total += 1;
        const obj = (root as Record<string, unknown>) ?? {};
        if (check(obj[f.id])) filled += 1;
      }
    } else if (g.kind === "scalar") {
      total += 1;
      if (check(root)) filled += 1;
    } else if (g.kind === "string-list" || g.kind === "object-list") {
      total += 1;
      if (Array.isArray(root) && root.length > 0) filled += 1;
    }
  }

  if (total === 0) return 100;
  return (filled / total) * 100;
}

// setByPath returns a structurally-shared copy of `obj` with the leaf at
// `path` (dot-notation) replaced by `value`. Numeric segments index into
// arrays. Used by review-suggestion "Apply" buttons; missing intermediates
// are created as plain objects so a path like "person.title" still applies
// even when person is undefined.
function setByPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) return obj;
  const next = Array.isArray(obj) ? [...obj] : { ...obj };
  let cursor: Record<string, unknown> | unknown[] = next as
    | Record<string, unknown>
    | unknown[];
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const idx = /^\d+$/.test(k) ? Number(k) : k;
    const existing = (cursor as Record<string | number, unknown>)[idx];
    let copy: Record<string, unknown> | unknown[];
    if (Array.isArray(existing)) {
      copy = [...existing];
    } else if (existing && typeof existing === "object") {
      copy = { ...(existing as Record<string, unknown>) };
    } else {
      copy = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    (cursor as Record<string | number, unknown>)[idx] = copy;
    cursor = copy;
  }
  const last = parts[parts.length - 1];
  const lastIdx = /^\d+$/.test(last) ? Number(last) : last;
  (cursor as Record<string | number, unknown>)[lastIdx] = value;
  return next as Record<string, unknown>;
}

// aiErrorMessage extracts a friendly toast-ready string from any thrown
// error. ApiError already has a polished `.message`; it also carries a
// `code` we can branch on for a few known cases (ai_disabled etc.).
function aiErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.code === "ai_disabled") {
      return "AI features are turned off on this workspace.";
    }
    if (e.code === "render_failed") {
      return "Couldn't render the document. Please try again.";
    }
    // ai_upstream is a 502 from the LLM provider — auth, rate limit,
    // model unavailable, etc. Surface the raw upstream message because
    // the canned 5xx text ("service is having trouble") hides the
    // actionable signal an operator running locally needs to see.
    if (e.code === "ai_upstream") {
      return e.rawMessage
        ? `${fallback}: ${e.rawMessage}`
        : `${fallback} (AI provider error)`;
    }
    return e.message || fallback;
  }
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

// completenessLabel produces the right phrasing for the progress bar
// based on the active starter's category. The bar itself is generic —
// every starter benefits from "you've filled X% of the required
// fields" — but calling it "Resume completeness" on an invoice / NDA
// / certificate looked like a leftover from when this page only
// hosted resumes. Mapping is keyed by the starter's `category` field
// (see web/lib/starters/types.ts for the closed set).
function completenessLabel(category: string): string {
  switch (category) {
    case "Resume":
      return "Resume completeness";
    case "Billing":
    case "Finance":
      return "Invoice completeness";
    case "Legal":
      return "Document completeness";
    case "HR":
      return "Form completeness";
    case "Certificates":
      return "Certificate completeness";
    case "Correspondence":
      return "Letter completeness";
    case "Reports":
      return "Report completeness";
    case "Marketing":
      return "Page completeness";
    case "Operations":
      return "Procedure completeness";
    case "Events":
      return "Event details completeness";
    case "Education":
      return "Course details completeness";
    case "Commerce":
      return "Listing completeness";
    default:
      return "Form completeness";
  }
}

// -- Billing helpers ------------------------------------------------------
//
// The Billing starters (invoice/quote/receipt) shape line items as
// `{ name, qty, rate, amount }` and the totals as either `invoice.*`,
// `quote.*`, or `receipt.*`. The shared /v1/starters/billing/recalc
// endpoint speaks `{ description, qty, unitPrice }`. These helpers
// adapt between the two so the demo wiring is a one-button affair —
// future Billing starters that adopt the canonical shape can drop the
// adapter entirely.

interface BillingTotalsBlock {
  tax?: number;
  taxLabel?: string;
  total?: number;
}

function extractBillingItems(d: Record<string, unknown>): RecalcItem[] {
  const raw = (d as { items?: unknown }).items;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((it) => {
    if (!it || typeof it !== "object") return [];
    const o = it as Record<string, unknown>;
    const qty = Number(o.qty ?? 1);
    const rate = Number(o.rate ?? o.unitPrice ?? 0);
    if (!Number.isFinite(qty) || !Number.isFinite(rate)) return [];
    const desc =
      typeof o.name === "string"
        ? o.name
        : typeof o.description === "string"
          ? o.description
          : "";
    return [{ description: desc, qty, unitPrice: rate }];
  });
}

function pickTotalsBlock(
  d: Record<string, unknown>,
): BillingTotalsBlock | null {
  for (const key of ["invoice", "quote", "receipt"]) {
    const v = (d as Record<string, unknown>)[key];
    if (v && typeof v === "object") return v as BillingTotalsBlock;
  }
  return null;
}

// parseTaxRate turns "9%" or "0.09" into 0.09. Returns null when the
// label is empty or unparseable — the recalc call will then omit `tax`
// entirely (server treats absent tax as zero).
function parseTaxRate(label: unknown): number | null {
  if (label == null) return null;
  const s = String(label).trim();
  if (!s) return null;
  if (s.endsWith("%")) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? n / 100 : null;
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  // Heuristic: anything ≥ 1 was almost certainly meant as a percentage.
  return n > 1 ? n / 100 : n;
}

// writeBillingTotals updates the totals block + each line's `amount`
// field with server-rounded values. Doesn't touch line `name/qty/rate`
// the user typed — recalc is purely arithmetic.
function writeBillingTotals(
  d: Record<string, unknown>,
  res: { subtotal: number; taxAmount: number; total: number },
): Record<string, unknown> {
  const next = { ...d };
  const items = Array.isArray(next.items) ? [...(next.items as unknown[])] : [];
  next.items = items.map((it) => {
    if (!it || typeof it !== "object") return it;
    const o = { ...(it as Record<string, unknown>) };
    const qty = Number(o.qty ?? 1);
    const rate = Number(o.rate ?? o.unitPrice ?? 0);
    if (Number.isFinite(qty) && Number.isFinite(rate)) {
      o.amount = round2(qty * rate);
    }
    return o;
  });
  for (const key of ["invoice", "quote", "receipt"]) {
    const block = (next as Record<string, unknown>)[key];
    if (block && typeof block === "object") {
      (next as Record<string, unknown>)[key] = {
        ...(block as Record<string, unknown>),
        tax: res.taxAmount,
        total: res.total,
      };
      break;
    }
  }
  return next;
}

function round2(v: number) {
  return Math.round(v * 100) / 100;
}

