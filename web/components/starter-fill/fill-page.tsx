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
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Palette,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { miniRender } from "@/lib/starters/mini-render";
import { autoSchemaFromSample } from "@/lib/starters/auto-schema";
import type { FormSchema, Starter } from "@/lib/starters/types";
import { StarterFillForm } from "./fill-form";

type Tab = "edit" | "customize" | "review";

interface Props {
  starter: Starter;
  alternates?: Starter[];
  onUse?: (data: Record<string, unknown>) => void | Promise<void>;
}

export function StarterFillPage({ starter, alternates = [], onUse }: Props) {
  const [data, setData] = useState<Record<string, unknown>>(
    () => structuredClone(starter.sampleData),
  );
  const [activeId, setActiveId] = useState(starter.id);
  const [tab, setTab] = useState<Tab>("edit");
  const [busy, setBusy] = useState(false);
  const [designOpen, setDesignOpen] = useState(false);

  const all = useMemo(() => [starter, ...alternates], [starter, alternates]);
  const active = useMemo(
    () => all.find((s) => s.id === activeId) ?? starter,
    [all, activeId, starter],
  );

  const previewHtml = useMemo(
    () => miniRender(active.html, data),
    [active.html, data],
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

        <Button
          size="sm"
          loading={busy}
          onClick={async () => {
            if (!onUse) return;
            setBusy(true);
            try {
              await onUse(data);
            } finally {
              setBusy(false);
            }
          }}
          className="gap-1"
        >
          <Download size={14} />
          Download
        </Button>
      </header>

      <div className="grid flex-1 min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,540px)_1fr]">
        {/* Left: form column */}
        <div className="min-h-0 overflow-y-auto border-r bg-background">
          <div className="mx-auto w-full max-w-[520px] px-6 py-6">
            <CompletenessBar value={completeness} />
            <div className="mt-6 grid grid-cols-2 gap-3">
              <ShortcutCard
                icon={<Sparkles size={14} />}
                label="Try AI profile summary"
              />
              <ShortcutCard
                icon={<FileText size={14} />}
                label="Create quick cover letter"
              />
            </div>
            <div className="mt-8">
              <StarterFillForm
                schema={schema}
                value={data}
                onChange={setData}
              />
            </div>
            <button
              type="button"
              className="mt-6 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
              Add more details
              <ChevronRight size={14} />
            </button>
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
              data={data}
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

function CompletenessBar({ value }: { value: number }) {
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
        <span className="font-medium text-muted-foreground">
          Resume completeness
        </span>
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
}: {
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent"
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
// Completeness scoring — counts non-empty leaf fields against total declared.
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
