"use client";

/**
 * StarterFillForm — resume.io-style structured form, driven by a starter's
 * `formSchema`.  Renders a section per group; each group binds to a path in
 * the data tree.  The component is fully controlled — parent owns the data
 * state — so the live preview can read the same object on every keystroke.
 */

import React, { useState } from "react";
import { ChevronDown, GripVertical, Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  FormGroup,
  FormSchema,
  ObjectListGroup,
  ScalarField,
} from "@/lib/starters/types";

type DataTree = Record<string, unknown>;

interface Props {
  schema: FormSchema;
  value: DataTree;
  onChange: (next: DataTree) => void;
}

export function StarterFillForm({ schema, value, onChange }: Props) {
  return (
    <div className="space-y-8">
      {schema.groups.map((g) => (
        <GroupSection key={g.id} group={g} value={value} onChange={onChange} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

function GroupSection({
  group,
  value,
  onChange,
}: {
  group: FormGroup;
  value: DataTree;
  onChange: (next: DataTree) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-center justify-between gap-2 py-2 text-left"
      >
        <span className="text-lg font-semibold tracking-tight">
          {group.label}
        </span>
        <span className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground group-hover:bg-accent group-hover:text-foreground">
          <ChevronDown
            size={16}
            className={cn(
              "transition-transform",
              open ? "rotate-0" : "-rotate-90",
            )}
          />
        </span>
      </button>
      {open ? (
        <div className="pt-3">
          <GroupBody group={group} value={value} onChange={onChange} />
        </div>
      ) : null}
    </section>
  );
}

function GroupBody({
  group,
  value,
  onChange,
}: {
  group: FormGroup;
  value: DataTree;
  onChange: (next: DataTree) => void;
}) {
  switch (group.kind) {
    case "object": {
      const obj = (getPath(value, group.path) as DataTree) ?? {};
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {group.fields.map((f) => (
            <ScalarInput
              key={f.id}
              field={f}
              value={obj[f.id]}
              onChange={(v) =>
                onChange(setPath(value, `${group.path}.${f.id}`, v))
              }
              span={f.type === "longtext" ? 2 : 1}
            />
          ))}
        </div>
      );
    }
    case "scalar":
      return (
        <ScalarInput
          field={{
            id: group.id,
            label: group.label,
            type: group.type,
            placeholder: group.placeholder,
            help: group.help,
          }}
          value={getPath(value, group.path)}
          onChange={(v) => onChange(setPath(value, group.path, v))}
          hideLabel
        />
      );
    case "string-list":
      return (
        <StringListEditor
          items={(getPath(value, group.path) as string[]) ?? []}
          onChange={(items) => onChange(setPath(value, group.path, items))}
          itemPlaceholder={group.itemPlaceholder}
        />
      );
    case "object-list":
      return (
        <ObjectListEditor
          group={group}
          items={(getPath(value, group.path) as DataTree[]) ?? []}
          onChange={(items) => onChange(setPath(value, group.path, items))}
        />
      );
  }
}

// ---------------------------------------------------------------------------
// Scalar input
// ---------------------------------------------------------------------------

function ScalarInput({
  field,
  value,
  onChange,
  span = 1,
  hideLabel,
}: {
  field: ScalarField;
  value: unknown;
  onChange: (v: string) => void;
  span?: 1 | 2;
  hideLabel?: boolean;
}) {
  const id = `f-${field.id}-${Math.random().toString(36).slice(2, 7)}`;
  const v = typeof value === "string" ? value : "";
  const fieldClass =
    "flex w-full rounded-md border border-transparent bg-muted/60 px-3 py-2 text-sm placeholder:text-muted-foreground/70 focus-visible:border-primary focus-visible:bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40";
  return (
    <div className={cn("space-y-1", span === 2 && "sm:col-span-2")}>
      {!hideLabel ? (
        <Label
          htmlFor={id}
          className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          {field.label}
          {field.optional ? (
            <span className="ml-1 normal-case text-muted-foreground/60">
              (optional)
            </span>
          ) : null}
        </Label>
      ) : null}
      {field.type === "longtext" ? (
        <textarea
          id={id}
          value={v}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          rows={4}
          className={fieldClass}
        />
      ) : (
        <Input
          id={id}
          type={typeForInput(field.type)}
          value={v}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className={fieldClass}
        />
      )}
      {field.help ? (
        <p className="text-[11px] text-muted-foreground">{field.help}</p>
      ) : null}
    </div>
  );
}

function typeForInput(t: ScalarField["type"]): string {
  switch (t) {
    case "email":
      return "email";
    case "url":
      return "url";
    case "tel":
      return "tel";
    case "date":
      return "date";
    default:
      return "text";
  }
}

// ---------------------------------------------------------------------------
// String list (skills, highlights)
// ---------------------------------------------------------------------------

function StringListEditor({
  items,
  onChange,
  itemPlaceholder,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  itemPlaceholder?: string;
}) {
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-2">
          <GripVertical size={14} className="text-muted-foreground/50" />
          <Input
            value={it}
            placeholder={itemPlaceholder}
            onChange={(e) => {
              const next = items.slice();
              next[i] = e.target.value;
              onChange(next);
            }}
            className="flex-1 rounded-md border-transparent bg-muted/60 focus-visible:border-primary focus-visible:bg-background focus-visible:ring-1 focus-visible:ring-primary/40"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={() => onChange(items.filter((_, j) => j !== i))}
            aria-label="Remove"
          >
            <Trash2 size={14} />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8"
        onClick={() => onChange([...items, ""])}
      >
        <Plus size={14} className="mr-1" />
        Add
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Object list (experience, education, languages)
// ---------------------------------------------------------------------------

function ObjectListEditor({
  group,
  items,
  onChange,
}: {
  group: ObjectListGroup;
  items: DataTree[];
  onChange: (next: DataTree[]) => void;
}) {
  const [openIdx, setOpenIdx] = useState<number | null>(0);

  return (
    <div className="space-y-3">
      {items.map((row, i) => (
        <div key={i} className="overflow-hidden rounded-lg border bg-card">
          <button
            type="button"
            onClick={() => setOpenIdx(openIdx === i ? null : i)}
            className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-accent/40"
          >
            <span className="grid h-6 w-6 place-items-center rounded text-muted-foreground">
              <GripVertical size={14} />
            </span>
            <span className="flex-1 truncate text-sm font-medium">
              {renderItemLabel(group.itemLabel, row) || `(empty)`}
            </span>
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onChange(items.filter((_, j) => j !== i));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onChange(items.filter((_, j) => j !== i));
                }
              }}
              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              aria-label="Remove"
            >
              <Trash2 size={14} />
            </span>
            <ChevronDown
              size={14}
              className={cn(
                "text-muted-foreground transition-transform",
                openIdx === i ? "rotate-0" : "-rotate-90",
              )}
            />
          </button>
          {openIdx === i ? (
            <>
              <div className="h-px bg-border" />
              <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
                {group.fields.map((f) => {
                  if (f.type === "string-list") {
                    return (
                      <div key={f.id} className="space-y-1.5 sm:col-span-2">
                        <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          {f.label}
                        </Label>
                        <StringListEditor
                          items={(row[f.id] as string[]) ?? []}
                          onChange={(next) => {
                            const copy = items.slice();
                            copy[i] = { ...row, [f.id]: next };
                            onChange(copy);
                          }}
                          itemPlaceholder={
                            "itemPlaceholder" in f ? f.itemPlaceholder : undefined
                          }
                        />
                      </div>
                    );
                  }
                  return (
                    <ScalarInput
                      key={f.id}
                      field={f as ScalarField}
                      value={row[f.id]}
                      onChange={(v) => {
                        const copy = items.slice();
                        copy[i] = { ...row, [f.id]: v };
                        onChange(copy);
                      }}
                      span={
                        (f as ScalarField).type === "longtext" ? 2 : 1
                      }
                    />
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-9 w-full justify-center border border-dashed border-border text-primary hover:bg-primary/5 hover:text-primary"
        onClick={() => {
          onChange([...items, structuredClone(group.newItem)]);
          setOpenIdx(items.length);
        }}
      >
        <Plus size={14} className="mr-1" />
        Add {group.label.toLowerCase()}
      </Button>
    </div>
  );
}

function renderItemLabel(
  pattern: string | undefined,
  row: DataTree,
): string {
  if (!pattern) return "";
  return pattern.replace(/\{(\w+)\}/g, (_, k) => {
    const v = row[k];
    return typeof v === "string" ? v : "";
  });
}

// ---------------------------------------------------------------------------
// Path utilities — small immutable get/set on a nested data tree.
// ---------------------------------------------------------------------------

function getPath(obj: unknown, path: string): unknown {
  const parts = path.split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function setPath<T extends DataTree>(obj: T, path: string, value: unknown): T {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) return obj;
  const [head, ...rest] = parts;
  const cur =
    obj && typeof obj === "object"
      ? ((obj[head] as DataTree | undefined) ?? {})
      : {};
  return {
    ...obj,
    [head]:
      rest.length === 0
        ? value
        : setPath(cur, rest.join("."), value),
  } as T;
}
