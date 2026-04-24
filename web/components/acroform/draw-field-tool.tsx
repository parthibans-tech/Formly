"use client";

// DrawFieldTool — overlay that captures a click+drag inside the page element
// and emits a new PDF-coordinate rect + page number. Used in "draw" edit
// mode to queue an add-text patch.
//
// Sits above the PDF but below resize handles (zIndex 3). Shows a dashed
// rubber-band rectangle while the pointer is down.

import { useRef, useState } from "react";
import type { FieldRect, PageSize } from "./types";
import type { RenderedPage } from "./pdf-preview";

type Props = {
  page: RenderedPage;
  pageSize: PageSize;
  onDraw: (rect: FieldRect, pageNum: number) => void;
};

const MIN_W_PDF = 20;
const MIN_H_PDF = 10;

export function DrawFieldTool({ page, pageSize, onDraw }: Props) {
  const [dragBox, setDragBox] = useState<null | {
    startX: number;
    startY: number;
    curX: number;
    curY: number;
  }>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  function onDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setDragBox({ startX: x, startY: y, curX: x, curY: y });
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
  }
  function onMove(e: React.PointerEvent) {
    if (!dragBox) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setDragBox((d) => (d ? { ...d, curX: x, curY: y } : d));
  }
  function onUp(e: React.PointerEvent) {
    if (!dragBox) return;
    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    const { startX, startY, curX, curY } = dragBox;
    setDragBox(null);

    const domLeft = Math.min(startX, curX);
    const domTop = Math.min(startY, curY);
    const domW = Math.abs(curX - startX);
    const domH = Math.abs(curY - startY);

    // DOM → PDF space.
    const scale = page.scale;
    const pdfW = domW / scale;
    const pdfH = domH / scale;
    if (pdfW < MIN_W_PDF || pdfH < MIN_H_PDF) return;

    const pdfX = domLeft / scale;
    // DOM top-y → PDF bottom-y: y_pdf = pageH - (domTop + domH) / scale
    const pdfY = pageSize.h - (domTop + domH) / scale;

    onDraw(
      {
        x: pdfX,
        y: pdfY,
        w: pdfW,
        h: pdfH,
      },
      page.pageNum
    );
  }

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
      ref={containerRef}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      className="pointer-events-auto absolute inset-0 cursor-crosshair"
      style={{ zIndex: 3 }}
    >
      {ghost && (
        <div
          className="pointer-events-none absolute border-2 border-dashed border-primary bg-primary/10"
          style={ghost}
        />
      )}
    </div>
  );
}
