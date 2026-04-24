"use client";

// FieldInspector — side-drawer showing raw PDF metadata for a field:
// decoded /Ff flags, /MaxLen, /TU tooltip, /Rect, page, options, etc.

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Copy } from "lucide-react";
import type { AcroFormField } from "./types";

const FLAG_LABELS: [number, string][] = [
  [1 << 0, "ReadOnly"],
  [1 << 1, "Required"],
  [1 << 2, "NoExport"],
  [1 << 12, "Multiline"],
  [1 << 13, "Password"],
  [1 << 14, "NoToggleOff"],
  [1 << 15, "Radio"],
  [1 << 16, "Pushbutton"],
  [1 << 17, "Combo"],
  [1 << 18, "Edit"],
  [1 << 19, "Sort"],
  [1 << 20, "FileSelect"],
  [1 << 21, "MultiSelect"],
  [1 << 22, "DoNotSpellCheck"],
  [1 << 23, "DoNotScroll"],
  [1 << 24, "Comb"],
  [1 << 25, "RichText"],
];

type Props = {
  field: AcroFormField | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
};

export function FieldInspector({ field, open, onOpenChange }: Props) {
  if (!field) return null;

  const flagNames = FLAG_LABELS.filter(([mask]) => (field.flags ?? 0) & mask).map(
    ([, name]) => name
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">{field.name}</DialogTitle>
        </DialogHeader>
        <dl className="grid grid-cols-[110px_1fr] gap-2 text-xs">
          <dt className="text-muted-foreground">Type</dt>
          <dd>{field.type}</dd>

          <dt className="text-muted-foreground">Page</dt>
          <dd>{field.page}</dd>

          {field.rect && (
            <>
              <dt className="text-muted-foreground">Rect</dt>
              <dd className="font-mono">
                x={field.rect.x.toFixed(1)} y={field.rect.y.toFixed(1)} w=
                {field.rect.w.toFixed(1)} h={field.rect.h.toFixed(1)}
              </dd>
            </>
          )}

          {field.pageSize && (
            <>
              <dt className="text-muted-foreground">Page size</dt>
              <dd className="font-mono">
                {field.pageSize.w.toFixed(0)} × {field.pageSize.h.toFixed(0)} pt
              </dd>
            </>
          )}

          {(field.flags ?? 0) > 0 && (
            <>
              <dt className="text-muted-foreground">Flags</dt>
              <dd>
                <div className="flex flex-wrap gap-1">
                  {flagNames.map((n) => (
                    <span
                      key={n}
                      className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]"
                    >
                      {n}
                    </span>
                  ))}
                </div>
                <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                  /Ff {field.flags} (0x{(field.flags ?? 0).toString(16)})
                </div>
              </dd>
            </>
          )}

          {field.maxLen ? (
            <>
              <dt className="text-muted-foreground">MaxLen</dt>
              <dd>{field.maxLen}</dd>
            </>
          ) : null}

          {field.tooltip && (
            <>
              <dt className="text-muted-foreground">Tooltip</dt>
              <dd>{field.tooltip}</dd>
            </>
          )}

          {field.default && (
            <>
              <dt className="text-muted-foreground">Default</dt>
              <dd className="font-mono">{field.default}</dd>
            </>
          )}

          {field.value && (
            <>
              <dt className="text-muted-foreground">Value</dt>
              <dd className="font-mono">{field.value}</dd>
            </>
          )}

          {field.options && field.options.length > 0 && (
            <>
              <dt className="text-muted-foreground">Options</dt>
              <dd>
                <ul className="list-disc pl-4">
                  {field.options.map((o) => (
                    <li key={o} className="font-mono text-[11px]">{o}</li>
                  ))}
                </ul>
              </dd>
            </>
          )}
        </dl>

        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              navigator.clipboard?.writeText(JSON.stringify(field, null, 2));
            }}
          >
            <Copy className="h-3.5 w-3.5" /> Copy JSON
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
