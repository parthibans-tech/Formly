"use client";

// Left-rail page thumbnail strip. Renders each page at a miniature scale
// and lets the user click to jump the main canvas. No drag-reorder — that
// would require server-side page reordering of the source PDF, which is
// out of scope for this designer.

import { Document, Page } from "react-pdf";
import { cn } from "@/lib/utils";

type Props = {
  previewUrl: string;
  numPages: number;
  currentPage: number;
  onJump: (pageNum: number) => void;
};

const THUMB_WIDTH = 96; // px

export function PageThumbnails({
  previewUrl,
  numPages,
  currentPage,
  onJump,
}: Props) {
  if (numPages === 0) return null;
  return (
    <aside className="w-[120px] shrink-0 overflow-y-auto border-r bg-muted/40 p-2">
      <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Pages
      </div>
      <Document file={previewUrl} loading={null} error={null}>
        <ul className="space-y-2">
          {Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
            <li key={p}>
              <button
                type="button"
                onClick={() => onJump(p)}
                className={cn(
                  "group block w-full rounded-md border-2 bg-background p-0.5 text-left transition-colors",
                  p === currentPage
                    ? "border-primary"
                    : "border-transparent hover:border-border"
                )}
                aria-label={`Jump to page ${p}`}
                aria-current={p === currentPage}
              >
                <div className="relative overflow-hidden rounded-sm shadow-sm">
                  <Page
                    pageNumber={p}
                    width={THUMB_WIDTH}
                    renderAnnotationLayer={false}
                    renderTextLayer={false}
                  />
                </div>
                <div className="mt-0.5 text-center font-mono text-[10px] text-muted-foreground">
                  {p}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </Document>
    </aside>
  );
}
