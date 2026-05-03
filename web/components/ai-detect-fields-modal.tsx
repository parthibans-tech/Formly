"use client";

// AI auto-detect fields modal.
//
// Surfaces the proposals returned by POST /v1/templates/{id}/ai/detect-fields
// in a review-and-accept flow: every detected field is a row the
// author can toggle on/off and rename in-place before committing.
// The modal NEVER persists on its own — it hands the accepted set
// back to the parent designer via onAccept(), which merges them into
// the local widgets state and lets the user trigger Save (manual or
// autosave) like any other edit.
//
// Detection runs through a 3-tier cascade on the backend:
//   1. AcroForm (deterministic, instant) — for PDFs with embedded form
//      data
//   2. Heuristic (rule-based on PaddleOCR layout) — for scanned/flat
//      PDFs whose labels and underlines we can OCR
//   3. Vision-LLM (multimodal model, opt-in via AI_VISION_MODEL) —
//      catches visually complex layouts the rules miss
//
// The default `auto` strategy stops at the first non-empty tier. The
// strategy <select> below the proposal list lets the user pin a
// specific tier — useful for "the heuristic missed a column, let me
// try vision" workflows.

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, AlertCircle, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type DetectedProposal = {
  type: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  dataKey: string;
  label?: string;
  pageW?: number;
  pageH?: number;
  props?: Record<string, any>;
  source: string;
  confidence: number;
};

type DetectResponse = {
  source: string; // "acroform" | "heuristic" | "vision" | "none"
  count: number;
  proposals: DetectedProposal[];
  message?: string;
};

// Strategy values match the backend's parseStrategy() vocabulary.
// "auto" lets the cascade pick the best tier; the others pin a
// specific tier for re-runs when the user wants to compare.
type Strategy = "auto" | "acroform" | "heuristic" | "vision" | "merge";

const STRATEGY_OPTIONS: { value: Strategy; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "AcroForm \u2192 (OCR heuristic + vision-AI merged when available)" },
  { value: "merge", label: "Merge (best recall)", hint: "Always run OCR heuristic AND vision-AI, then union the detections" },
  { value: "acroform", label: "AcroForm only", hint: "PDFs with embedded form data" },
  { value: "heuristic", label: "OCR heuristic", hint: "Rule-based on scanned-form text" },
  { value: "vision", label: "Vision AI", hint: "Vision model picks fields directly" },
];

