"use client";

// Structured editor for a Transform or a pipeline of Transforms.
// Handles single-transform mode (default) and multi-transform "chain" mode:
// in chain mode the user can add/remove/reorder up to 10 transforms which
// are applied left-to-right.

import { Plus, Trash2, ArrowUp, ArrowDown, Link2, Unlink } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  TRANSFORM_CATALOG,
  Transform,
  normalizeTransform,
  normalizePipeline,
} from "@/lib/acroform-transforms";

type Value = Transform | Transform[] | string | undefined;

type Props = {
  value: Value;
  allFieldDataKeys: string[];
  onChange: (t: Transform | Transform[]) => void;
};

const MAX_CHAIN = 10;

export function TransformEditor({ value, allFieldDataKeys, onChange }: Props) {
  const isChain = Array.isArray(value);
  const chain = isChain ? normalizePipelineOrSeed(value) : null;

  if (isChain && chain) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Link2 className="h-3.5 w-3.5" />
            Chain ({chain.length} step{chain.length === 1 ? "" : "s"})
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => {
              // Exit chain mode → keep first non-none step as single transform.
              const first = chain.find((s) => s.op !== "none");
              onChange(first ?? { op: "none" });
            }}
          >
            <Unlink className="h-3 w-3" /> Single
          </Button>
        </div>

        <div className="space-y-2">
          {chain.map((step, i) => (
            <div
              key={i}
              className="space-y-2 rounded-md border border-dashed bg-muted/20 p-2"
            >
              <div className="flex items-center gap-1">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                  {i + 1}
                </span>
                <TransformOpSelect
                  op={step.op}
                  onChange={(op) => {
                    const next = [...chain];
                    next[i] = { op: op as Transform["op"], params: defaultParamsFor(op) };
                    onChange(next);
                  }}
                />
                <div className="flex items-center">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    disabled={i === 0}
                    onClick={() => {
                      const next = [...chain];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      onChange(next);
                    }}
                    title="Move up"
                  >
                    <ArrowUp className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    disabled={i === chain.length - 1}
                    onClick={() => {
                      const next = [...chain];
                      [next[i], next[i + 1]] = [next[i + 1], next[i]];
                      onChange(next);
                    }}
                    title="Move down"
                  >
                    <ArrowDown className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 text-destructive"
                    onClick={() => {
                      const next = chain.filter((_, idx) => idx !== i);
                      onChange(next);
                    }}
                    title="Remove step"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
              <TransformParamsEditor
                transform={step}
                allFieldDataKeys={allFieldDataKeys}
                onParamsChange={(params) => {
                  const next = [...chain];
                  next[i] = { ...step, params };
                  onChange(next);
                }}
              />
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 w-full text-[11px]"
            disabled={chain.length >= MAX_CHAIN}
            onClick={() => {
              onChange([...chain, { op: "uppercase", params: defaultParamsFor("uppercase") }]);
            }}
          >
            <Plus className="h-3 w-3" /> Add step
          </Button>
        </div>
      </div>
    );
  }

  // Single mode (default).
  const t = normalizeTransform(value);
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-1">
        <div className="flex-1">
          <TransformOpSelect
            op={t.op}
            onChange={(op) =>
              onChange({ op: op as Transform["op"], params: defaultParamsFor(op) })
            }
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-[11px]"
          onClick={() => {
            // Convert current single transform into a 1-step chain.
            onChange([t]);
          }}
          title="Convert to multi-step chain"
        >
          <Link2 className="h-3 w-3" /> Chain
        </Button>
      </div>
      <TransformParamsEditor
        transform={t}
        allFieldDataKeys={allFieldDataKeys}
        onParamsChange={(params) => onChange({ op: t.op, params })}
      />
    </div>
  );
}

// --- Reusable subcomponents ---

