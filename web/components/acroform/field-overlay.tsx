"use client";

// FieldOverlay — absolute-positioned boxes drawn over a rendered PDF page
// for each AcroForm field. Click = select mapping row. Hover = tooltip.
//
// Visual states (priority high → low):
//   • selected   — primary ring
//   • error      — red solid border + red tint (when fieldErrors[name] present)
//   • skipped    — muted dashed + diagonal stripes (fillWhen evaluates false)
//   • mapped     — emerald
//   • unmapped   — amber dashed

import { cn } from "@/lib/utils";
import type { AcroFormField, FieldRect, MappingMap } from "./types";
import { applyTransformPipeline } from "@/lib/acroform-transforms";
import { shouldFill, type FieldError } from "@/lib/acroform-validation";
import type { RenderedPage } from "./pdf-preview";
import { FieldDragHandles } from "./field-drag-handles";
import { DrawFieldTool } from "./draw-field-tool";
import { MarqueeSelect } from "./marquee-select";

type Props = {
  page: RenderedPage;
  fields: AcroFormField[];
  mappings: MappingMap;
  selectedField: string | null;
  sampleData: Record<string, any>;
  fieldErrors?: Record<string, FieldError[]>;
  onSelect: (name: string, opts?: { additive?: boolean }) => void;
  // Tier C — edit mode.
  editMode?: "off" | "select" | "draw";
  draftRectsByField?: Record<string, FieldRect>; // in-progress previews
  onRectPreview?: (name: string, rect: FieldRect) => void;
  onRectCommit?: (name: string, rect: FieldRect, page: number) => void;
  onDrawNew?: (rect: FieldRect, page: number) => void;
  // Track 2 — marquee multi-select. Only rendered in "select" mode.
  multiSelected?: Set<string>;
  onMarqueeSelect?: (names: string[], opts: { additive: boolean }) => void;
  onClearMultiSelect?: () => void;
};

