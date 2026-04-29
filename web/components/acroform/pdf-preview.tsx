"use client";

// PdfPreview — renders an entire PDF via react-pdf, calling back with the
// rendered DOM dimensions for each page so field overlays can be drawn
// on top in correct coordinates.
//
// Virtualization
// --------------
// Huge PDFs (hundreds or thousands of pages) would otherwise mount a
// <Page> (a Canvas) for every page upfront — ~3 MB per canvas kills the
// tab. We keep a stable scrollable spine of placeholder divs (one per
// page) so the scrollbar doesn't jump, and only mount the real <Page>
// for pages whose placeholder is inside the viewport, plus a BUFFER on
// either side so scrolling feels immediate.
//
// Once a page renders we cache its widthPx/heightPx in `rendered` so
// later mounts (same page scrolled back into view) reuse the same
// placeholder size without a layout jump. We don't cache the element
// itself — overlay rendering only needs the dimensions.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Maximize2,
  Minus,
  Plus,
} from "lucide-react";

// Point the PDF.js worker at our self-hosted copy in /public/pdf-worker/.
// The file is copied there by package.json's postinstall script from
// node_modules/pdfjs-dist/build/pdf.worker.min.js, so it stays in lockstep
// with the pinned pdfjs-dist version. Self-hosting matters because:
//   1. The default Next.js CSP blocks //unpkg.com/* (cross-origin script).
//   2. unpkg has had multi-hour outages in the past — we don't want PDF
//      preview to depend on a third-party CDN's uptime.
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf-worker/pdf.worker.min.js";

export type RenderedPage = {
  pageNum: number;
  widthPx: number;
  heightPx: number;
  scale: number;
  element: HTMLElement | null;
};

type Props = {
  url: string;
  scale?: number;
  // Render pages within ±BUFFER of the viewport. 2 is a good default —
  // enough that scrolling rarely shows a blank placeholder, small enough
  // that memory stays bounded at ~5 canvases at a time.
  buffer?: number;
  overlayForPage: (rp: RenderedPage) => React.ReactNode;
  onPageClick?: (pageNum: number) => void;
};

const US_LETTER_W = 612;
const US_LETTER_H = 792;

