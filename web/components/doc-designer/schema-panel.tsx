"use client";

/**
 * Schema panel — the sidebar listing every data field the template can
 * reference, grouped by (eventually) sample schema section.  Clicking a
 * field inserts it at the cursor; a format dropdown (currency/number/…)
 * lets authors pick how the value renders without leaving the panel.
 *
 * Extraction strategy: we don't require a formal JSON-Schema here.  The
 * caller passes a sample-data object (the same shape the preview renders
 * against) and we walk it to produce a flat list of dotted paths.  That
 * keeps the panel useful from day zero — as soon as an author drops a
 * sample payload into the template's sample-data tab, every leaf becomes
 * an insertable chip.
 *
 * Why not read from the AST's existing fields?  Two reasons:
 *   1. The author often wants to insert a *new* field they haven't used
 *      yet — the panel should surface every available path, not only the
 *      ones already bound.
 *   2. Sample data is the richer signal: it exposes types (number, date,
 *      array) which drive sensible format defaults.
 */

import React, { useMemo, useState } from "react";
import { Tag, Calendar, Hash, Percent, DollarSign, Braces, type LucideIcon } from "lucide-react";
import type { FieldFormat } from "@/lib/doc/ast";
import type { FieldRequest } from "./editor";

// ---------------------------------------------------------------------------
// Path extraction
// ---------------------------------------------------------------------------

export interface DataPath {
  /** Dotted path, e.g. "invoice.total". */
  path: string;
  /** Inferred kind — drives both the icon and the default FieldFormat. */
  kind: "text" | "number" | "date" | "currency" | "percent" | "list" | "object";
  /** Sample value stringified for tooltip / preview. */
  sample: string;
}

/** Flatten a plain data object into a list of leaf paths.  We deliberately
 *  stop at arrays: a Repeat block iterates the array, and inside the loop
 *  the fields of the element become available under the loop's alias (or
 *  top-level merge).  So exposing "lines[].total" as a pickable path would
 *  be misleading — the right abstraction is "wrap in Repeat, then pick
 *  fields of the item". */
export function extractPaths(data: unknown, prefix = ""): DataPath[] {
  if (data == null) return [];
  if (Array.isArray(data)) {
    if (prefix) {
      return [
        {
          path: prefix,
          kind: "list",
          sample: `array (${data.length} items)`,
        },
      ];
    }
    // Root-level array — recurse into first element to surface its leaves.
    if (data.length === 0) return [];
    return extractPaths(data[0], prefix);
  }
  if (typeof data === "object") {
    const out: DataPath[] = [];
    if (prefix) {
      // Give the object itself a row too — useful for "is defined" checks.
      out.push({
        path: prefix,
        kind: "object",
        sample: `object`,
      });
    }
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      const next = prefix ? `${prefix}.${k}` : k;
      out.push(...extractPaths(v, next));
    }
    return out;
  }
  // Leaf
  return [
    {
      path: prefix,
      kind: inferKind(data, prefix),
      sample: truncate(String(data)),
    },
  ];
}

function inferKind(v: unknown, path: string): DataPath["kind"] {
  if (typeof v === "number") {
    const low = path.toLowerCase();
    if (/(amount|price|total|subtotal|fee|cost)/.test(low)) return "currency";
    if (/(rate|percent|ratio|pct)/.test(low)) return "percent";
    return "number";
  }
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return "date";
    const low = path.toLowerCase();
    if (/(date|due|issued|created|updated)/.test(low)) return "date";
  }
  return "text";
}

function truncate(s: string, n = 40): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface SchemaPanelProps {
  /** Sample data object; the source of paths. */
  sample: unknown;
  /** Fields already referenced by the doc; renders a subtle "used" badge. */
  usedPaths?: Set<string>;
  /** Called when the user clicks a field — the shell inserts via editor. */
  onInsert: (req: FieldRequest) => void;
  className?: string;
}

