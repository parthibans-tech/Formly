"use client";

// Command palette (Cmd+K / Ctrl+K). Shared by all three designers. Each
// designer passes its own list of `Command`s and owns the actions they
// perform. Keeps keyboard handling + fuzzy filtering + UI in one place.

import { useEffect, useMemo, useRef, useState } from "react";
import { Command as CommandIcon, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type Command = {
  id: string;
  label: string;
  hint?: string;           // short keyboard hint like "⌘D"
  group?: string;          // section header
  keywords?: string[];     // extra match terms
  icon?: React.ComponentType<{ className?: string }>;
  run: () => void;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: Command[];
};

export function CommandPalette({ open, onOpenChange, commands }: Props) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state on open; focus the input so the user can just start typing.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    // Radix dialog autofocus can race with our own ref — wait a tick.
    const t = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(t);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => {
      const hay = [
        c.label,
        c.group,
        c.hint,
        ...(c.keywords || []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      // Match tokens independently so "al cen" finds "Align center".
      return q
        .split(/\s+/)
        .every((tok) => hay.includes(tok));
    });
  }, [commands, query]);

  // Group for the rendered list. Preserves first-seen order.
  const grouped = useMemo(() => {
    const groups: { name: string; items: Command[] }[] = [];
    const index: Record<string, Command[]> = {};
    for (const c of filtered) {
      const g = c.group || "Actions";
      if (!index[g]) {
        index[g] = [];
        groups.push({ name: g, items: index[g] });
      }
      index[g].push(c);
    }
    return groups;
  }, [filtered]);

  // Stable flat index for keyboard navigation — matches the render order.
  const flat = useMemo(
    () => grouped.flatMap((g) => g.items),
    [grouped]
  );

  useEffect(() => {
    if (cursor >= flat.length) setCursor(Math.max(0, flat.length - 1));
  }, [flat.length, cursor]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = flat[cursor];
      if (cmd) {
        cmd.run();
        onOpenChange(false);
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 overflow-hidden">
        <DialogHeader className="sr-only">
          <DialogTitle>Command palette</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Type a command…"
            className="h-8 border-0 px-0 shadow-none focus-visible:ring-0"
            aria-label="Command input"
          />
          <span className="hidden sm:inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono">
              ↑↓
            </kbd>
            to navigate
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono ml-1">
              ↵
            </kbd>
            to run
          </span>
        </div>
        <div className="max-h-80 overflow-y-auto py-1">
          {flat.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <CommandIcon className="mx-auto mb-2 h-5 w-5 opacity-60" />
              No commands match.
            </div>
          ) : (
            grouped.map((g) => (
              <div key={g.name}>
                <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {g.name}
                </div>
                <ul>
                  {g.items.map((c) => {
                    const i = flat.indexOf(c);
                    const active = i === cursor;
                    const Icon = c.icon;
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          onMouseEnter={() => setCursor(i)}
                          onClick={() => {
                            c.run();
                            onOpenChange(false);
                          }}
                          className={cn(
                            "flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm",
                            active ? "bg-accent text-accent-foreground" : "hover:bg-muted/40"
                          )}
                        >
                          {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
                          <span className="flex-1 truncate">{c.label}</span>
                          {c.hint && (
                            <kbd className="rounded border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                              {c.hint}
                            </kbd>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
