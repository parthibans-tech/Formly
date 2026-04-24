// Pure geometry helpers for align/distribute actions.
//
// All functions take a list of FieldRects and return a parallel list of
// updated FieldRects. Inputs are NOT mutated. Callers match the result
// back to field names by index.
//
// Coordinate space: PDF units, origin bottom-left. Everywhere else in
// the designer we use the same convention.

import type { FieldRect } from "./types";

export type AlignAxis =
  | "left"
  | "centerH"
  | "right"
  | "top"
  | "middleV"
  | "bottom";

export type DistributeAxis = "horizontal" | "vertical";
export type SizeAxis = "width" | "height";

// Align every rect to a shared edge or centerline computed from the
// extreme of the input list. Left/centerH/right anchor on X; top/bottom/
// middleV anchor on Y. Width/height are preserved.
export function alignRects(rects: FieldRect[], axis: AlignAxis): FieldRect[] {
  if (rects.length < 2) return rects;
  if (axis === "left") {
    const min = Math.min(...rects.map((r) => r.x));
    return rects.map((r) => ({ ...r, x: min }));
  }
  if (axis === "right") {
    const max = Math.max(...rects.map((r) => r.x + r.w));
    return rects.map((r) => ({ ...r, x: max - r.w }));
  }
  if (axis === "centerH") {
    // Use the average centerline so a single outlier doesn't pull the
    // whole group to one side.
    const avgCx =
      rects.reduce((s, r) => s + (r.x + r.w / 2), 0) / rects.length;
    return rects.map((r) => ({ ...r, x: avgCx - r.w / 2 }));
  }
  // Y-axis variants — remember PDF y grows UP, so "top" means higher y.
  if (axis === "top") {
    const max = Math.max(...rects.map((r) => r.y + r.h));
    return rects.map((r) => ({ ...r, y: max - r.h }));
  }
  if (axis === "bottom") {
    const min = Math.min(...rects.map((r) => r.y));
    return rects.map((r) => ({ ...r, y: min }));
  }
  // middleV
  const avgCy =
    rects.reduce((s, r) => s + (r.y + r.h / 2), 0) / rects.length;
  return rects.map((r) => ({ ...r, y: avgCy - r.h / 2 }));
}

// Distribute: spread rects evenly between the two extremes on the chosen
// axis. The first (min) and last (max) stay pinned; everything in between
// is repositioned so the gaps between centers are equal. Fewer than 3
// rects → no-op (nothing to distribute).
export function distributeRects(
  rects: FieldRect[],
  axis: DistributeAxis
): FieldRect[] {
  if (rects.length < 3) return rects;
  // Work on [index, rect] tuples so we can write back in original order.
  const indexed = rects.map((r, i) => ({ i, r }));
  const key = axis === "horizontal" ? "x" : "y";
  const size = axis === "horizontal" ? "w" : "h";
  const sorted = [...indexed].sort(
    (a, b) => a.r[key] + a.r[size] / 2 - (b.r[key] + b.r[size] / 2)
  );
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const firstCenter = first.r[key] + first.r[size] / 2;
  const lastCenter = last.r[key] + last.r[size] / 2;
  const step = (lastCenter - firstCenter) / (sorted.length - 1);
  const out = rects.slice();
  for (let k = 1; k < sorted.length - 1; k++) {
    const { i, r } = sorted[k];
    const targetCenter = firstCenter + step * k;
    const nextVal = targetCenter - r[size] / 2;
    out[i] = { ...r, [key]: nextVal } as FieldRect;
  }
  return out;
}

// Match-size: force every rect to the same width (or height) as the
// first rect in the list. The first rect is the "anchor" — typically
// the one the user shift-clicked last, but the caller decides.
export function matchSize(rects: FieldRect[], axis: SizeAxis): FieldRect[] {
  if (rects.length < 2) return rects;
  const key = axis === "width" ? "w" : "h";
  const anchor = rects[0][key];
  return rects.map((r, i) => (i === 0 ? r : { ...r, [key]: anchor }));
}
