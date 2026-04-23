// Pure geometry helpers used by the static PDF designer. All math is in
// PDF points with the PDF coordinate convention: (x, y) is the *bottom-left*
// corner of a widget, w extends right, h extends *up*. Browser conversion
// happens at render time via pdf-coords.ts.

export type WRect = { x: number; y: number; w: number; h: number };

// A single guide line that should render while the user is dragging.
// `position` is in PDF units for the page the drag is happening on.
export type GuideLine =
  | { kind: "vertical"; x: number }
  | { kind: "horizontal"; y: number };

// Snap tolerance in PDF points. ~3pt feels good at 1.5× zoom.
export const SNAP_THRESHOLD = 3;

// Bounding box enclosing an arbitrary set of widgets. Used when the user
// is dragging a multi-selection — we snap the group's outer bounds rather
// than each individual widget (Figma behaviour).
export function boundingBox(rects: WRect[]): WRect | null {
  if (rects.length === 0) return null;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const r of rects) {
    const left = r.x;
    const right = r.x + r.w;
    const bottom = r.y;
    const top = r.y + r.h;
    if (left < minX) minX = left;
    if (right > maxX) maxX = right;
    if (bottom < minY) minY = bottom;
    if (top > maxY) maxY = top;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Compute a snapped (dx, dy) plus the set of guide lines to draw. Called
// on every mousemove during a move-drag; returning the original delta
// untouched is the no-snap case.
export function computeMoveSnap(
  movingBBox: WRect,
  others: WRect[],
  page: { w: number; h: number },
  desiredDx: number,
  desiredDy: number,
  threshold = SNAP_THRESHOLD
): { dx: number; dy: number; guides: GuideLine[] } {
  const guides: GuideLine[] = [];
  // Tentative edge positions of the group after applying the raw delta.
  const bb = {
    left: movingBBox.x + desiredDx,
    right: movingBBox.x + movingBBox.w + desiredDx,
    centerX: movingBBox.x + movingBBox.w / 2 + desiredDx,
    top: movingBBox.y + movingBBox.h + desiredDy,
    bottom: movingBBox.y + desiredDy,
    centerY: movingBBox.y + movingBBox.h / 2 + desiredDy,
  };

  // X candidates: page edges + page center + every other widget's L/C/R.
  const xCand: number[] = [0, page.w, page.w / 2];
  for (const o of others) {
    xCand.push(o.x, o.x + o.w, o.x + o.w / 2);
  }
  // Y candidates (PDF: y grows up). Page edges + center + every other
  // widget's top/middle/bottom.
  const yCand: number[] = [0, page.h, page.h / 2];
  for (const o of others) {
    yCand.push(o.y, o.y + o.h, o.y + o.h / 2);
  }

  // Pick the single best-matching X snap across all three edges of the group.
  let bestX: { delta: number; target: number } | null = null;
  for (const target of xCand) {
    for (const val of [bb.left, bb.right, bb.centerX]) {
      const diff = target - val;
      if (Math.abs(diff) < threshold && (!bestX || Math.abs(diff) < Math.abs(bestX.delta))) {
        bestX = { delta: diff, target };
      }
    }
  }
  let dx = desiredDx;
  if (bestX) {
    dx += bestX.delta;
    guides.push({ kind: "vertical", x: bestX.target });
  }

  let bestY: { delta: number; target: number } | null = null;
  for (const target of yCand) {
    for (const val of [bb.top, bb.bottom, bb.centerY]) {
      const diff = target - val;
      if (Math.abs(diff) < threshold && (!bestY || Math.abs(diff) < Math.abs(bestY.delta))) {
        bestY = { delta: diff, target };
      }
    }
  }
  let dy = desiredDy;
  if (bestY) {
    dy += bestY.delta;
    guides.push({ kind: "horizontal", y: bestY.target });
  }

  return { dx, dy, guides };
}

// Test whether widget rect `a` overlaps rect `b` (marquee). Both use PDF
// convention (y = bottom-left). Used by marquee selection.
export function rectIntersects(a: WRect, b: WRect): boolean {
  const aLeft = a.x;
  const aRight = a.x + a.w;
  const aBottom = a.y;
  const aTop = a.y + a.h;
  const bLeft = b.x;
  const bRight = b.x + b.w;
  const bBottom = b.y;
  const bTop = b.y + b.h;
  if (aRight < bLeft || bRight < aLeft) return false;
  if (aTop < bBottom || bTop < aBottom) return false;
  return true;
}

// Handle labels for the 8-point resize grid. Position order:
//   NW  N  NE
//   W      E
//   SW  S  SE
// N/S are top/bottom in BROWSER space (which corresponds to PDF y+h / y
// respectively — see comment in `applyResize`).
export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

// Apply a raw cursor delta (dxPts, dyPts in PDF units, with
// dyPts > 0 === cursor moved *down* in browser === PDF y decreased) to the
// original widget rect for a given handle.
// Returns a candidate rect; caller clamps to min size.
export function applyResize(
  orig: WRect,
  handle: ResizeHandle,
  dxPts: number,
  dyPts: number
): WRect {
  let { x, y, w, h } = orig;
  // Horizontal
  if (handle === "nw" || handle === "w" || handle === "sw") {
    x = orig.x + dxPts;
    w = orig.w - dxPts;
  } else if (handle === "ne" || handle === "e" || handle === "se") {
    w = orig.w + dxPts;
  }
  // Vertical — note the PDF convention twist:
  //  • Browser TOP edge corresponds to PDF y+h. Dragging the top-edge down
  //    in the browser (dyPts > 0) shrinks the widget from the top, so h
  //    decreases and y stays.
  //  • Browser BOTTOM edge corresponds to PDF y. Dragging the bottom-edge
  //    down in the browser (dyPts > 0) means y decreases and h grows by
  //    the same amount (top stays anchored).
  if (handle === "nw" || handle === "n" || handle === "ne") {
    h = orig.h - dyPts;
    // y unchanged
  } else if (handle === "sw" || handle === "s" || handle === "se") {
    y = orig.y - dyPts;
    h = orig.h + dyPts;
  }
  return { x, y, w, h };
}

// Clamp the resized rect to a minimum size, keeping the anchored edge(s)
// consistent so the widget doesn't jump when the user overshoots.
export function clampResize(r: WRect, handle: ResizeHandle, minSize = 8): WRect {
  let { x, y, w, h } = r;
  if (w < minSize) {
    if (handle === "nw" || handle === "w" || handle === "sw") {
      // Left edge was moving; stop x from going past right edge.
      x = x - (minSize - w);
    }
    w = minSize;
  }
  if (h < minSize) {
    if (handle === "sw" || handle === "s" || handle === "se") {
      // Bottom edge was moving; stop y from going past top edge.
      y = y + (minSize - h);
    }
    h = minSize;
  }
  return { x, y, w, h };
}
