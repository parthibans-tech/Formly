"use client";

// Per-field validation rule editor. Mirrors ValidationRule from types.ts:
//   - type: coarse type check (string/number/boolean/date/email/url)
//   - min/max, minLength/maxLength, pattern, minDate/maxDate, expression
//   - custom message
//
// Smart defaults: if the PDF field itself is a checkbox, seed type="boolean";
// if it looks date-y, seed type="date"; maxLen → maxLength, etc.

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AcroFormField, ValidationRule, ValidationType } from "./types";

type Props = {
  value: ValidationRule | undefined;
  field: AcroFormField;
  onChange: (rule: ValidationRule | undefined) => void;
};

export function ValidationRulesEditor({ value, field, onChange }: Props) {
  const rule: ValidationRule = value || {};
  const type = rule.type || inferDefaultType(field);

  function update(patch: Partial<ValidationRule>) {
    const merged = { ...rule, ...patch };
    // Prune empty fields so we don't persist an all-empty rule object.
    const pruned: ValidationRule = {};
    if (merged.type) pruned.type = merged.type;
    if (merged.minLength != null) pruned.minLength = merged.minLength;
    if (merged.maxLength != null) pruned.maxLength = merged.maxLength;
    if (merged.pattern) pruned.pattern = merged.pattern;
    if (merged.min != null) pruned.min = merged.min;
    if (merged.max != null) pruned.max = merged.max;
    if (merged.minDate) pruned.minDate = merged.minDate;
    if (merged.maxDate) pruned.maxDate = merged.maxDate;
    if (merged.expression) pruned.expression = merged.expression;
    if (merged.message) pruned.message = merged.message;
    onChange(Object.keys(pruned).length === 0 ? undefined : pruned);
  }

  const isString = type === "string" || type === "email" || type === "url";
  const isNumber = type === "number";
  const isDate = type === "date";

  return (
    <div className="space-y-2 rounded-md border border-dashed bg-muted/20 p-2">
      <div className="flex items-center gap-2">
        <Label className="text-[10px] text-muted-foreground">Type</Label>
        <Select
          value={type}
          onValueChange={(v) => update({ type: v === "none" ? undefined : (v as ValidationType) })}
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">(no type check)</SelectItem>
            <SelectItem value="string">String</SelectItem>
            <SelectItem value="number">Number</SelectItem>
            <SelectItem value="boolean">Boolean</SelectItem>
            <SelectItem value="date">Date</SelectItem>
            <SelectItem value="email">Email</SelectItem>
            <SelectItem value="url">URL</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isString && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Min length</Label>
            <Input
              type="number"
              className="h-7 text-xs"
              value={rule.minLength ?? ""}
              onChange={(e) =>
                update({
                  minLength: e.target.value === "" ? undefined : parseInt(e.target.value, 10),
                })
              }
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">
              Max length{field.maxLen ? ` (PDF: ${field.maxLen})` : ""}
            </Label>
            <Input
              type="number"
              className="h-7 text-xs"
              value={rule.maxLength ?? ""}
              onChange={(e) =>
                update({
                  maxLength: e.target.value === "" ? undefined : parseInt(e.target.value, 10),
                })
              }
            />
          </div>
        </div>
      )}

      {isString && (
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">Regex pattern</Label>
          <Input
            className="h-7 font-mono text-xs"
            placeholder="^\\d{5}$"
            value={rule.pattern || ""}
            onChange={(e) => update({ pattern: e.target.value || undefined })}
          />
        </div>
      )}

      {isNumber && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Min</Label>
            <Input
              type="number"
              className="h-7 text-xs"
              value={rule.min ?? ""}
              onChange={(e) =>
                update({
                  min: e.target.value === "" ? undefined : parseFloat(e.target.value),
                })
              }
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Max</Label>
            <Input
              type="number"
              className="h-7 text-xs"
              value={rule.max ?? ""}
              onChange={(e) =>
                update({
                  max: e.target.value === "" ? undefined : parseFloat(e.target.value),
                })
              }
            />
          </div>
        </div>
      )}

      {isDate && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Min date</Label>
            <Input
              type="date"
              className="h-7 text-xs"
              value={rule.minDate || ""}
              onChange={(e) => update({ minDate: e.target.value || undefined })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Max date</Label>
            <Input
              type="date"
              className="h-7 text-xs"
              value={rule.maxDate || ""}
              onChange={(e) => update({ maxDate: e.target.value || undefined })}
            />
          </div>
        </div>
      )}

      <div className="space-y-1">
        <Label className="text-[10px] text-muted-foreground">
          Custom expression (e.g. <code className="font-mono">$value !== &apos;&apos;</code>)
        </Label>
        <Input
          className="h-7 font-mono text-xs"
          placeholder="$value > 0"
          value={rule.expression || ""}
          onChange={(e) => update({ expression: e.target.value || undefined })}
        />
      </div>

      <div className="space-y-1">
        <Label className="text-[10px] text-muted-foreground">Custom error message</Label>
        <Input
          className="h-7 text-xs"
          placeholder="(optional)"
          value={rule.message || ""}
          onChange={(e) => update({ message: e.target.value || undefined })}
        />
      </div>
    </div>
  );
}

function inferDefaultType(field: AcroFormField): ValidationType | undefined {
  const t = (field.type || "").toLowerCase();
  if (t.includes("check")) return "boolean";
  if (t.includes("date") || /date|dob|birth/i.test(field.name)) return "date";
  if (/email/i.test(field.name)) return "email";
  if (/url|website|link/i.test(field.name)) return "url";
  return undefined;
}
