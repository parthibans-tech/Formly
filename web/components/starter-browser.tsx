"use client";

import { useMemo, useState } from "react";
import {
  Award,
  FileCheck2,
  FileSignature,
  FileText,
  Plus,
  Receipt,
  Search,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  BLANK_STARTER,
  STARTERS,
  STARTER_CATEGORIES,
  type Starter,
  type StarterCategory,
} from "@/lib/starters";
import { miniRender } from "@/lib/starters/mini-render";
import { cn } from "@/lib/utils";

const ICONS: Record<string, LucideIcon> = {
  invoice: FileText,
  receipt: Receipt,
  nda: FileSignature,
  "offer-letter": FileCheck2,
  certificate: Award,
  blank: Sparkles,
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (s: Starter) => void | Promise<void>;
  creatingId: string | null;
};

export function StarterBrowser({ open, onOpenChange, onSelect, creatingId }: Props) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<StarterCategory | "all">("all");
  const [focused, setFocused] = useState<Starter | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return STARTERS.filter((s) => {
      const inCat = category === "all" || s.category === category;
      if (!inCat) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [search, category]);

  const active = focused ?? filtered[0] ?? BLANK_STARTER;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl gap-0 p-0 sm:rounded-xl overflow-hidden">
        <DialogHeader className="border-b p-5">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Start from a template
          </DialogTitle>
          <DialogDescription>
            Pick a starter to jump-start your document. You can customize
            everything in the editor afterward.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr]">
          {/* Left: list */}
          <div className="flex max-h-[560px] flex-col border-r">
            <div className="space-y-3 border-b p-4">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search templates…"
                  className="pl-9"
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                <CategoryChip
                  active={category === "all"}
                  onClick={() => setCategory("all")}
                >
                  All
                </CategoryChip>
                {STARTER_CATEGORIES.filter((c) =>
                  STARTERS.some((s) => s.category === c)
                ).map((c) => (
                  <CategoryChip
                    key={c}
                    active={category === c}
                    onClick={() => setCategory(c)}
                  >
                    {c}
                  </CategoryChip>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              <button
                onClick={() => setFocused(BLANK_STARTER)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-accent",
                  active.id === BLANK_STARTER.id && "bg-accent"
                )}
              >
                <span className="mt-0.5 grid h-8 w-8 place-items-center rounded-md bg-muted text-muted-foreground">
                  <Plus className="h-4 w-4" />
                </span>
                <span className="flex-1">
                  <span className="block text-sm font-medium">Blank</span>
                  <span className="block text-xs text-muted-foreground">
                    Start from scratch
                  </span>
                </span>
              </button>

              <Separator className="my-2" />

              {filtered.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No templates match your search.
                </p>
              ) : (
                filtered.map((s) => {
                  const Icon = ICONS[s.id] ?? FileText;
                  const isActive = active.id === s.id;
                  return (
                    <button
                      key={s.id}
                      onClick={() => setFocused(s)}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-accent",
                        isActive && "bg-accent"
                      )}
                    >
                      <span className="mt-0.5 grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">
                            {s.name}
                          </span>
                          <Badge variant="outline" className="text-[10px]">
                            {s.category}
                          </Badge>
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {s.description}
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Right: preview + CTA */}
          <div className="flex max-h-[560px] min-h-[420px] flex-col">
            <div className="flex items-start gap-3 border-b p-5">
              <span className="mt-0.5 grid h-10 w-10 place-items-center rounded-md bg-primary/10 text-primary">
                {(() => {
                  const Icon = ICONS[active.id] ?? FileText;
                  return <Icon className="h-5 w-5" />;
                })()}
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="font-semibold">{active.name}</h3>
                <p className="text-sm text-muted-foreground">
                  {active.description}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  <Badge variant="secondary" className="text-[10px]">
                    {active.category}
                  </Badge>
                  {active.tags.map((t) => (
                    <Badge
                      key={t}
                      variant="outline"
                      className="text-[10px] font-normal"
                    >
                      {t}
                    </Badge>
                  ))}
                </div>
              </div>
              <Button
                onClick={() => onSelect(active)}
                loading={creatingId === active.id}
              >
                Use this template
              </Button>
            </div>

            <div className="relative flex-1 overflow-hidden bg-muted/40">
              <iframe
                key={active.id}
                srcDoc={miniRender(active.html, active.sampleData)}
                sandbox="allow-same-origin"
                title={`${active.name} preview`}
                className="absolute left-0 top-0 h-[1400px] w-[1000px] origin-top-left bg-white"
                style={{ transform: "scale(0.55)" }}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CategoryChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
