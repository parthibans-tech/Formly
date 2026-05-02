// Inline-SVG chart primitives for the super-admin analytics surface.
//
// We deliberately avoid bringing in a chart library (recharts / visx /
// nivo) because:
//
//   1. The admin console already ships its own SVG sparklines — adding
//      a 100KB chart lib for ~6 dashboards is a bad bundle-vs-utility
//      trade.
//   2. These charts are read-only and don't need interactive zoom /
//      brush / animations. Hover tooltips are enough.
//   3. Operators look at this page for ~30 seconds — render time
//      matters more than animation polish.
//
// All components are responsive: the parent sets width/height via
// Tailwind classes, the SVG fills it via viewBox.

"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------

/** A single time-series point. `bucket` is RFC3339, `value` numeric. */
export type TimePoint = { bucket: string; value: number };

/** A categorical bucket (label + value). */
export type LabelValue = { label: string; value: number };

// ---------------------------------------------------------------------------
// Number formatting helpers — kept here so the charts and the surrounding
// page layout share the same conventions.
// ---------------------------------------------------------------------------

export function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  if (bytes < 1024 * 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  return (bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2) + " TB";
}

export function formatDay(iso: string): string {
  // Bucket strings come back in RFC3339 from the API; we only show
  // month/day in the chart axis to keep labels short.
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// LineChart — multi-series line, suitable for growth + churn overlays.
// ---------------------------------------------------------------------------

export type LineSeries = {
  name: string;
  color: string; // any CSS color (e.g. tailwind hex)
  data: TimePoint[];
};

export function LineChart({
  series,
  height = 180,
  formatY = formatCount,
}: {
  series: LineSeries[];
  height?: number;
  formatY?: (n: number) => string;
}) {
  const W = 600,
    H = height,
    PAD_L = 40,
    PAD_R = 12,
    PAD_T = 12,
    PAD_B = 28;
  const inner = { w: W - PAD_L - PAD_R, h: H - PAD_T - PAD_B };

  const allPoints = series.flatMap((s) => s.data);
  if (allPoints.length === 0) {
    return <EmptyState height={height} />;
  }
  const maxY = Math.max(1, ...allPoints.map((p) => p.value));
  const xs = allPoints.map((p) => new Date(p.bucket).getTime());
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const xSpan = Math.max(1, maxX - minX);

  function x(t: number) {
    return PAD_L + ((t - minX) / xSpan) * inner.w;
  }
  function y(v: number) {
    return PAD_T + inner.h - (v / maxY) * inner.h;
  }

  // Y-axis grid: 4 horizontal lines.
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxY * f));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
      {yTicks.map((t, i) => {
        const yy = y(t);
        return (
          <g key={i}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yy}
              y2={yy}
              className="stroke-muted-foreground/15"
              strokeWidth={1}
            />
            <text
              x={PAD_L - 4}
              y={yy + 3}
              textAnchor="end"
              className="fill-muted-foreground"
              fontSize={9}
            >
              {formatY(t)}
            </text>
          </g>
        );
      })}

      {series.map((s, si) => {
        if (s.data.length === 0) return null;
        const path = s.data
          .map((p, i) => {
            const px = x(new Date(p.bucket).getTime());
            const py = y(p.value);
            return `${i === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`;
          })
          .join(" ");
        return (
          <g key={si}>
            <path d={path} fill="none" stroke={s.color} strokeWidth={2} />
            {s.data.map((p, i) => {
              const px = x(new Date(p.bucket).getTime());
              const py = y(p.value);
              return (
                <circle key={i} cx={px} cy={py} r={2.5} fill={s.color}>
                  <title>{`${formatDay(p.bucket)} · ${s.name}: ${formatY(p.value)}`}</title>
                </circle>
              );
            })}
          </g>
        );
      })}

      {/* X-axis: first & last labels only — keeps things uncluttered. */}
      {series[0]?.data.length ? (
        <>
          <text
            x={PAD_L}
            y={H - 6}
            className="fill-muted-foreground"
            fontSize={9}
          >
            {formatDay(series[0].data[0]!.bucket)}
          </text>
          <text
            x={W - PAD_R}
            y={H - 6}
            textAnchor="end"
            className="fill-muted-foreground"
            fontSize={9}
          >
            {formatDay(series[0].data[series[0].data.length - 1]!.bucket)}
          </text>
        </>
      ) : null}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// BarChart — vertical bars, suitable for distributions / counts.
