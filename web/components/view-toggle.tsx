"use client";

import { Grid3x3, LayoutList } from "lucide-react";
import type { ViewMode } from "@/hooks/use-view-mode";
import { cn } from "@/lib/utils";

type Props = {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
  className?: string;
};

export function ViewToggle({ value, onChange, className }: Props) {
  return (
    <div
      className={cn(
        "inline-flex rounded-md border bg-muted/40 p-0.5",
        className
      )}
    >
      <button
        onClick={() => onChange("list")}
        aria-label="List view"
        aria-pressed={value === "list"}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded px-2 text-xs font-medium transition-all",
          value === "list"
            ? "bg-background text-foreground shadow-subtle"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <LayoutList className="h-3.5 w-3.5" />
        List
      </button>
      <button
        onClick={() => onChange("grid")}
        aria-label="Grid view"
        aria-pressed={value === "grid"}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded px-2 text-xs font-medium transition-all",
          value === "grid"
            ? "bg-background text-foreground shadow-subtle"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <Grid3x3 className="h-3.5 w-3.5" />
        Grid
      </button>
    </div>
  );
}