export function SchemaPanel({
  sample,
  usedPaths,
  onInsert,
  className,
}: SchemaPanelProps) {
  const [query, setQuery] = useState("");
  const paths = useMemo(() => extractPaths(sample), [sample]);
  const filtered = useMemo(() => {
    if (!query.trim()) return paths;
    const q = query.toLowerCase();
    return paths.filter((p) => p.path.toLowerCase().includes(q));
  }, [paths, query]);

  return (
    <aside
      className={[
        "flex flex-col h-full border-l bg-muted/20 text-sm",
        className ?? "",
      ].join(" ")}
    >
      <div className="px-3 py-2 border-b flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Braces size={14} className="text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Data fields
          </span>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          className="w-full px-2 py-1 rounded border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      <div className="flex-1 overflow-auto py-1">
        {filtered.length === 0 ? (
          <EmptyState hasSample={paths.length > 0} />
        ) : (
          <ul>
            {filtered.map((p) => (
              <li key={p.path}>
                <FieldRow
                  info={p}
                  used={usedPaths?.has(p.path) ?? false}
                  onInsert={onInsert}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface RowProps {
  info: DataPath;
  used: boolean;
  onInsert: (req: FieldRequest) => void;
}

function FieldRow({ info, used, onInsert }: RowProps) {
  const Icon = iconFor(info.kind);
  const clickable = info.kind !== "list" && info.kind !== "object";

  const handleClick = () => {
    if (!clickable) return;
    onInsert({ path: info.path, format: defaultFormat(info.kind) });
  };

  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={handleClick}
      title={clickable ? `Insert {${info.path}}` : info.kind}
      // Authors often drag from the panel into the canvas.  TipTap handles
      // drops for us as long as the dragged text is the raw path.  The
      // editor extension for fields picks up common shortcuts too.
      draggable={clickable}
      onDragStart={(e) => {
        if (!clickable) return;
        e.dataTransfer.setData("text/plain", `{${info.path}}`);
        e.dataTransfer.setData("application/x-formly-field", info.path);
        e.dataTransfer.effectAllowed = "copy";
      }}
      className={[
        "w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs",
        clickable
          ? "hover:bg-accent/60 active:bg-accent cursor-pointer"
          : "opacity-60 cursor-default",
      ].join(" ")}
    >
      <Icon
        size={13}
        className={`shrink-0 ${colorFor(info.kind)}`}
      />
      <span className="flex-1 min-w-0">
        <span className="font-mono block truncate">{info.path}</span>
        <span className="block truncate text-[10px] text-muted-foreground">
          {info.sample}
        </span>
      </span>
      {used ? (
        <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground/80">
          used
        </span>
      ) : null}
    </button>
  );
}

function EmptyState({ hasSample }: { hasSample: boolean }) {
  return (
    <div className="px-3 py-6 text-xs text-muted-foreground leading-relaxed">
      {hasSample
        ? "No fields match your filter."
        : "Add sample data in the template's data tab to see pickable fields here."}
    </div>
  );
}

function iconFor(kind: DataPath["kind"]): LucideIcon {
  switch (kind) {
    case "currency":
      return DollarSign;
    case "percent":
      return Percent;
    case "number":
      return Hash;
    case "date":
      return Calendar;
    case "list":
    case "object":
      return Braces;
    default:
      return Tag;
  }
}

function colorFor(kind: DataPath["kind"]): string {
  switch (kind) {
    case "currency":
      return "text-emerald-600";
    case "percent":
    case "number":
      return "text-amber-600";
    case "date":
      return "text-violet-600";
    case "list":
    case "object":
      return "text-indigo-500";
    default:
      return "text-sky-600";
  }
}

function defaultFormat(kind: DataPath["kind"]): FieldFormat | undefined {
  switch (kind) {
    case "currency":
      return { kind: "currency", code: "USD" };
    case "percent":
      return { kind: "percent", decimals: 0 };
    case "number":
      return { kind: "number", decimals: 0 };
    case "date":
      return { kind: "date", pattern: "Jan 2, 2006" };
    default:
      return undefined;
  }
}
