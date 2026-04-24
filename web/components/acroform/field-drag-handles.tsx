"use client";

// FieldDragHandles — 8 corner/edge handles + body drag for moving/resizing
// a selected AcroForm field overlay. Emits PDF-coordinate rects via
// onPreview (during drag) and onCommit (on pointerup).
//
// PDF origin is bottom-left; DOM is top-left. Deltas are captured in DOM
// pixel space and converted to PDF units before applying to the rect.

import { useRef } from "react";
import type { FieldRect, PageSize } from "./types";
import type { RenderedPage } from "./pdf-preview";

type Handle =
  | "move"
  | "n"
  | "s"
  | "e"
  | "w"
  | "nw"
  | "ne"
  | "sw"
  | "se";

type Props = {
  rect: FieldRect;
  pageSize: PageSize;
  page: RenderedPage;
  onPreview: (rect: FieldRect) => void;
  onCommit: (rect: FieldRect) => void;
};

const MIN_W = 10;
const MIN_H = 8;

export function FieldDragHandles({ rect, pageSize: apiPageSize, page, onPreview, onCommit }: Props) {
  const scale = page.scale;
  // Use the ACTUAL rendered viewport dimensions — matches the Y-flip used
  // in field-overlay.tsx so handles always snap onto the overlay exactly,
  // even when the PDF's CropBox differs from MediaBox.
  const pageSize = {
    w: page.widthPx / scale || apiPageSize.w,
    h: page.heightPx / scale || apiPageSize.h,
  };
  const dragRef = useRef<{
    handle: Handle;
    startX: number;
    startY: number;
    origRect: FieldRect;
  } | null>(null);

  const left = rect.x * scale;
  const top = (pageSize.h - rect.y - rect.h) * scale;
  const width = rect.w * scale;
  const height = rect.h * scale;

  function begin(e: React.PointerEvent, handle: Handle) {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      handle,
      startX: e.clientX,
      startY: e.clientY,
      origRect: { ...rect },
    };

    function onMove(ev: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      const dx = (ev.clientX - d.startX) / scale;
      const dy = (ev.clientY - d.startY) / scale;
      onPreview(computeRect(d.origRect, d.handle, dx, dy, pageSize));
    }
    function onUp(ev: PointerEvent) {
      const d = dragRef.current;
      if (!d) {
        cleanup();
        return;
      }
      const dx = (ev.clientX - d.startX) / scale;
      const dy = (ev.clientY - d.startY) / scale;
      const final = computeRect(d.origRect, d.handle, dx, dy, pageSize);
      dragRef.current = null;
      cleanup();
      onCommit(final);
    }
    function cleanup() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const handleStyle = (cursor: string, cx: number, cy: number): React.CSSProperties => ({
    position: "absolute",
    left: cx - 4,
    top: cy - 4,
    width: 8,
    height: 8,
    background: "white",
    border: "1px solid hsl(var(--primary))",
    borderRadius: 2,
    cursor,
    zIndex: 5,
    pointerEvents: "auto",
  });

  return (
    <>
      {/* Body — drag to move, inset so corner/edge handles remain clickable. */}
      <div
        onPointerDown={(e) => begin(e, "move")}
        style={{
          position: "absolute",
          left: left + 4,
          top: top + 4,
          width: Math.max(0, width - 8),
          height: Math.max(0, height - 8),
          cursor: "move",
          zIndex: 4,
          pointerEvents: "auto",
        }}
      />
      <div style={handleStyle("nwse-resize", left, top)} onPointerDown={(e) => begin(e, "nw")} />
      <div style={handleStyle("ns-resize", left + width / 2, top)} onPointerDown={(e) => begin(e, "n")} />
      <div style={handleStyle("nesw-resize", left + width, top)} onPointerDown={(e) => begin(e, "ne")} />
      <div style={handleStyle("ew-resize", left, top + height / 2)} onPointerDown={(e) => begin(e, "w")} />
      <div style={handleStyle("ew-resize", left + width, top + height / 2)} onPointerDown={(e) => begin(e, "e")} />
      <div style={handleStyle("nesw-resize", left, top + height)} onPointerDown={(e) => begin(e, "sw")} />
      <div style={handleStyle("ns-resize", left + width / 2, top + height)} onPointerDown={(e) => begin(e, "s")} />
      <div style={handleStyle("nwse-resize", left + width, top + height)} onPointerDown={(e) => begin(e, "se")} />
    </>
  );
}

// computeRect applies a drag delta (already converted to PDF units) to the
// original rect. DOM dy is positive-downward; PDF dy is positive-upward, so
// the caller passes DOM dy here and we negate it internally.
function computeRect(
  orig: FieldRect,
  handle: Handle,
  dx: number,
  dy: number,
  page: PageSize
): FieldRect {
  let { x, y, w, h } = orig;
  const pdfDy = -dy;

  switch (handle) {
    case "move":
      x += dx;
      y += pdfDy;
      break;
    case "n":
      h += pdfDy;
      break;
    case "s":
      y += pdfDy;
      h -= pdfDy;
      break;
    case "e":
      w += dx;
      break;
    case "w":
      x += dx;
      w -= dx;
      break;
    case "ne":
      w += dx;
      h += pdfDy;
      break;
    case "nw":
      x += dx;
      w -= dx;
      h += pdfDy;
      break;
    case "se":
      w += dx;
      y += pdfDy;
      h -= pdfDy;
      break;
    case "sw":
      x += dx;
      w -= dx;
      y += pdfDy;
      h -= pdfDy;
      break;
  }

  if (w < MIN_W) {
    if (handle === "w" || handle === "nw" || handle === "sw") {
      x = orig.x + orig.w - MIN_W;
    }
    w = MIN_W;
  }
  if (h < MIN_H) {
    if (handle === "s" || handle === "sw" || handle === "se") {
      y = orig.y + orig.h - MIN_H;
    }
    h = MIN_H;
  }

  if (x < 0) {
    w += x;
    x = 0;
  }
  if (y < 0) {
    h += y;
    y = 0;
  }
  if (x + w > page.w) w = page.w - x;
  if (y + h > page.h) h = page.h - y;

  return { x, y, w, h };
}
