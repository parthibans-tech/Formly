"use client";

// Editor for the per-field `fillWhen` expression. Live evaluates the
// expression against sampleData and shows a "would fill" / "would skip"
// badge so the designer sees the effect before generating.

import { CircleCheck, CircleSlash } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { shouldFill } from "@/lib/acroform-validation";

type Props = {
  value: string | undefined;
  allFieldDataKeys: string[];
  sampleData: Record<string, any>;
  onChange: (expr: string | undefined) => void;
};

const PRESETS: { label: string; build: (k: string) => string }[] = [
  { label: "key set", build: (k) => `${k} !== ''` },
  { label: "key = true", build: (k) => `${k} === true` },
  { label: "key not null", build: (k) => `${k} !== null` },
];

export function ConditionalEditor({
  value,
  allFieldDataKeys,
  sampleData,
  onChange,
}: Props) {
  const expr = value || "";
  const fills = shouldFill(expr, sampleData);

  return (
    <div className="space-y-1.5 rounded-md border border-dashed bg-muted/20 p-2">
      <div className="flex items-center justify-between">
        <Label className="text-[10px] text-muted-foreground">
          Fill only when (expression)
        </Label>
        {expr && (
          <span
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
              fills
                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
            )}
          >
            {fills ? (
              <>
                <CircleCheck className="h-3 w-3" /> Would fill
              </>
            ) : (
              <>
                <CircleSlash className="h-3 w-3" /> Would skip
              </>
            )}
          </span>
        )}
      </div>
      <Input
        className="h-7 font-mono text-[11px]"
        placeholder="status === 'active'"
        value={expr}
        onChange={(e) => onChange(e.target.value || undefined)}
      />
      {allFieldDataKeys.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted-foreground/10"
              onClick={() => {
                const k = allFieldDataKeys[0] || "key";
                onChange(p.build(k));
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      <p className="text-[10px] text-muted-foreground">
        Supports <code className="font-mono">path op literal</code> (ops:
        === !== == != &gt; &lt; &gt;= &lt;=)
      </p>
    </div>
  );
}
