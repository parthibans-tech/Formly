"use client";

import { useState } from "react";
import {
  CalendarDays,
  CheckSquare,
  CircleDot,
  DollarSign,
  FilePlus2,
  Hash,
  ListFilter,
  Plus,
  TextCursorInput,
  Trash2,
  Type,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type { CreateFormOpts, FormField, FormFieldType } from "@/lib/create-form";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (opts: Omit<CreateFormOpts, "folderId">) => Promise<void>;
  busy?: boolean;
};

const FIELD_TYPES: { value: FormFieldType; label: string; icon: any }[] = [
  { value: "text", label: "Text", icon: Type },
  { value: "multiline", label: "Paragraph", icon: TextCursorInput },
  { value: "number", label: "Number", icon: Hash },
  { value: "currency", label: "Currency", icon: DollarSign },
  { value: "date", label: "Date", icon: CalendarDays },
  { value: "checkbox", label: "Checkbox", icon: CheckSquare },
  { value: "dropdown", label: "Dropdown", icon: ListFilter },
  { value: "radio", label: "Radio", icon: CircleDot },
];

export function FormBuilderDialog({ open, onOpenChange, onCreate, busy }: Props) {
  const [name, setName] = useState("Client intake form");
  const [title, setTitle] = useState("Client intake");
  const [subtitle, setSubtitle] = useState(
    "Please fill out every required field."
  );
  const [pageSize, setPageSize] = useState<CreateFormOpts["pageSize"]>("Letter");
  const [orientation, setOrientation] =
    useState<CreateFormOpts["orientation"]>("portrait");
  const [fields, setFields] = useState<FormField[]>([
    { id: id(), name: "full_name", label: "Full name", type: "text", required: true },
    { id: id(), name: "email", label: "Email", type: "text", required: true },
    { id: id(), name: "phone", label: "Phone", type: "text" },
    { id: id(), name: "start_date", label: "Start date", type: "date" },
    {
      id: id(),
      name: "notes",
      label: "Notes",
      type: "multiline",
    },
  ]);
  const [formError, setFormError] = useState<string | null>(null);

  function addField(type: FormFieldType = "text") {
    setFields((f) => [
      ...f,
      {
        id: id(),
        name: `field_${f.length + 1}`,
        label: "",
        type,
        options:
          type === "dropdown" || type === "radio"
            ? ["Option A", "Option B"]
            : undefined,
      },
    ]);
  }

  function update(idx: number, patch: Partial<FormField>) {
    setFields((f) => f.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  }

  function move(from: number, to: number) {
    setFields((f) => {
      if (to < 0 || to >= f.length) return f;
      const next = [...f];
      const [it] = next.splice(from, 1);
      next.splice(to, 0, it);
      return next;
    });
  }

  function remove(idx: number) {
    setFields((f) => f.filter((_, i) => i !== idx));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (fields.length === 0) {
      setFormError("Add at least one field.");
      return;
    }
    const missingName = fields.findIndex((f) => !f.name.trim());
    if (missingName >= 0) {
      setFormError(`Field #${missingName + 1} is missing a name.`);
      return;
    }
    const dupes = new Set<string>();
    for (const f of fields) {
      const k = f.name.trim();
      if (dupes.has(k)) {
        setFormError(`Duplicate field name: ${k}`);
        return;
      }
      dupes.add(k);
    }
    await onCreate({
      name: name.trim() || "Untitled form",
      title: title.trim(),
      subtitle: subtitle.trim(),
      pageSize,
      orientation,
      fields,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FilePlus2 className="h-5 w-5 text-primary" />
            Form builder
          </DialogTitle>
          <DialogDescription>
            List the fields you want to collect. Formly will generate a clean
            form PDF, auto-arrange each input, and map every field so the
            template is ready to fill immediately.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-5 max-h-[70vh] overflow-y-auto px-1">
          {/* Document + page settings */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="form-name">Document name</Label>
              <Input
                id="form-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Untitled form"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label>Page size</Label>
                <Select
                  value={pageSize}
                  onValueChange={(v) =>
                    setPageSize(v as CreateFormOpts["pageSize"])
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Letter">Letter</SelectItem>
                    <SelectItem value="Legal">Legal</SelectItem>
                    <SelectItem value="A4">A4</SelectItem>
                    <SelectItem value="A3">A3</SelectItem>
                    <SelectItem value="A5">A5</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Orientation</Label>
                <Select
                  value={orientation}
                  onValueChange={(v) =>
                    setOrientation(v as CreateFormOpts["orientation"])
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="portrait">Portrait</SelectItem>
                    <SelectItem value="landscape">Landscape</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="form-title">Title (on page)</Label>
              <Input
                id="form-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Client intake"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="form-subtitle">Subtitle / instructions</Label>
              <Input
                id="form-subtitle"
                value={subtitle}
                onChange={(e) => setSubtitle(e.target.value)}
                placeholder="Please fill out every required field."
              />
            </div>
          </div>

          <Separator />

          {/* Field list */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">Fields</h3>
                <p className="text-xs text-muted-foreground">
                  Drag-free auto-layout — fields stack top to bottom, pages wrap
                  automatically. Re-order with the arrows.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => addField()}>
                <Plus className="h-4 w-4" />
                Add field
              </Button>
            </div>

            {fields.length === 0 ? (
              <p className="rounded-md border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
                Add your first field to get started.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {fields.map((f, i) => {
                  const Icon =
                    FIELD_TYPES.find((t) => t.value === f.type)?.icon ?? Type;
                  return (
                    <li
                      key={f.id}
                      className="grid grid-cols-[24px_auto_1fr_1fr_110px_36px] items-start gap-2 rounded-md border bg-card p-2"
                    >
                      <div className="flex flex-col items-center pt-1 text-[10px] text-muted-foreground">
                        <button
                          type="button"
                          onClick={() => move(i, i - 1)}
                          disabled={i === 0}
                          className="hover:text-foreground disabled:opacity-30"
                        >
                          ▲
                        </button>
                        <span>{i + 1}</span>
                        <button
                          type="button"
                          onClick={() => move(i, i + 1)}
                          disabled={i === fields.length - 1}
                          className="hover:text-foreground disabled:opacity-30"
                        >
                          ▼
                        </button>
                      </div>
                      <span className="grid h-8 w-8 place-items-center rounded-md bg-muted text-muted-foreground">
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="space-y-1">
                        <Input
                          value={f.name}
                          onChange={(e) => update(i, { name: e.target.value })}
                          placeholder="field_name"
                          className="font-mono text-xs h-8"
                        />
                        {(f.type === "dropdown" || f.type === "radio") && (
                          <Input
                            value={(f.options || []).join(", ")}
                            onChange={(e) =>
                              update(i, {
                                options: e.target.value
                                  .split(",")
                                  .map((o) => o.trim())
                                  .filter(Boolean),
                              })
                            }
                            placeholder="Option A, Option B, Option C"
                            className="text-xs h-7"
                          />
                        )}
                      </div>
                      <Input
                        value={f.label}
                        onChange={(e) => update(i, { label: e.target.value })}
                        placeholder="Label shown on the page"
                        className="text-xs h-8"
                      />
                      <div className="flex flex-col gap-1">
                        <Select
                          value={f.type}
                          onValueChange={(v) => {
                            const next: Partial<FormField> = {
                              type: v as FormFieldType,
                            };
                            if (
                              (v === "dropdown" || v === "radio") &&
                              !f.options
                            ) {
                              next.options = ["Option A", "Option B"];
                            }
                            update(i, next);
                          }}
                        >
                          <SelectTrigger className="h-7 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {FIELD_TYPES.map((t) => (
                              <SelectItem key={t.value} value={t.value}>
                                {t.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <input
                            type="checkbox"
                            className="h-3 w-3 accent-primary"
                            checked={!!f.required}
                            onChange={(e) =>
                              update(i, { required: e.target.checked })
                            }
                          />
                          required
                        </label>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => remove(i)}
                        aria-label="Remove field"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {formError && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {formError}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              <FilePlus2 className="h-4 w-4" />
              Generate form
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function id(): string {
  return Math.random().toString(36).slice(2, 10);
}
