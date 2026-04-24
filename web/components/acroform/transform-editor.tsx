"use client";

// Structured editor for a Transform. The outer component renders a select
// to pick the op; the content below changes per-op to show only relevant
// params. All params round-trip as a plain object.

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
} from "@/lib/acroform-transforms";

type Props = {
  value: Transform | string | undefined;
  allFieldDataKeys: string[];
  onChange: (t: Transform) => void;
};

export function TransformEditor({ value, allFieldDataKeys, onChange }: Props) {
  const t = normalizeTransform(value);
  const params = t.params || {};

  function update(patch: Record<string, any>) {
    onChange({ op: t.op, params: { ...params, ...patch } });
  }

  return (
    <div className="space-y-2">
      <Select
        value={t.op}
        onValueChange={(op) =>
          onChange({ op: op as Transform["op"], params: defaultParamsFor(op) })
        }
      >
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

      {t.op === "template" && (
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
      )}

      {t.op === "date-format" && (
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
      )}

      {t.op === "number-format" && (
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
      )}

      {t.op === "lookup" && (
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
      )}

      {t.op === "concat" && (
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
      )}

      {t.op === "substring" && (
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
      )}

      {t.op === "replace" && (
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
      )}

      {t.op === "boolean-label" && (
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
      )}

      {t.op === "js-expr" && (
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
      )}
    </div>
  );
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