function TransformOpSelect({
  op,
  onChange,
}: {
  op: Transform["op"];
  onChange: (op: string) => void;
}) {
  return (
    <Select value={op} onValueChange={onChange}>
      <SelectTrigger className="h-8 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {TRANSFORM_CATALOG.map((c) => (
          <SelectItem key={c.op} value={c.op}>
            {c.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function TransformParamsEditor({
  transform,
  allFieldDataKeys,
  onParamsChange,
}: {
  transform: Transform;
  allFieldDataKeys: string[];
  onParamsChange: (params: Record<string, any>) => void;
}) {
  const params = transform.params || {};
  const update = (patch: Record<string, any>) =>
    onParamsChange({ ...params, ...patch });

  switch (transform.op) {
    case "template":
      return (
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">
            Pattern — use {"{dataKey}"} for substitutions
          </Label>
          <Input
            className="h-8 font-mono text-xs"
            placeholder="Hello {first_name}"
            value={params.pattern || ""}
            onChange={(e) => update({ pattern: e.target.value })}
          />
        </div>
      );
    case "date-format":
      return (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">From</Label>
            <Input
              className="h-8 text-xs"
              placeholder="iso"
              value={params.from || ""}
              onChange={(e) => update({ from: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">To</Label>
            <Input
              className="h-8 text-xs"
              placeholder="MM/DD/YYYY"
              value={params.to || ""}
              onChange={(e) => update({ to: e.target.value })}
            />
          </div>
        </div>
      );
    case "number-format":
      return (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Decimals</Label>
            <Input
              type="number"
              className="h-8 text-xs"
              value={params.decimals ?? 2}
              onChange={(e) => update({ decimals: parseInt(e.target.value || "0", 10) })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Prefix</Label>
            <Input
              className="h-8 text-xs"
              placeholder="$"
              value={params.prefix || ""}
              onChange={(e) => update({ prefix: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Suffix</Label>
            <Input
              className="h-8 text-xs"
              placeholder="%"
              value={params.suffix || ""}
              onChange={(e) => update({ suffix: e.target.value })}
            />
          </div>
          <label className="flex cursor-pointer items-center gap-2 pt-5 text-xs">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-primary"
              checked={!!params.thousands}
              onChange={(e) => update({ thousands: e.target.checked })}
            />
            Thousands separator
          </label>
        </div>
      );
    case "lookup":
      return (
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">
            Map (JSON object: &#123;"input":"output",…&#125;)
          </Label>
          <textarea
            className="h-24 w-full rounded-md border bg-background p-2 font-mono text-[11px]"
            placeholder='{"US":"United States","CA":"Canada"}'
            value={JSON.stringify(params.map ?? {}, null, 2)}
            onChange={(e) => {
              try {
                update({ map: JSON.parse(e.target.value || "{}") });
              } catch {
                // ignore; keep editing
              }
            }}
          />
          <Input
            className="h-8 text-xs"
            placeholder="Default if not found"
            value={params.default || ""}
            onChange={(e) => update({ default: e.target.value })}
          />
        </div>
      );
    case "concat":
      return (
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">
            Fields (comma-separated data keys)
          </Label>
          <Input
            className="h-8 font-mono text-xs"
            placeholder="first_name, last_name"
            value={(params.fields || []).join(", ")}
            onChange={(e) =>
              update({
                fields: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
          <Input
            className="h-8 text-xs"
            placeholder="Separator (default: space)"
            value={params.sep ?? ""}
            onChange={(e) => update({ sep: e.target.value })}
          />
          {allFieldDataKeys.length > 0 && (
            <p className="text-[10px] text-muted-foreground">
              Known data keys: {allFieldDataKeys.slice(0, 8).join(", ")}
              {allFieldDataKeys.length > 8 ? "…" : ""}
            </p>
          )}
        </div>
      );
    case "substring":
      return (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Start</Label>
            <Input
              type="number"
              className="h-8 text-xs"
              value={params.start ?? 0}
              onChange={(e) => update({ start: parseInt(e.target.value || "0", 10) })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">End</Label>
            <Input
              type="number"
              className="h-8 text-xs"
              value={params.end ?? ""}
              onChange={(e) =>
                update({ end: e.target.value === "" ? undefined : parseInt(e.target.value, 10) })
              }
            />
          </div>
        </div>
      );
    case "replace":
      return (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Regex pattern</Label>
            <Input
              className="h-8 font-mono text-xs"
              value={params.pattern || ""}
              onChange={(e) => update({ pattern: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Replacement</Label>
            <Input
              className="h-8 text-xs"
              value={params.replacement || ""}
              onChange={(e) => update({ replacement: e.target.value })}
            />
          </div>
        </div>
      );
    case "boolean-label":
      return (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Truthy</Label>
            <Input
              className="h-8 text-xs"
              placeholder="Yes"
              value={params.truthy || ""}
              onChange={(e) => update({ truthy: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Falsy</Label>
            <Input
              className="h-8 text-xs"
              placeholder="No"
              value={params.falsy || ""}
              onChange={(e) => update({ falsy: e.target.value })}
            />
          </div>
        </div>
      );
    case "js-expr":
      return (
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">
            JS expression (preview only — server-side execution is gated)
          </Label>
          <textarea
            className="h-20 w-full rounded-md border bg-background p-2 font-mono text-[11px]"
            placeholder="value.toUpperCase()"
            value={params.expr || ""}
            onChange={(e) => update({ expr: e.target.value })}
          />
        </div>
      );
    default:
      return null;
  }
}

function defaultParamsFor(op: string): Record<string, any> | undefined {
  switch (op) {
    case "template":
      return { pattern: "" };
    case "date-format":
      return { from: "iso", to: "MM/DD/YYYY" };
    case "number-format":
      return { decimals: 2, thousands: true };
    case "lookup":
      return { map: {}, default: "" };
    case "concat":
      return { fields: [], sep: " " };
    case "substring":
      return { start: 0 };
    case "replace":
      return { pattern: "", replacement: "" };
    case "boolean-label":
      return { truthy: "Yes", falsy: "No" };
    case "js-expr":
      return { expr: "" };
    default:
      return undefined;
  }
}

// Seed an empty chain with a single placeholder if the pipeline normalized to
// nothing — keeps the editor usable after "Chain" is toggled from "none".
function normalizePipelineOrSeed(raw: Value): Transform[] {
  const p = normalizePipeline(raw);
  if (p.length === 0) return [{ op: "uppercase", params: defaultParamsFor("uppercase") }];
  return p;
}