// Zoom bounds. The fit-to-width scale is the "1×" baseline — the user's
// zoom multiplier applies on top of it. Hard caps keep memory and render
// latency bounded; PDF.js canvases get expensive quickly past 3×.
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function PdfPreview({ url, scale = 1, buffer = 2, overlayForPage }: Props) {
  const [numPages, setNumPages] = useState<number | null>(null);
  const [rendered, setRendered] = useState<Record<number, RenderedPage>>({});
  const [visiblePages, setVisiblePages] = useState<Set<number>>(() => new Set([1]));
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const observerRef = useRef<IntersectionObserver | null>(null);

  const file = useMemo(() => ({ url, withCredentials: false }), [url]);

  // Auto-fit: compute a scale that makes the PDF fit the container width.
  // This is the "fit" baseline; the `zoom` multiplier below scales on top
  // of it so zoom behaves naturally regardless of container width.
  const [fitScale, setFitScale] = useState<number>(scale);
  useEffect(() => {
    function measure() {
      const w = containerRef.current?.clientWidth ?? 800;
      setFitScale(Math.min(2, Math.max(0.5, (w - 32) / US_LETTER_W)));
    }
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // User zoom multiplier on top of fit-to-width. 1 = fit. Separated from
  // `fitScale` so resizing the panel doesn't fight the user's zoom.
  const [zoom, setZoom] = useState<number>(1);
  const autoScale = fitScale * zoom;

  const stepZoom = useCallback((dir: 1 | -1) => {
    setZoom((cur) => {
      if (dir > 0) {
        const next = ZOOM_STEPS.find((z) => z > cur + 1e-6);
        return next ?? ZOOM_MAX;
      }
      const prev = [...ZOOM_STEPS].reverse().find((z) => z < cur - 1e-6);
      return prev ?? ZOOM_MIN;
    });
  }, []);

  // Keyboard: Cmd/Ctrl +/=, Cmd/Ctrl -, Cmd/Ctrl 0 (reset). Skip when
  // typing in an input so we don't hijack browser find-in-page etc.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        stepZoom(1);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        stepZoom(-1);
      } else if (e.key === "0") {
        e.preventDefault();
        setZoom(1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepZoom]);

  // Build an IntersectionObserver keyed to the scroll container. It flips
  // entries in `visiblePages` as placeholders cross the viewport edge.
  // rootMargin adds a modest pre-fetch window so a fast scroll doesn't
  // reveal blank pages before the buffer expansion catches up.
  useEffect(() => {
    if (!numPages || !containerRef.current) return;
    const io = new IntersectionObserver(
      (entries) => {
        setVisiblePages((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const e of entries) {
            const raw = (e.target as HTMLElement).dataset.page;
            if (!raw) continue;
            const p = Number(raw);
            if (!p) continue;
            if (e.isIntersecting) {
              if (!next.has(p)) {
                next.add(p);
                changed = true;
              }
            } else if (next.has(p)) {
              next.delete(p);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      {
        root: containerRef.current,
        rootMargin: "400px 0px",
        threshold: 0,
      }
    );
    observerRef.current = io;
    // Observe whatever placeholders are already mounted.
    for (const el of Object.values(pageRefs.current)) {
      if (el) io.observe(el);
    }
    return () => {
      io.disconnect();
      observerRef.current = null;
    };
  }, [numPages]);

  // Ref callback that attaches a page's placeholder element AND registers
  // it with the live IntersectionObserver. Keeps observe/unobserve in
  // lockstep with mount/unmount.
  const setPageRef = useCallback(
    (pageNum: number) => (el: HTMLDivElement | null) => {
      const prev = pageRefs.current[pageNum];
      if (prev && prev !== el) observerRef.current?.unobserve(prev);
      pageRefs.current[pageNum] = el;
      if (el) observerRef.current?.observe(el);
    },
    []
  );

  // Expand the visible set by `buffer` on either side. Pages in this set
  // get a real <Page>; everything else stays as a sized placeholder.
  const toRender = useMemo(() => {
    if (!numPages) return new Set<number>();
    const s = new Set<number>();
    for (const p of visiblePages) {
      const lo = Math.max(1, p - buffer);
      const hi = Math.min(numPages, p + buffer);
      for (let i = lo; i <= hi; i++) s.add(i);
    }
    // Always keep page 1 primed so the initial landing state shows
    // something even if IO hasn't fired yet.
    if (s.size === 0) s.add(1);
    return s;
  }, [visiblePages, numPages, buffer]);

  // Default placeholder dimensions. Once we've rendered ANY page, use its
  // size as the default for still-unmeasured pages — most PDFs have
  // uniform page sizes and this makes the scrollbar less jumpy.
  // Current page (for the jump control). Pick the lowest-numbered
  // visible page — it's the one the user is most likely looking at
  // the top of.
  const currentPage = useMemo(() => {
    if (visiblePages.size === 0) return 1;
    let min = Infinity;
    for (const p of visiblePages) if (p < min) min = p;
    return Number.isFinite(min) ? min : 1;
  }, [visiblePages]);

  function jumpTo(pageNum: number) {
    if (!numPages) return;
    const clamped = Math.max(1, Math.min(numPages, Math.floor(pageNum)));
    const el = pageRefs.current[clamped];
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  const defaultSize = useMemo(() => {
    const first = rendered[1];
    if (first) return { w: first.widthPx, h: first.heightPx };
    // Fall back to any rendered page.
    for (const k of Object.keys(rendered)) {
      const rp = rendered[Number(k)];
      if (rp) return { w: rp.widthPx, h: rp.heightPx };
    }
    return { w: US_LETTER_W * autoScale, h: US_LETTER_H * autoScale };
  }, [rendered, autoScale]);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-y-auto bg-muted/40 py-4"
    >
      <TopControls
        showPageJumper={!!numPages && numPages > 1}
        currentPage={currentPage}
        totalPages={numPages ?? 1}
        onJump={jumpTo}
        zoom={zoom}
        onZoomIn={() => stepZoom(1)}
        onZoomOut={() => stepZoom(-1)}
        onZoomReset={() => setZoom(1)}
      />

      <Document
        file={file}
        onLoadSuccess={({ numPages: n }) => setNumPages(n)}
        loading={
          <div className="flex items-center justify-center p-10 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading PDF…
          </div>
        }
        error={
          <div className="p-10 text-center text-sm text-destructive">
            Failed to load PDF.
          </div>
        }
      >
        {numPages &&
          Array.from({ length: numPages }, (_, i) => {
            const pageNum = i + 1;
            const rp = rendered[pageNum];
            const shouldRender = toRender.has(pageNum);
            const width = rp?.widthPx ?? defaultSize.w;
            const height = rp?.heightPx ?? defaultSize.h;
            return (
              <div
                key={pageNum}
                ref={setPageRef(pageNum)}
                data-page={pageNum}
                className="relative mx-auto mb-6 bg-white shadow-sm ring-1 ring-border"
                style={{
                  width,
                  // When a page is unmounted we still need a height so
                  // scroll offsets stay stable and IO fires correctly.
                  // For mounted pages, let <Page> set its own height so
                  // we don't fight its canvas.
                  height: shouldRender ? undefined : height,
                }}
              >
                {shouldRender ? (
                  <Page
                    pageNumber={pageNum}
                    scale={autoScale}
                    renderTextLayer={false}
                    renderAnnotationLayer={false}
                    onRenderSuccess={(pg) => {
                      const viewport = pg.getViewport
                        ? pg.getViewport({ scale: autoScale })
                        : null;
                      if (!viewport) return;
                      setRendered((prev) => {
                        const existing = prev[pageNum];
                        if (
                          existing &&
                          existing.widthPx === viewport.width &&
                          existing.heightPx === viewport.height &&
                          existing.scale === autoScale
                        ) {
                          return prev;
                        }
                        return {
                          ...prev,
                          [pageNum]: {
                            pageNum,
                            widthPx: viewport.width,
                            heightPx: viewport.height,
                            scale: autoScale,
                            element: pageRefs.current[pageNum] ?? null,
                          },
                        };
                      });
                    }}
                  />
                ) : (
                  <div
                    className="flex h-full items-center justify-center text-[11px] text-muted-foreground"
                    aria-hidden
                  >
                    Page {pageNum}
                  </div>
                )}
                {shouldRender && rp && overlayForPage(rp)}
              </div>
            );
          })}
      </Document>
    </div>
  );
}

// TopControls — sticky toolbar at the top of the PDF pane, hosting the
// zoom controls (always shown) and the page jumper (only when >1 page).
// Kept as one container so the layout stays coherent when one or both
// sub-controls are present.
function TopControls({
  showPageJumper,
  currentPage,
  totalPages,
  onJump,
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomReset,
}: {
  showPageJumper: boolean;
  currentPage: number;
  totalPages: number;
  onJump: (p: number) => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
}) {
  return (
    <div className="pointer-events-none sticky top-2 z-20 flex justify-center gap-1.5">
      <ZoomControls
        zoom={zoom}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onZoomReset={onZoomReset}
      />
      {showPageJumper && (
        <PageJumper
          current={currentPage}
          total={totalPages}
          onJump={onJump}
        />
      )}
    </div>
  );
}

// ZoomControls — small toolbar with −, live %, +, and reset (fit-to-width).
// The % label doubles as a "reset to 100%" button when clicked, matching
// common PDF viewer conventions (⌘0 is the keyboard equivalent).
function ZoomControls({
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomReset,
}: {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
}) {
  const pct = Math.round(zoom * 100);
  return (
    <div className="pointer-events-auto inline-flex items-center gap-0.5 rounded-md border bg-background/95 px-1 py-1 text-xs shadow-sm backdrop-blur">
      <button
        type="button"
        className="flex h-6 w-6 items-center justify-center rounded hover:bg-muted disabled:opacity-40"
        onClick={onZoomOut}
        disabled={zoom <= ZOOM_MIN + 1e-6}
        aria-label="Zoom out"
        title="Zoom out (⌘−)"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onZoomReset}
        className="h-6 min-w-[3rem] rounded px-1.5 text-center tabular-nums hover:bg-muted"
        title="Reset to fit (⌘0)"
      >
        {pct}%
      </button>
      <button
        type="button"
        className="flex h-6 w-6 items-center justify-center rounded hover:bg-muted disabled:opacity-40"
        onClick={onZoomIn}
        disabled={zoom >= ZOOM_MAX - 1e-6}
        aria-label="Zoom in"
        title="Zoom in (⌘+)"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      <div className="mx-0.5 h-4 w-px bg-border" aria-hidden />
      <button
        type="button"
        className="flex h-6 w-6 items-center justify-center rounded hover:bg-muted"
        onClick={onZoomReset}
        aria-label="Fit to width"
        title="Fit to width"
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// PageJumper — floating sticky control in the corner of the PDF pane.
// Keyboard-first: type a page number + Enter, or use ↑/↓ chevrons. Shown
// only for multi-page documents where scrolling alone isn't ergonomic.
function PageJumper({
  current,
  total,
  onJump,
}: {
  current: number;
  total: number;
  onJump: (p: number) => void;
}) {
  const [draft, setDraft] = useState<string>(String(current));
  const [focused, setFocused] = useState(false);

  // Keep the visible number in sync with scroll position, except while
  // the user is actively editing the input.
  useEffect(() => {
    if (!focused) setDraft(String(current));
  }, [current, focused]);

  function commit() {
    const n = Number(draft);
    if (Number.isFinite(n) && n >= 1 && n <= total) onJump(n);
    else setDraft(String(current));
  }

  return (
    <div className="pointer-events-auto inline-flex items-center gap-1 rounded-md border bg-background/95 px-1.5 py-1 text-xs shadow-sm backdrop-blur">
      <button
        type="button"
        className="flex h-6 w-6 items-center justify-center rounded hover:bg-muted disabled:opacity-40"
        onClick={() => onJump(current - 1)}
        disabled={current <= 1}
        aria-label="Previous page"
      >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <input
          type="text"
          inputMode="numeric"
          className="h-6 w-10 rounded border bg-background px-1 text-center text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
          onFocus={(e) => {
            setFocused(true);
            e.currentTarget.select();
          }}
          onBlur={() => {
            setFocused(false);
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              setDraft(String(current));
              (e.target as HTMLInputElement).blur();
            }
          }}
          aria-label="Page number"
        />
        <span className="text-muted-foreground">/ {total}</span>
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center rounded hover:bg-muted disabled:opacity-40"
          onClick={() => onJump(current + 1)}
          disabled={current >= total}
          aria-label="Next page"
        >
          <ChevronDown className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