export function FieldOverlay({
  page,
  fields,
  mappings,
  selectedField,
  sampleData,
  fieldErrors = {},
  onSelect,
  editMode = "off",
  draftRectsByField = {},
  onRectPreview,
  onRectCommit,
  onDrawNew,
  multiSelected,
  onMarqueeSelect,
  onClearMultiSelect,
}: Props) {
  // `fields` is now pre-indexed by page upstream (see fieldsByPage in
  // acroform-designer.tsx). We still drop rect-less entries defensively
  // so a bad extract never throws inside the render.
  const pageFields = fields.length
    ? fields.filter((f) => f.rect)
    : fields;
  const selectedOnThisPage = pageFields.find((f) => f.name === selectedField);
  // Prefer the actual rendered viewport (accounts for CropBox + rotation);
  // fall back to the API-reported pageSize when viewport info is missing.
  const nativePageSize = {
    w: page.widthPx / page.scale,
    h: page.heightPx / page.scale,
  };
  const pageSizeOfSelected = selectedOnThisPage?.pageSize ?? nativePageSize;

  return (
    <div className="pointer-events-none absolute inset-0">
      {/* Draw tool must be rendered first so drawn rects don't overlap handles. */}
      {editMode === "draw" && onDrawNew && (
        <DrawFieldTool
          page={page}
          pageSize={pageSizeOfSelected}
          onDraw={(r, p) => onDrawNew(r, p)}
        />
      )}
      {/* Marquee sits UNDER the field buttons so clicks on empty page
          area get captured for rubber-band selection while clicks on
          fields go to the fields themselves. Only in "select" mode. */}
      {editMode === "select" && onMarqueeSelect && (
        <MarqueeSelect
          page={page}
          fields={pageFields}
          selectedNames={multiSelected ?? new Set()}
          onSelect={onMarqueeSelect}
          onClearSelection={onClearMultiSelect}
        />
      )}
      {pageFields.map((f) => {
        // Use a draft rect (drag-preview) if one is active for this field.
        const rect = draftRectsByField[f.name] ?? f.rect!;
        const scale = page.scale;
        // Use the ACTUAL rendered viewport dimensions. pdf.js renders each
        // page using CropBox (falling back to MediaBox) — the rect values
        // from our API are in the same user-space the page viewport uses,
        // so dividing heightPx by scale recovers the page height in user
        // units that exactly matches what's drawn on screen.
        const nativePageH = page.heightPx / scale;
        const nativePageW = page.widthPx / scale;
        // PDF origin = bottom-left; DOM origin = top-left. Flip Y.
        const left = rect.x * scale;
        const top = (nativePageH - rect.y - rect.h) * scale;
        const width = rect.w * scale;
        const height = rect.h * scale;
        // Clamp to page bounds so a mis-extracted rect never renders a
        // ghost bar crossing unrelated text.
        if (
          rect.x < 0 ||
          rect.y < 0 ||
          rect.x + rect.w > nativePageW + 1 ||
          rect.y + rect.h > nativePageH + 1
        ) {
          console.warn(
            `[overlay] field "${f.name}" rect out of page bounds`,
            { rect, page: { w: nativePageW, h: nativePageH } }
          );
        }

        const m = mappings[f.name];
        const isSelected = selectedField === f.name;
        const isMulti = !!multiSelected?.has(f.name);
        const mapped = !!m?.dataKey && m.dataKey !== "";
        const required = !!m?.required || !!f.required;
        const errs = fieldErrors[f.name] || [];
        const hasError = errs.length > 0;
        const skipped = mapped && !!m?.fillWhen && !shouldFill(m.fillWhen, sampleData);

        let preview = "";
        if (m && mapped && !skipped) {
          const raw = sampleData[m.dataKey] ?? m.default;
          if (raw !== undefined) {
            preview = applyTransformPipeline(raw, m.transform, sampleData);
          }
        }

        return (
          <button
            key={f.name}
            type="button"
            onClick={(e) =>
              onSelect(f.name, {
                additive: e.shiftKey || e.metaKey || e.ctrlKey,
              })
            }
            title={
              hasError
                ? `${f.name} — ${errs.map((e) => e.message).join("; ")}`
                : skipped
                ? `${f.name} — would be skipped (fillWhen)`
                : `${f.name}${f.tooltip ? ` — ${f.tooltip}` : ""}${f.type ? ` (${f.type})` : ""}`
            }
            className={cn(
              "pointer-events-auto absolute flex items-center overflow-hidden rounded-[2px] border text-[10px] leading-tight transition-colors",
              isSelected
                ? "border-2 border-primary bg-primary/10 ring-2 ring-primary/30"
                : isMulti
                ? "border-2 border-primary/70 bg-primary/10 ring-1 ring-primary/40"
                : hasError
                ? "border-2 border-red-500/70 bg-red-500/10 hover:bg-red-500/20"
                : skipped
                ? "border-dashed border-gray-400 bg-gray-400/10 hover:bg-gray-400/20"
                : mapped
                ? "border-emerald-500/60 bg-emerald-500/10 hover:bg-emerald-500/20"
                : "border-dashed border-amber-500/70 bg-amber-400/10 hover:bg-amber-400/20"
            )}
            style={{
              left,
              top,
              width,
              height,
              ...(skipped
                ? {
                    backgroundImage:
                      "repeating-linear-gradient(45deg, rgba(148,163,184,0.25) 0 4px, transparent 4px 8px)",
                  }
                : {}),
            }}
          >
            {!skipped && preview && (
              <span className="truncate px-1 font-medium text-emerald-900 dark:text-emerald-100">
                {preview}
              </span>
            )}
            {skipped && (
              <span className="truncate px-1 text-[9px] font-medium uppercase tracking-wide text-gray-600">
                skip
              </span>
            )}
            {hasError && (
              <span
                className="absolute left-0 top-0 h-2 w-2 rounded-full bg-red-500 ring-1 ring-white"
                aria-label="error"
              />
            )}
            {required && !hasError && (
              <span
                className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-red-500"
                aria-label="required"
              />
            )}
          </button>
        );
      })}

      {/* Drag/resize handles for the selected field in edit mode. */}
      {editMode === "select" &&
        selectedOnThisPage &&
        selectedOnThisPage.rect &&
        onRectPreview &&
        onRectCommit && (
          <FieldDragHandles
            rect={
              draftRectsByField[selectedOnThisPage.name] ?? selectedOnThisPage.rect
            }
            pageSize={selectedOnThisPage.pageSize ?? nativePageSize}
            page={page}
            onPreview={(r) => onRectPreview(selectedOnThisPage.name, r)}
            onCommit={(r) =>
              onRectCommit(selectedOnThisPage.name, r, selectedOnThisPage.page)
            }
          />
        )}
    </div>
  );
}