// confidenceBucket maps the 0..1 score to a coarse {label, classes}
// triple so the row can render a colour-coded chip without a styling
// function on every render. Heuristic tier uses the rubric in
// internal/aidetect/heuristic; AcroForm always reports 1.0; vision-LLM
// is clamped to [0.4, 0.95]. Three buckets keep the UI scanable.
function confidenceChip(c: number): { label: string; cls: string } {
  if (c >= 0.85) return { label: "high", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" };
  if (c >= 0.6) return { label: "med", cls: "bg-amber-50 text-amber-700 border-amber-200" };
  return { label: "low", cls: "bg-rose-50 text-rose-700 border-rose-200" };
}

// sourceChip mirrors the backend "source" attribution per-proposal.
// Different colour from the confidence chip so a glance distinguishes
// "where did this come from?" vs "how sure are we?".
function sourceChip(source: string): { label: string; cls: string } {
  switch (source) {
    case "acroform":
      return { label: "acroform", cls: "bg-blue-50 text-blue-700 border-blue-200" };
    case "heuristic":
      return { label: "heuristic", cls: "bg-violet-50 text-violet-700 border-violet-200" };
    case "vision":
      return { label: "vision-AI", cls: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200" };
    case "merged":
      // "Merged" = both heuristic and vision agreed on this field.
      // Emerald reads as "double-confirmed, highest signal" — the
      // most trustworthy chip in the palette.
      return { label: "merged", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" };
    default:
      return { label: source || "?", cls: "bg-gray-50 text-gray-700 border-gray-200" };
  }
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templateId: string;
  // Existing widget data keys — used to flag proposals that would
  // collide with what the author has already drawn so they can rename
  // before accepting (otherwise the "duplicate dataKey" anti-pattern
  // sneaks in silently).
  existingDataKeys: string[];
  onAccept: (accepted: DetectedProposal[]) => void;
};

export function AIDetectFieldsModal({
  open,
  onOpenChange,
  templateId,
  existingDataKeys,
  onAccept,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resp, setResp] = useState<DetectResponse | null>(null);
  // Strategy is reset to "auto" on open but the user can re-run with a
  // different tier from the footer dropdown. Re-running clears the
  // previous proposals so the new tier's output replaces them rather
  // than appending — the heuristic + vision tiers detect overlapping
  // regions and merging blindly would produce duplicates.
  const [strategy, setStrategy] = useState<Strategy>("auto");
  // Per-proposal mutable state: which are checked + the (possibly
  // renamed) dataKey. Indexed by position in resp.proposals.
  const [accepted, setAccepted] = useState<boolean[]>([]);
  const [keys, setKeys] = useState<string[]>([]);
  // Race guard — if the user reopens the modal mid-fetch (or re-runs
  // with a different strategy), drop the stale response.
  const seqRef = useRef(0);

  // Trigger detection on open + every strategy change. Reset state
  // every time so a previous run's proposals don't flash before the
  // new fetch resolves — matters because vision-tier detection on a
  // 5-page PDF can take 10-20s.
  useEffect(() => {
    if (!open) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    setResp(null);
    setAccepted([]);
    setKeys([]);
    (async () => {
      try {
        const qs = strategy === "auto" ? "" : `?strategy=${strategy}`;
        const raw = await api<DetectResponse>(
          `/v1/templates/${templateId}/ai/detect-fields${qs}`,
          { method: "POST" },
        );
        if (seq !== seqRef.current) return;
        // Normalize at the boundary: Go marshals an empty slice as
        // `null`, not `[]`. Every downstream use of `proposals`
        // assumes it's iterable, so coerce once here rather than
        // sprinkling `?? []` at every read site.
        const r: DetectResponse = {
          ...raw,
          proposals: raw.proposals ?? [],
          count: raw.count ?? 0,
        };
        setResp(r);
        // Default every proposal to "accepted" — quicker for the
        // common case (user trusts the detector and just hits Apply).
        setAccepted(r.proposals.map(() => true));
        setKeys(r.proposals.map((p) => p.dataKey));
      } catch (e: any) {
        if (seq !== seqRef.current) return;
        setError(e?.message || "Detection failed");
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    })();
  }, [open, templateId, strategy]);

  // Reset strategy to auto on close so the next open starts clean.
  // Useful if the user pinned vision once but doesn't want to re-pay
  // the AI call cost on the next open.
  useEffect(() => {
    if (!open) setStrategy("auto");
  }, [open]);

  // Surface duplicate-key warnings inline. We compute against both
  // existingDataKeys (already on the canvas) and the OTHER accepted
  // proposals — two new fields with the same key collide too.
  const dupFlags = useMemo<boolean[]>(() => {
    if (!resp) return [];
    const existing = new Set(existingDataKeys.filter(Boolean));
    const counts = new Map<string, number>();
    keys.forEach((k, i) => {
      if (!accepted[i]) return;
      counts.set(k, (counts.get(k) || 0) + 1);
    });
    return keys.map((k, i) => {
      if (!accepted[i]) return false;
      if (existing.has(k)) return true;
      return (counts.get(k) || 0) > 1;
    });
  }, [resp, keys, accepted, existingDataKeys]);

  const acceptedCount = accepted.filter(Boolean).length;
  const hasDups = dupFlags.some(Boolean);

  function toggleAll(value: boolean) {
    setAccepted((prev) => prev.map(() => value));
  }

  function applyAccepted() {
    if (!resp) return;
    const out: DetectedProposal[] = [];
    resp.proposals.forEach((p, i) => {
      if (!accepted[i]) return;
      const key = (keys[i] || "").trim() || p.dataKey;
      out.push({ ...p, dataKey: key });
    });
    onAccept(out);
    onOpenChange(false);
  }

  // Group proposals by page so a multi-page PDF's review list is
  // skim-able. Order within a group preserves the API's order
  // (top-to-bottom on the page).
  const grouped = useMemo(() => {
    if (!resp) return [];
    const by = new Map<number, number[]>();
    resp.proposals.forEach((p, i) => {
      const arr = by.get(p.page) || [];
      arr.push(i);
      by.set(p.page, arr);
    });
    return Array.from(by.entries()).sort((a, b) => a[0] - b[0]);
  }, [resp]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-violet-600" />
            Auto-detect form fields
          </DialogTitle>
          <DialogDescription>
            Detects fillable regions in the PDF and proposes a widget
            for each. Tries embedded AcroForm data first, then OCR-based
            heuristics, then a vision-AI tier (if configured). Review
            and rename below &mdash; nothing is saved until you click Apply.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-[280px] max-h-[60vh] overflow-y-auto -mx-6 px-6 py-2">
          {loading && (
            <div className="flex items-center justify-center py-12 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Scanning PDF…
            </div>
          )}

          {!loading && error && (
            <div className="flex items-start gap-2 p-3 border border-red-200 bg-red-50 rounded text-sm text-red-700">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {!loading && !error && resp && resp.count === 0 && (
            <div className="text-center py-10 px-6">
              <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-gray-100 mb-3">
                <Sparkles className="h-5 w-5 text-gray-400" />
              </div>
              <p className="text-sm font-medium text-gray-900 mb-1">
                No form fields detected
              </p>
              <p className="text-sm text-gray-500 max-w-md mx-auto">
                {resp.message ||
                  "No fillable fields detected. Try a different strategy below, or draw fields manually from the palette."}
              </p>
            </div>
          )}

          {!loading && !error && resp && resp.count > 0 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>
                  Found <strong className="text-gray-900">{resp.count}</strong>{" "}
                  field{resp.count === 1 ? "" : "s"} via{" "}
                  <span
                    className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[11px] ${sourceChip(resp.source).cls}`}
                  >
                    {sourceChip(resp.source).label}
                  </span>
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="text-xs text-gray-600 hover:text-gray-900"
                    onClick={() => toggleAll(true)}
                  >
                    Select all
                  </button>
                  <span className="text-gray-300">|</span>
                  <button
                    type="button"
                    className="text-xs text-gray-600 hover:text-gray-900"
                    onClick={() => toggleAll(false)}
                  >
                    Clear
                  </button>
                </div>
              </div>

              {grouped.map(([page, indices]) => (
                <div key={page}>
                  <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">
                    Page {page}
                  </div>
                  <div className="space-y-1">
                    {indices.map((i) => {
                      const p = resp.proposals[i];
                      const isDup = dupFlags[i];
                      const conf = confidenceChip(p.confidence);
                      const src = sourceChip(p.source);
                      return (
                        <label
                          key={i}
                          className={`flex items-center gap-2 p-2 rounded border cursor-pointer hover:bg-gray-50 ${
                            isDup ? "border-amber-300 bg-amber-50" : "border-gray-200"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={!!accepted[i]}
                            onChange={(e) => {
                              const next = [...accepted];
                              next[i] = e.target.checked;
                              setAccepted(next);
                            }}
                            className="h-4 w-4 rounded border-gray-300"
                          />
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-100 text-[11px] text-gray-700 font-mono flex-shrink-0">
                            {p.type}
                          </span>
                          <Input
                            type="text"
                            value={keys[i] ?? ""}
                            onChange={(e) => {
                              const next = [...keys];
                              next[i] = e.target.value;
                              setKeys(next);
                            }}
                            disabled={!accepted[i]}
                            placeholder="data key"
                            className="h-7 text-xs font-mono flex-1 min-w-0"
                          />
                          {p.label && p.label !== keys[i] && (
                            <span
                              className="text-[11px] text-gray-400 truncate max-w-[120px]"
                              title={p.label}
                            >
                              {p.label}
                            </span>
                          )}
                          <span
                            className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium flex-shrink-0 ${src.cls}`}
                            title={`Detected via ${src.label}`}
                          >
                            {src.label}
                          </span>
                          <span
                            className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium flex-shrink-0 ${conf.cls}`}
                            title={`Confidence ${(p.confidence * 100).toFixed(0)}%`}
                          >
                            {conf.label}
                          </span>
                          {isDup && (
                            <span
                              className="text-[11px] text-amber-700 flex-shrink-0"
                              title="A widget with this data key already exists"
                            >
                              duplicate
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}

              {hasDups && (
                <div className="flex items-start gap-2 p-2 border border-amber-200 bg-amber-50 rounded text-xs text-amber-800">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                  <span>
                    Some accepted fields share a data key with an existing
                    widget — rename them, or accept the collision and they
                    will both bind to the same value at fill time.
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex sm:flex-row sm:items-center sm:justify-between gap-2">
          {/* Strategy selector lives on the left so it sits visually
              with the result list it controls, not with the apply
              button on the right. Disabled while a fetch is in flight
              to avoid stacking concurrent requests. */}
          <div className="flex items-center gap-2 mr-auto">
            <label className="text-xs text-gray-500">Strategy:</label>
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as Strategy)}
              disabled={loading}
              className="h-8 text-xs rounded border border-gray-300 bg-white px-2 disabled:opacity-50"
              title={STRATEGY_OPTIONS.find((o) => o.value === strategy)?.hint}
            >
              {STRATEGY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} title={o.hint}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            type="button"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={applyAccepted}
            disabled={loading || !resp || acceptedCount === 0}
            className="gap-2"
          >
            <CheckCircle2 className="h-4 w-4" />
            Apply {acceptedCount > 0 ? `${acceptedCount} field${acceptedCount === 1 ? "" : "s"}` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
