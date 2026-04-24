"use client";

// PdfPreview — renders an entire PDF via react-pdf, calling back with the
// rendered DOM dimensions for each page so field overlays can be drawn
// on top in correct coordinates.

import { useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import { Loader2 } from "lucide-react";

// Point the PDF.js worker at the locally-bundled file.
// The copy of pdfjs-dist shipped with react-pdf exposes the worker under /build/.
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.js`;

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
  overlayForPage: (rp: RenderedPage) => React.ReactNode;
  onPageClick?: (pageNum: number) => void;
};

export function PdfPreview({ url, scale = 1, overlayForPage }: Props) {
  const [numPages, setNumPages] = useState<number | null>(null);
  const [rendered, setRendered] = useState<Record<number, RenderedPage>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const file = useMemo(() => ({ url, withCredentials: false }), [url]);

  // Auto-fit: compute a scale that makes the PDF fit the container width.
  const [autoScale, setAutoScale] = useState<number>(scale);
  useEffect(() => {
    function measure() {
      const w = containerRef.current?.clientWidth ?? 800;
      setAutoScale(Math.min(2, Math.max(0.5, (w - 32) / 612))); // 612pt = US Letter
    }
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-y-auto bg-muted/40 py-4"
    >
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
            return (
              <div
                key={pageNum}
                ref={(el) => {
                  pageRefs.current[pageNum] = el;
                }}
                data-page={pageNum}
                className="relative mx-auto mb-6 shadow-sm ring-1 ring-border"
                style={{ width: rp ? rp.widthPx : undefined }}
              >
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
                    setRendered((prev) => ({
                      ...prev,
                      [pageNum]: {
                        pageNum,
                        widthPx: viewport.width,
                        heightPx: viewport.height,
                        scale: autoScale,
                        element: pageRefs.current[pageNum] ?? null,
                      },
                    }));
                  }}
                />
                {rp && overlayForPage(rp)}
              </div>
            );
          })}
      </Document>
    </div>
  );
}
