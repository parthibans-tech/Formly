"use client";

// A single mapping row — name + type metadata, required toggle, data key,
// default, transform editor, per-field flatten toggle, inspector trigger,
// and live preview of the final transformed value.

import { forwardRef, useMemo } from "react";
import { Info, Lock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { applyTransform, normalizeTransform } from "@/lib/acroform-transforms";
import type { AcroFormField, AcroMapping } from "./types";
import { TransformEditor } from "./transform-editor";

type Props = {
  field: AcroFormField;
  mapping: AcroMapping;
  selected: boolean;
  allFieldDataKeys: string[];
  sampleData: Record<string, any>;
  selectedCount?: number;
  onSelect: () => void;
  onChange: (patch: Partial<AcroMapping>) => void;
  onOpenInspector: () => void;
  onToggleMultiSelect?: () => void;
  multiSelected?: boolean;
};

export const MappingRow = forwardRef<HTMLDivElement, Props>(function MappingRow(
  {
    field,
    mapping,
    selected,
    allFieldDataKeys,
    sampleData,
    onSelect,
    onChange,
    onOpenInspector,
    onToggleMultiSelect,
    multiSelected,
  }: Props,
  ref
) {
  const preview = useMemo(() => {
    if (!mapping.dataKey) return null;
    const raw = sampleData[mapping.dataKey] ?? mapping.default;
    if (raw === undefined) return null;
    const out = applyTransform(raw, normalizeTransform(mapping.transform), sampleData);
    return out;
  }, [mapping, sampleData]);

  return (
    <div
      ref={ref}
      onClick={onSelect}
      className={cn(
        "cursor-pointer space-y-3 p-4 transition-colors",
        selected ? "bg-primary/5" : "hover:bg-muted/30"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          {onToggleMultiSelect && (
            <input
              type="checkbox"
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
              checked={!!multiSelected}
              onClick={(e) => e.stopPropagation()}
              onChange={onToggleMultiSelect}
              aria-label={`Select ${field.name}`}
            />
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-mono text-sm">{field.name}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenInspector();
                }}
                title="Inspect raw PDF metadata"
              >
                <Info className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="text-[11px] text-muted-foreground">
              {field.type}
              {field.page ? ` • page ${field.page}` : ""}
              {field.maxLen ? ` • maxLen ${field.maxLen}` : ""}
              {field.readOnly ? " • read-only" : ""}
              {field.multiline ? " • multiline" : ""}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label
            className="flex cursor-pointer items-center gap-1 text-[11px]"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-primary"
              checked={!!mapping.required}
              onChange={(e) => onChange({ required: e.target.checked })}
            />
            Required
          </label>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange({ flatten: mapping.flatten ? undefined : true });
            }}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded text-[10px]",
              mapping.flatten ? "bg-primary/20 text-primary" : "text-muted-foreground hover:bg-muted"
            )}
            title="Flatten this field in filled output"
          >
            <Lock className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2" onClick={(e) => e.stopPropagation()}>
        <div className="space-y-1">
          <Label className="text-[11px]">Data key</Label>
          <Input
            className="h-8 font-mono text-xs"
            placeholder="data key"
            value={mapping.dataKey}
            onChange={(e) => onChange({ dataKey: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">Default</Label>
          <Input
            className="h-8 text-xs"
            placeholder="(none)"
            value={mapping.default || ""}
            onChange={(e) => onChange({ default: e.target.value })}
          />
        </div>
      </div>

      <div className="space-y-1" onClick={(e) => e.stopPropagation()}>
        <Label className="text-[11px]">Transform</Label>
        <TransformEditor
          value={mapping.transform}
          allFieldDataKeys={allFieldDataKeys}
          onChange={(t) => onChange({ transform: t.op === "none" ? undefined : t })}
        />
      </div>

      {preview !== null && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1 font-mono text-[11px] text-emerald-700 dark:text-emerald-300">
          Preview: {preview || "(empty)"}
        </div>
      )}
    </div>
  );
});
