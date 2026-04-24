"use client";

// FieldOverlay — absolute-positioned boxes drawn over a rendered PDF page
// for each AcroForm field. Click = select mapping row. Hover = tooltip.

import { cn } from "@/lib/utils";
import type { AcroFormField, MappingMap } from "./types";
import { applyTransform, normalizeTransform } from "@/lib/acroform-transforms";
import type { RenderedPage } from "./pdf-preview";

type Props = {
  page: RenderedPage;
  fields: AcroFormField[];
  mappings: MappingMap;
  selectedField: string | null;
  sampleData: Record<string, any>;
  onSelect: (name: string) => void;
};

export function FieldOverlay({
  page,
  fields,
  mappings,
  selectedField,
  sampleData,
  onSelect,
}: Props) {
  const pageFields = fields.filter((f) => f.page === page.pageNum && f.rect);

  return (
    <div className="pointer-events-none absolute inset-0">
      {pageFields.map((f) => {
        const rect = f.rect!;
        const ps = f.pageSize ?? { w: 612, h: 792 };
        const scale = page.scale;
        // PDF origin = bottom-left; DOM origin = top-left. Flip Y.
        const left = rect.x * scale;
        const top = (ps.h - rect.y - rect.h) * scale;
        const width = rect.w * scale;
        const height = rect.h * scale;

        const m = mappings[f.name];
        const isSelected = selectedField === f.name;
        const mapped = !!m?.dataKey && m.dataKey !== "";
        const required = !!m?.required || !!f.required;

        let preview = "";
        if (m && mapped) {
          const raw = sampleData[m.dataKey] ?? m.default;
          if (raw !== undefined) {
            preview = applyTransform(raw, normalizeTransform(m.transform), sampleData);
          }
        }

        return (
          <button
            key={f.name}
            type="button"
            onClick={() => onSelect(f.name)}
            title={`${f.name}${f.tooltip ? ` — ${f.tooltip}` : ""}${f.type ? ` (${f.type})` : ""}`}
            className={cn(
              "pointer-events-auto absolute flex items-center overflow-hidden rounded-[2px] border text-[10px] leading-tight transition-colors",
              isSelected
                ? "border-2 border-primary bg-primary/10 ring-2 ring-primary/30"
                : mapped
                ? "border-emerald-500/60 bg-emerald-500/10 hover:bg-emerald-500/20"
                : "border-dashed border-amber-500/70 bg-amber-400/10 hover:bg-amber-400/20"
            )}
            style={{ left, top, width, height }}
          >
            {preview && (
              <span className="truncate px-1 font-medium text-emerald-900 dark:text-emerald-100">
                {preview}
              </span>
            )}
            {required && (
              <span
                className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-red-500"
                aria-label="required"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
