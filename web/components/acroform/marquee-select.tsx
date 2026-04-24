"use client";

// MarqueeSelect — rubber-band selection overlay for the "Edit" edit mode.
//
// Why this exists
// ---------------
// The mapping-list checkboxes handle multi-select from the right panel, but
// for layout work (align, distribute, bulk nudge) the user needs to select
// fields spatially on the PDF itself. This component draws a dashed
// rectangle while the user drags in empty space on a page and on pointerup
// reports which fields on THIS page intersect the rectangle.
//
// Placement
// ---------
// Rendered FIRST inside <FieldOverlay> so the field <button>s paint on top.
// Field buttons are pointer-events-auto and only cover their own rect, so:
//   • pointerdown on a field → the field's own handler runs
//   • pointerdown in empty area → this component captures the drag
// FieldDragHandles live at z-index 4+ so they also still win over the
// marquee when a field is selected in Edit mode.
//
// Coordinates
// -----------
// The ghost rectangle is tracked in DOM pixels; conversion to PDF
// coordinates happens only at pointerup, where we intersect against each
// field's rect (which the caller passes in its native PDF-space form).

import { useCallback, useRef, useState } from "react";
import type { AcroFormField, FieldRect } from "./types";
import type { RenderedPage } from "./pdf-preview";

type Props = {
  page: RenderedPage;
  fields: AcroFormField[];
  // Current spatial selection. We merge with shift-drag additions.
  selectedNames: Set<string>;
  onSelect: (names: string[], opts: { additive: boolean }) => void;
  onClearSelection?: () => void;
};

// Minimum drag size before we treat it as a marquee. Below this we treat
// the pointerdown as a click on empty space and clear the selection so
// the user can deselect by tapping the page background.
const MIN_DRAG_PX = 4;

export function MarqueeSelect({
  page,
  fields,
  selectedNames,
  onSelect,
  onClearSelection,
}: Props) {
  const [dragBox, setDragBox] = useState<null | {
    startX: number;
    startY: number;
    curX: number;
    curY: number;
    additive: boolean;
  }>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const onDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Left click only; ignore context menu and middle-click pan.
      if (e.button !== 0) return;
      // Don't consume modifier-less pointerdowns that originated on a
      // field button — the field's own onClick handles them. But since
      // this overlay sits BEHIND the field buttons, we only receive
      // events from empty space, so no explicit check needed.
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      setDragBox({ startX: x, startY: y, curX: x, curY: y, additive });
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    []
  );

  const onMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    setDragBox((d) => {
      if (!d) return d;
      const rect = e.currentTarget.getBoundingClientRect();
      return {
        ...d,
        curX: e.clientX - rect.left,
        curY: e.clientY - rect.top,
      };
    });
  }, []);

  const onUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = dragBox;
      setDragBox(null);
      if (!d) return;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Capture may already be released if the pointer left the window;
        // harmless to ignore.
      }
      const dx = Math.abs(d.curX - d.startX);
      const dy = Math.abs(d.curY - d.startY);
      if (dx < MIN_DRAG_PX && dy < MIN_DRAG_PX) {
        // Treat as a background click → clear selection unless additive.
        if (!d.additive && onClearSelection) onClearSelection();
        return;
      }
      // DOM pixel rect of the marquee.
      const scale = page.scale;
      const pageH = page.heightPx / scale;
      const domLeft = Math.min(d.startX, d.curX);
      const domTop = Math.min(d.startY, d.curY);
      const domW = dx;
      const domH = dy;
      // Convert marquee to PDF coords. DOM top-origin → PDF bottom-origin
      // means the marquee's top edge in DOM maps to the HIGHER y in PDF
      // space. Build a PDF-space AABB for intersection testing.
      const mx = domLeft / scale;
      const mw = domW / scale;
      const myTop = domTop / scale;
      const mhPdf = domH / scale;
      const my = pageH - (myTop + mhPdf); // PDF y of bottom edge
      const marquee = { x: mx, y: my, w: mw, h: mhPdf };
      const hits: string[] = [];
      for (const f of fields) {
        if (!f.rect) continue;
        if (rectsIntersect(marquee, f.rect)) hits.push(f.name);
      }
      onSelect(hits, { additive: d.additive });
    },
    [dragBox, fields, onSelect, onClearSelection, page.scale, page.heightPx]
  );

  const ghost = dragBox
    ? {
        left: Math.min(dragBox.startX, dragBox.curX),
        top: Math.min(dragBox.startY, dragBox.curY),
        width: Math.abs(dragBox.curX - dragBox.startX),
        height: Math.abs(dragBox.curY - dragBox.startY),
      }
    : null;

  return (
    <div
      ref={rootRef}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      // No explicit z-index. CSS stacking within a common parent puts
      // positioned, z:auto siblings in tree order — since this overlay
      // is rendered BEFORE the field <button>s in FieldOverlay, the
      // buttons paint on top and eat their own clicks. Drag handles
      // explicitly set z-index: 4/5 so they also stay above this.
      className="pointer-events-auto absolute inset-0"
      style={{ cursor: "crosshair" }}
    >
      {ghost && (
        <div
          className="pointer-events-none absolute border border-dashed border-primary bg-primary/10"
          style={ghost}
        />
      )}
      {/* We don't render anything reflecting `selectedNames` directly —
          the FieldOverlay handles the per-field selected styling via the
          selectedNames set passed up through MarqueeSelect into the
          designer's multiSelected state. */}
    </div>
  );
}

function rectsIntersect(a: FieldRect, b: FieldRect): boolean {
  return !(
    a.x + a.w < b.x ||
    b.x + b.w < a.x ||
    a.y + a.h < b.y ||
    b.y + b.h < a.y
  );
}
