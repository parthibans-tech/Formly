"use client";

// Validation / QA panel for the static PDF designer.
// Runs a battery of checks against the current widget list and surfaces
// actionable issues that the author can click to jump to.
//
// Checks performed:
//   error   — widget outside page bounds
//   error   — widget has zero or negative size
//   warning — dataKey not found in sample JSON
//   warning — duplicate dataKey across multiple widgets
//   info    — data widget has no dataKey at all

import { useMemo } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { keyExists } from "@/lib/schema-utils";

export type ValidWidget = {
  id: string;
  type: string;
  page: number; // 1-indexed; 0 = every page
  x: number;
  y: number;    // PDF y (bottom-left origin)
  w: number;
  h: number;
  dataKey: string;
  props: Record<string, any>;
};

export type Issue = {
  id: string;
  widgetId: string;
  severity: "error" | "warning" | "info";
  message: string;
  detail?: string;
};

// Pure validation function — export so parent can memoize it for the badge count.
export function runValidation(
  widgets: ValidWidget[],
  pageDims: Record<number, { w: number; h: number }>,
  samplePaths: Set<string>
): Issue[] {
  const issues: Issue[] = [];

  // Types whose dataKey is optional (they render static content or derive from
  // layout, so a missing key is not a problem).
  const STATIC_TYPES = new Set(["rectangle", "line", "watermark", "pageNumber", "image"]);

  // Types where a missing dataKey means the widget will always render empty.
  const DATA_TYPES = new Set([
    "text", "number", "currency", "date", "multiline",
    "checkbox", "qr", "barcode", "signature", "repeat",
  ]);

  const keyMap = new Map<string, string[]>();

  for (const w of widgets) {
    if (w.props?._hidden) continue;

    // Determine the page dimension to check bounds against.
    // Page 0 widgets appear on every page — validate against page 1.
    const pageKey = w.page === 0 ? 1 : w.page;
    const dim = pageDims[pageKey];

    if (dim) {
      // PDF origin is bottom-left: y is the TOP of the widget in PDF coords.
      const widgetTop = w.y;
      const widgetBottom = w.y - w.h;
      const widgetLeft = w.x;
      const widgetRight = w.x + w.w;

      if (
        widgetLeft < 0 ||
        widgetBottom < 0 ||
        widgetRight > dim.w ||
        widgetTop > dim.h
      ) {
        issues.push({
          id: `oob-${w.id}`,
          widgetId: w.id,
          severity: "error",
          message: "Widget is outside page bounds",
          detail: `"${w.dataKey || w.type}" extends beyond the page edges — it will be clipped at render`,
        });
      }
    }

    // Zero / negative size.
    if (w.w <= 0 || w.h <= 0) {
      issues.push({
        id: `size-${w.id}`,
        widgetId: w.id,
        severity: "error",
        message: "Widget has zero or negative size",
        detail: `W=${w.w.toFixed(1)} pt, H=${w.h.toFixed(1)} pt — resize or delete it`,
      });
    }

    // dataKey missing from sample (only when sample is non-empty).
    if (
      w.dataKey &&
      !STATIC_TYPES.has(w.type) &&
      samplePaths.size > 0 &&
      !keyExists(samplePaths, w.dataKey)
    ) {
      issues.push({
        id: `key-${w.id}`,
        widgetId: w.id,
        severity: "warning",
        message: `dataKey "${w.dataKey}" not in sample`,
        detail: "Widget renders empty when the key is absent from the payload",
      });
    }

    // Data widget with no dataKey.
    if (DATA_TYPES.has(w.type) && !w.dataKey) {
      issues.push({
        id: `nokey-${w.id}`,
        widgetId: w.id,
        severity: "info",
        message: `${w.type} widget has no dataKey`,
        detail: "Bind a dataKey so it renders a real value, or delete if it is a placeholder",
      });
    }

    // Track duplicate dataKeys.
    if (w.dataKey) {
      const existing = keyMap.get(w.dataKey) ?? [];
      existing.push(w.id);
      keyMap.set(w.dataKey, existing);
    }
  }

  // Duplicate dataKey issues.
  for (const [key, ids] of keyMap.entries()) {
    if (ids.length > 1) {
      for (const id of ids) {
        issues.push({
          id: `dup-${id}`,
          widgetId: id,
          severity: "warning",
          message: `"${key}" is bound to ${ids.length} widgets`,
          detail: "All widgets sharing this dataKey display the same value — intentional for labels, otherwise a naming mistake",
        });
      }
    }
  }

  // Sort: errors first, then warnings, then info.
  const ORDER = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

// ---- Component ----

const SEVERITY_STYLES = {
  error: {
    row: "border-destructive/30 bg-destructive/5 text-destructive hover:bg-destructive/10",
    icon: AlertCircle,
  },
  warning: {
    row: "border-amber-400/40 bg-amber-50 text-amber-800 hover:bg-amber-100",
    icon: AlertTriangle,
  },
  info: {
    row: "border-blue-300/40 bg-blue-50/60 text-blue-800 hover:bg-blue-100/60",
    icon: Info,
  },
} as const;

type Props = {
  issues: Issue[];
  onSelectWidget: (id: string) => void;
};

export function ValidationPanel({ issues, onSelectWidget }: Props) {
  const errors   = useMemo(() => issues.filter((i) => i.severity === "error"),   [issues]);
  const warnings = useMemo(() => issues.filter((i) => i.severity === "warning"), [issues]);
  const infos    = useMemo(() => issues.filter((i) => i.severity === "info"),    [issues]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Validation
        </span>
        <span
          className={cn(
            "text-[10px] font-medium",
            errors.length > 0
              ? "text-destructive"
              : warnings.length > 0
              ? "text-amber-600"
              : "text-emerald-600"
          )}
        >
          {issues.length === 0
            ? "All clear"
            : `${issues.length} issue${issues.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {/* All-clear state */}
      {issues.length === 0 && (
        <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
          <CheckCircle2 className="h-9 w-9 text-emerald-500" />
          <p className="text-xs text-muted-foreground">
            No issues found. Template looks good!
          </p>
        </div>
      )}

      {/* Summary counts */}
      {issues.length > 0 && (
        <div className="flex gap-3 border-b px-3 pb-2 text-[11px]">
          {errors.length > 0 && (
            <span className="flex items-center gap-1 text-destructive">
              <AlertCircle className="h-3 w-3" />
              {errors.length} error{errors.length > 1 ? "s" : ""}
            </span>
          )}
          {warnings.length > 0 && (
            <span className="flex items-center gap-1 text-amber-600">
              <AlertTriangle className="h-3 w-3" />
              {warnings.length} warning{warnings.length > 1 ? "s" : ""}
            </span>
          )}
          {infos.length > 0 && (
            <span className="flex items-center gap-1 text-blue-600">
              <Info className="h-3 w-3" />
              {infos.length} info
            </span>
          )}
        </div>
      )}

      {/* Issue list */}
      {issues.length > 0 && (
        <div className="flex-1 space-y-1 overflow-y-auto p-2">
          {issues.map((issue) => {
            const { row, icon: Icon } = SEVERITY_STYLES[issue.severity];
            return (
              <button
                key={issue.id}
                type="button"
                onClick={() => onSelectWidget(issue.widgetId)}
                className={cn(
                  "w-full rounded border px-2 py-1.5 text-left text-[11px] transition-colors",
                  row
                )}
              >
                <div className="flex items-start gap-1.5">
                  <Icon className="mt-0.5 h-3 w-3 shrink-0" />
                  <div className="min-w-0">
                    <div className="font-medium leading-tight">{issue.message}</div>
                    {issue.detail && (
                      <div className="mt-0.5 text-[10px] opacity-75">{issue.detail}</div>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
