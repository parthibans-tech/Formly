"use client";

// Shortcut help overlay — pops on "?" in every designer.

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Keyboard } from "lucide-react";

export type Shortcut = {
  keys: string;           // e.g. "⌘K", "↑", "Shift+Arrow"
  label: string;
  group?: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shortcuts: Shortcut[];
};

export function ShortcutHelp({ open, onOpenChange, shortcuts }: Props) {
  const grouped: Record<string, Shortcut[]> = {};
  const order: string[] = [];
  for (const s of shortcuts) {
    const g = s.group || "General";
    if (!grouped[g]) {
      grouped[g] = [];
      order.push(g);
    }
    grouped[g].push(s);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="h-5 w-5 text-primary" />
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription>
            Press <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[11px]">?</kbd>{" "}
            any time to open this panel.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {order.map((g) => (
            <section key={g}>
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {g}
              </h3>
              <ul className="divide-y rounded-md border">
                {grouped[g].map((s) => (
                  <li
                    key={s.keys + s.label}
                    className="flex items-center justify-between px-3 py-1.5 text-sm"
                  >
                    <span>{s.label}</span>
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                      {s.keys}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Small helper: returns the correct modifier symbol for the current
// platform so shortcut hints render naturally (⌘ on mac, Ctrl elsewhere).
export function modSymbol(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  return /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
}
