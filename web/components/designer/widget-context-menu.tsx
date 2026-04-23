"use client";

// Floating right-click context menu. Custom implementation rather than
// Radix ContextMenu — we need it to open at arbitrary cursor positions
// (right-click event coords) without a dedicated trigger element per
// widget.

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export type MenuItem =
  | { kind: "item"; label: string; hint?: string; disabled?: boolean; danger?: boolean; run: () => void }
  | { kind: "separator" };

type Props = {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
};

export function WidgetContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on any outside click or Escape — mirrors native context-menu UX.
  useEffect(() => {
    function onDocDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Keep menu inside the viewport — flip if near the right/bottom edges.
  const viewportW = typeof window !== "undefined" ? window.innerWidth : 1200;
  const viewportH = typeof window !== "undefined" ? window.innerHeight : 800;
  const WIDTH = 220;
  const HEIGHT = Math.min(400, items.length * 28 + 16);
  const adjX = Math.min(x, viewportW - WIDTH - 8);
  const adjY = Math.min(y, viewportH - HEIGHT - 8);

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[60] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg"
      style={{ left: adjX, top: adjY, width: WIDTH }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <ul className="py-1 text-sm">
        {items.map((it, i) => {
          if (it.kind === "separator") {
            return <li key={i} className="my-1 h-px bg-border" />;
          }
          return (
            <li key={i}>
              <button
                type="button"
                disabled={it.disabled}
                onClick={() => {
                  if (it.disabled) return;
                  it.run();
                  onClose();
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left",
                  it.disabled
                    ? "cursor-default text-muted-foreground"
                    : it.danger
                    ? "text-destructive hover:bg-destructive/10"
                    : "hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <span>{it.label}</span>
                {it.hint && (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {it.hint}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
