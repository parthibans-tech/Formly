"use client";

import { useEffect, useState } from "react";
import {
  Calculator,
  GripVertical,
  Plus,
  Trash2,
  TriangleAlert,
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

export type ComputedDef = {
  name: string;
  expression: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value?: ComputedDef[];
  onSave: (defs: ComputedDef[]) => Promise<void> | void;
  busy?: boolean;
};

const EXAMPLES: { name: string; expression: string; hint: string }[] = [
  {
    name: "subtotal",
    expression: "sum(items, 'amount')",
    hint: "Sum the 'amount' field across a list",
  },
  {
    name: "tax",
    expression: "subtotal * 0.09",
    hint: "Reference earlier computed field",
  },
  {
    name: "total",
    expression: "subtotal + tax",
    hint: "Arithmetic on previously computed values",
  },
  {
    name: "isOverdue",
    expression: "parseDate(dueAt) < today()",
    hint: "Boolean flag for conditional rendering",
  },
  {
    name: "itemCount",
    expression: "count(items)",
    hint: "Count elements in a list",
  },
];

export function ComputedFieldsDialog({
  open,
  onOpenChange,
  value,
  onSave,
  busy,
}: Props) {
  const [defs, setDefs] = useState<ComputedDef[]>([]);

  useEffect(() => {
    if (open) setDefs(value ?? []);
  }, [open, value]);

  function update(idx: number, patch: Partial<ComputedDef>) {
    setDefs((d) => d.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  }
  function add() {
    setDefs((d) => [...d, { name: "", expression: "" }]);
  }
  function remove(idx: number) {
    setDefs((d) => d.filter((_, i) => i !== idx));
  }
  function move(from: number, to: number) {
    setDefs((d) => {
      if (to < 0 || to >= d.length) return d;
      const next = [...d];
      const [it] = next.splice(from, 1);
      next.splice(to, 0, it);
      return next;
    });
  }

  const nameConflict = (() => {
    const seen = new Set<string>();
    for (const d of defs) {
      const k = d.name.trim();
      if (!k) continue;
      if (seen.has(k)) return k;
      seen.add(k);
    }
    return null;
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calculator className="h-5 w-5 text-primary" />
            Computed fields
          </DialogTitle>
          <DialogDescription>
            Add derived values that the template can reference as{" "}
            <code className="font-mono text-xs">{"{{ .name }}"}</code>.
            Expressions are evaluated in order on every render.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-1">
          {defs.length === 0 ? (
            <div className="rounded-md border border-dashed bg-muted/30 p-6 text-center">
              <Calculator className="mx-auto h-6 w-6 text-muted-foreground" />
              <p className="mt-2 text-sm font-medium">No computed fields yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Add calculations, flags, or totals below. They become part of
                the data context — referenceable as{" "}
                <code className="font-mono">{"{{ .name }}"}</code>.
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                {EXAMPLES.slice(0, 3).map((ex) => (
                  <button
                    key={ex.name}
                    type="button"
                    onClick={() =>
                      setDefs((d) => [
                        ...d,
                        { name: ex.name, expression: ex.expression },
                      ])
                    }
                    className="rounded-full border px-2.5 py-1 text-[10px] font-medium text-muted-foreground hover:bg-accent"
                    title={ex.hint}
                  >
                    + {ex.name}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-[24px_180px_1fr_36px] items-center gap-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                <span />
                <span>Name</span>
                <span>Expression</span>
                <span />
              </div>
              {defs.map((d, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[24px_180px_1fr_36px] items-start gap-2 rounded-md border bg-card p-2"
                >
                  <div className="flex flex-col items-center pt-1.5 text-muted-foreground">
                    <button
                      type="button"
                      onClick={() => move(i, i - 1)}
                      className="p-0.5 text-[10px] hover:text-foreground disabled:opacity-30"
                      disabled={i === 0}
                      title="Move up"
                    >
                      ▲
                    </button>
                    <GripVertical className="h-3 w-3" />
                    <button
                      type="button"
                      onClick={() => move(i, i + 1)}
                      className="p-0.5 text-[10px] hover:text-foreground disabled:opacity-30"
                      disabled={i === defs.length - 1}
                      title="Move down"
                    >
                      ▼
                    </button>
                  </div>
                  <Input
                    value={d.name}
                    onChange={(e) => update(i, { name: e.target.value })}
                    placeholder="subtotal"
                    className="font-mono text-xs h-8"
                    error={!!nameConflict && nameConflict === d.name.trim()}
                  />
                  <Input
                    value={d.expression}
                    onChange={(e) => update(i, { expression: e.target.value })}
                    placeholder='sum(items, "amount")'
                    className="font-mono text-xs h-8"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => remove(i)}
                    aria-label="Remove"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <Button variant="outline" onClick={add} className="w-full">
            <Plus className="h-4 w-4" />
            Add computed field
          </Button>

          {nameConflict && (
            <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 text-warning-foreground" />
              <span>
                Duplicate name: <code className="font-mono">{nameConflict}</code>.
                Later entries override earlier ones.
              </span>
            </div>
          )}

          <details className="rounded-md border bg-muted/30 p-3 text-xs">
            <summary className="cursor-pointer font-semibold">
              Expression cheatsheet
            </summary>
            <div className="mt-2 space-y-1.5 font-mono">
              <div>
                <span className="text-muted-foreground">Arithmetic:</span>{" "}
                price * (1 + tax)
              </div>
              <div>
                <span className="text-muted-foreground">Comparison:</span>{" "}
                dueDate &lt; today()
              </div>
              <div>
                <span className="text-muted-foreground">String:</span>{" "}
                upper(customer.name)
              </div>
              <div>
                <span className="text-muted-foreground">Sum a field:</span>{" "}
                sum(items, &apos;amount&apos;)
              </div>
              <div>
                <span className="text-muted-foreground">Count:</span>{" "}
                count(items)
              </div>
              <div>
                <span className="text-muted-foreground">Min / max:</span>{" "}
                min_(items), max_(items)
              </div>
              <div>
                <span className="text-muted-foreground">Date parse:</span>{" "}
                parseDate(dob)
              </div>
              <div>
                <span className="text-muted-foreground">Conditional:</span>{" "}
                isPaid ? &apos;Paid&apos; : &apos;Due&apos;
              </div>
              <div>
                <span className="text-muted-foreground">Logical:</span>{" "}
                (amount &gt; 1000) &amp;&amp; isVip
              </div>
              <div>
                <span className="text-muted-foreground">Default:</span>{" "}
                default_(&apos;N/A&apos;, customer.note)
              </div>
            </div>
          </details>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            onClick={() => onSave(defs.filter((d) => d.name.trim() !== ""))}
            loading={busy}
          >
            <Calculator className="h-4 w-4" />
            Save computed fields
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