// ---------------------------------------------------------------------------

export function BarChart({
  data,
  height = 160,
  color = "hsl(var(--primary))",
  formatV = formatCount,
}: {
  data: LabelValue[];
  height?: number;
  color?: string;
  formatV?: (n: number) => string;
}) {
  const W = 600,
    H = height,
    PAD_L = 40,
    PAD_R = 12,
    PAD_T = 8,
    PAD_B = 36;
  const inner = { w: W - PAD_L - PAD_R, h: H - PAD_T - PAD_B };

  if (data.length === 0) return <EmptyState height={height} />;
  const maxV = Math.max(1, ...data.map((d) => d.value));
  const bw = inner.w / data.length;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
      {[0, 0.5, 1].map((f, i) => {
        const yy = PAD_T + inner.h - f * inner.h;
        const t = Math.round(maxV * f);
        return (
          <g key={i}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yy}
              y2={yy}
              className="stroke-muted-foreground/15"
              strokeWidth={1}
            />
            <text
              x={PAD_L - 4}
              y={yy + 3}
              textAnchor="end"
              className="fill-muted-foreground"
              fontSize={9}
            >
              {formatV(t)}
            </text>
          </g>
        );
      })}
      {data.map((d, i) => {
        const x = PAD_L + i * bw + bw * 0.15;
        const w = bw * 0.7;
        const h = (d.value / maxV) * inner.h;
        const y = PAD_T + inner.h - h;
        return (
          <g key={i}>
            <rect x={x} y={y} width={w} height={h} fill={color} rx={2}>
              <title>{`${d.label}: ${formatV(d.value)}`}</title>
            </rect>
            <text
              x={x + w / 2}
              y={H - 22}
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize={9}
            >
              {trimLabel(d.label, 10)}
            </text>
            <text
              x={x + w / 2}
              y={H - 10}
              textAnchor="middle"
              className="fill-foreground/70"
              fontSize={9}
              fontWeight={500}
            >
              {formatV(d.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function trimLabel(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---------------------------------------------------------------------------
// Donut — categorical share (plan distribution, role distribution).
// ---------------------------------------------------------------------------

const DONUT_COLORS = [
  "#3b82f6", // blue
  "#22c55e", // green
  "#f59e0b", // amber
  "#a855f7", // purple
  "#ef4444", // red
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
];

export function Donut({
  data,
  size = 140,
  centerLabel,
}: {
  data: LabelValue[];
  size?: number;
  centerLabel?: string;
}) {
  const total = data.reduce((acc, d) => acc + d.value, 0);
  if (total === 0) return <EmptyState height={size} />;
  const r = size / 2 - 4;
  const cx = size / 2,
    cy = size / 2;
  const stroke = 18;

  let acc = 0;
  const arcs = data.map((d, i) => {
    const startFrac = acc / total;
    acc += d.value;
    const endFrac = acc / total;
    const a0 = 2 * Math.PI * startFrac - Math.PI / 2;
    const a1 = 2 * Math.PI * endFrac - Math.PI / 2;
    const x0 = cx + r * Math.cos(a0);
    const y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);
    const large = endFrac - startFrac > 0.5 ? 1 : 0;
    return {
      d: `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`,
      color: DONUT_COLORS[i % DONUT_COLORS.length],
      label: d.label,
      value: d.value,
      pct: ((d.value / total) * 100).toFixed(1),
    };
  });

  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} className="shrink-0">
        {arcs.map((a, i) => (
          <path
            key={i}
            d={a.d}
            stroke={a.color}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="butt"
          >
            <title>{`${a.label}: ${a.value} (${a.pct}%)`}</title>
          </path>
        ))}
        <text
          x={cx}
          y={cy - 4}
          textAnchor="middle"
          className="fill-foreground"
          fontSize={14}
          fontWeight={600}
        >
          {formatCount(total)}
        </text>
        {centerLabel && (
          <text
            x={cx}
            y={cy + 12}
            textAnchor="middle"
            className="fill-muted-foreground"
            fontSize={9}
          >
            {centerLabel}
          </text>
        )}
      </svg>
      <ul className="flex-1 space-y-1 text-xs">
        {arcs.map((a, i) => (
          <li key={i} className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: a.color }}
            />
            <span className="min-w-0 flex-1 truncate">{a.label}</span>
            <span className="text-muted-foreground tabular-nums">
              {a.value} · {a.pct}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HourHeatmap — 24-bucket horizontal strip for "when does this user log in".
// ---------------------------------------------------------------------------

export function HourHeatmap({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-24 gap-[2px]" style={{ gridTemplateColumns: "repeat(24,minmax(0,1fr))" }}>
        {data.map((v, i) => {
          const intensity = v / max;
          // tailwind doesn't compute opacity dynamically — use rgba.
          const bg = `rgba(59,130,246,${0.1 + intensity * 0.9})`;
          return (
            <div
              key={i}
              title={`${i.toString().padStart(2, "0")}:00–${(i + 1).toString().padStart(2, "0")}:00 — ${v} events`}
              className="aspect-square rounded-sm"
              style={{ backgroundColor: v === 0 ? "rgba(127,127,127,0.1)" : bg }}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[9px] text-muted-foreground">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CohortBar — paired bars (total vs retained) per cohort week.
// ---------------------------------------------------------------------------

export function CohortBars({
  cohorts,
}: {
  cohorts: { cohort: string; total: number; active: number }[];
}) {
  if (cohorts.length === 0) return <EmptyState height={140} />;
  const max = Math.max(1, ...cohorts.map((c) => c.total));
  return (
    <div className="space-y-2">
      {cohorts.map((c) => {
        const totalPct = (c.total / max) * 100;
        const activePct = (c.active / max) * 100;
        const retention = c.total === 0 ? 0 : (c.active / c.total) * 100;
        return (
          <div key={c.cohort} className="space-y-0.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground">
                Week of {formatDay(c.cohort)}
              </span>
              <span className="tabular-nums">
                {c.active}/{c.total}{" "}
                <span className="text-muted-foreground">
                  · {retention.toFixed(0)}%
                </span>
              </span>
            </div>
            <div className="relative h-3 overflow-hidden rounded-sm bg-muted">
              <div
                className="absolute inset-y-0 left-0 bg-muted-foreground/30"
                style={{ width: `${totalPct}%` }}
              />
              <div
                className="absolute inset-y-0 left-0 bg-emerald-500/70"
                style={{ width: `${activePct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TopList — labelled bar list. Used for "top orgs by users / storage / revenue"
// and "top engaged users".
// ---------------------------------------------------------------------------

export function TopList({
  items,
  formatV = formatCount,
  href,
  emptyLabel = "No data",
}: {
  items: { id?: string; label: string; value: number; sub?: string }[];
  formatV?: (n: number) => string;
  /** if provided, returns the href for the row id (e.g. detail page). */
  href?: (id: string) => string;
  emptyLabel?: string;
}) {
  if (items.length === 0) {
    return (
      <p className="rounded-md border border-dashed bg-muted/20 p-6 text-center text-xs text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => {
        const w = (it.value / max) * 100;
        const inner = (
          <div className="group relative overflow-hidden rounded-sm border bg-card px-2 py-1.5">
            <div
              className="absolute inset-y-0 left-0 bg-primary/8 transition-colors group-hover:bg-primary/15"
              style={{ width: `${w}%` }}
            />
            <div className="relative flex items-baseline justify-between gap-2 text-xs">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{it.label}</div>
                {it.sub && (
                  <div className="truncate text-[10px] text-muted-foreground">
                    {it.sub}
                  </div>
                )}
              </div>
              <span className="tabular-nums">{formatV(it.value)}</span>
            </div>
          </div>
        );
        return (
          <li key={it.id ?? i}>
            {href && it.id ? (
              <a href={href(it.id)} className="block hover:no-underline">
                {inner}
              </a>
            ) : (
              inner
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// KpiTile — compact metric card with optional trend chip.
// ---------------------------------------------------------------------------

export function KpiTile({
  label,
  value,
  sublabel,
  className,
}: {
  label: string;
  value: React.ReactNode;
  sublabel?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-md border bg-card p-3", className)}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sublabel && (
        <div className="mt-0.5 text-[11px] text-muted-foreground">{sublabel}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state placeholder — used by every chart so the layout doesn't jump
// to zero height while the data loads.
// ---------------------------------------------------------------------------

function EmptyState({ height = 160 }: { height?: number }) {
  return (
    <div
      style={{ height }}
      className="grid place-items-center rounded-md border border-dashed bg-muted/20 text-xs text-muted-foreground"
    >
      No data in this window.
    </div>
  );
}
