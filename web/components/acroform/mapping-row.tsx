"use client";

// A single mapping row — name + type metadata, required toggle, data key,
// default, transform pipeline editor, validation rules, fillWhen editor,
// per-field flatten toggle, inspector trigger, live preview, and inline
// validation errors.

import { forwardRef, useMemo, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Filter,
  Info,
  Lock,
  MapPin,
  ShieldCheck,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  applyTransformPipeline,
  normalizePipeline,
} from "@/lib/acroform-transforms";
import type { FieldError } from "@/lib/acroform-validation";
import type { AcroFormField, AcroMapping } from "./types";
import { TransformEditor } from "./transform-editor";
import { ValidationRulesEditor } from "./validation-rules-editor";
import { ConditionalEditor } from "./conditional-editor";

type Props = {
  field: AcroFormField;
  mapping: AcroMapping;
  selected: boolean;
  allFieldDataKeys: string[];
  sampleData: Record<string, any>;
  selectedCount?: number;
  errors?: FieldError[];
  onSelect: () => void;
  onChange: (patch: Partial<AcroMapping>) => void;
  onOpenInspector: () => void;
  onToggleMultiSelect?: () => void;
  multiSelected?: boolean;
  // Only provided for rect-less ("supplement-only") fields — the ones
  // pdfcpu's FormFields API surfaced but the /Annots walker couldn't
  // geometrically locate. Clicking hands the designer the field name
  // so the next drawn rectangle binds to this field instead of
  // creating a new one.
  onPlace?: () => void;
};

export const MappingRow = forwardRef<HTMLDivElement, Props>(function MappingRow(
  {
    field,
    mapping,
    selected,
    allFieldDataKeys,
    sampleData,
    errors = [],
    onSelect,
    onChange,
    onOpenInspector,
    onToggleMultiSelect,
    multiSelected,
    onPlace,
  }: Props,
  ref
) {
  const needsPlacement = !field.rect && !!onPlace;
  const [advancedOpen, setAdvancedOpen] = useState(
    !!mapping.validation || !!mapping.fillWhen
  );

  const preview = useMemo(() => {
    if (!mapping.dataKey) return null;
    const raw = sampleData[mapping.dataKey] ?? mapping.default;
    if (raw === undefined) return null;
    const out = applyTransformPipeline(raw, mapping.transform, sampleData);
    return out;
  }, [mapping, sampleData]);

  const hasErrors = errors.length > 0;

  return (
    <div
      ref={ref}
      onClick={onSelect}
      className={cn(
        "cursor-pointer space-y-3 p-4 transition-colors",
        selected ? "bg-primary/5" : "hover:bg-muted/30",
        hasErrors && "border-l-2 border-l-red-500"
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
              {mapping.fillWhen && (
                <Filter
                  className="h-3 w-3 text-amber-600"
                  aria-label="Conditional fill"
                />
              )}
              {mapping.validation && (
                <ShieldCheck
                  className="h-3 w-3 text-emerald-600"
                  aria-label="Has validation"
                />
              )}
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
              {needsPlacement ? " • no position" : ""}
            </div>
            {needsPlacement && (
              <Button
                variant="outline"
                size="sm"
                className="mt-1 h-6 gap-1 px-2 text-[11px]"
                onClick={(e) => {
                  e.stopPropagation();
                  onPlace!();
                }}
                title="Draw a rectangle on the PDF to position this field"
              >
                <MapPin className="h-3 w-3" />
                Place on PDF
              </Button>
            )}
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
          onChange={(t) => {
            if (Array.isArray(t)) {
              const pipeline = normalizePipeline(t);
              if (pipeline.length === 0) onChange({ transform: undefined });
              else if (pipeline.length === 1) onChange({ transform: pipeline[0] });
              else onChange({ transform: pipeline });
            } else {
              onChange({ transform: t.op === "none" ? undefined : t });
            }
          }}
        />
      </div>

      <div onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          className="flex w-full items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {advancedOpen ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          Advanced (validation, conditions)
        </button>
        {advancedOpen && (
          <div className="mt-2 space-y-2">
            <ValidationRulesEditor
              value={mapping.validation}
              field={field}
              onChange={(rule) => onChange({ validation: rule })}
            />
            <ConditionalEditor
              value={mapping.fillWhen}
              allFieldDataKeys={allFieldDataKeys}
              sampleData={sampleData}
              onChange={(expr) => onChange({ fillWhen: expr })}
            />
          </div>
        )}
      </div>

      {hasErrors ? (
        <div className="space-y-1 rounded-md border border-red-500/40 bg-red-500/5 px-2 py-1.5">
          {errors.map((e, i) => (
            <div
              key={i}
              className="flex items-start gap-1 text-[11px] text-red-700 dark:text-red-300"
            >
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{e.message}</span>
            </div>
          ))}
        </div>
      ) : preview !== null ? (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1 font-mono text-[11px] text-emerald-700 dark:text-emerald-300">
          Preview: {preview || "(empty)"}
        </div>
      ) : null}
    </div>
  );
});
