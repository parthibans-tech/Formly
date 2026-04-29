"use client";

import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Award,
  Briefcase,
  CalendarCheck,
  CalendarHeart,
  CheckSquare,
  ChevronRight,
  ClipboardList,
  Coins,
  FileBarChart,
  FileCheck2,
  FileSignature,
  FileSpreadsheet,
  FileText,
  Folder,
  GraduationCap,
  Mail,
  Megaphone,
  Plus,
  Presentation,
  Receipt,
  ScrollText,
  Search,
  Sparkles,
  Stamp,
  Ticket,
  TrendingUp,
  UserSquare,
  Wand2,
  Workflow,
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
import {
  BLANK_STARTER,
  STARTERS,
  type Starter,
  type StarterCategory,
} from "@/lib/starters";
import { miniRender } from "@/lib/starters/mini-render";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Icon maps
// ---------------------------------------------------------------------------

const ICONS: Record<string, LucideIcon> = {
  invoice: FileText,
  receipt: Receipt,
  statement: FileSpreadsheet,
  nda: FileSignature,
  "lease-agreement": Stamp,
  "offer-letter": FileCheck2,
  resume: UserSquare,
  "performance-review": TrendingUp,
  certificate: Award,
  letter: Mail,
  "cover-letter": Mail,
  "meeting-notes": CalendarCheck,
  "status-report": FileBarChart,
  "expense-report": Coins,
  proposal: Presentation,
  "press-release": Megaphone,
  quote: FileSpreadsheet,
  "purchase-order": ClipboardList,
  sop: Workflow,
  checklist: CheckSquare,
  "event-invite": CalendarHeart,
  "event-ticket": Ticket,
  syllabus: GraduationCap,
  blank: Sparkles,
};

const CATEGORY_ICONS: Record<StarterCategory, LucideIcon> = {
  Billing: Receipt,
  Legal: Stamp,
  HR: Briefcase,
  Certificates: Award,
  Commerce: FileText,
  Correspondence: Mail,
  Reports: ScrollText,
  Marketing: Megaphone,
  Finance: Coins,
  Operations: Workflow,
  Events: CalendarHeart,
  Education: GraduationCap,
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** User picked an in-built starter — parent creates the doc and opens it. */
  onSelect: (s: Starter) => void | Promise<void>;
  /** User chose "Create custom" — parent opens the empty designer. Falls
   *  back to onSelect(BLANK_STARTER) when not provided. */
  onCreateCustom?: () => void | Promise<void>;
  creatingId: string | null;
};

type View =
  | { kind: "categories" }
  | { kind: "templates"; category: StarterCategory };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StarterBrowser({
  open,
  onOpenChange,
  onSelect,
  onCreateCustom,
  creatingId,
}: Props) {
  const [view, setView] = useState<View>({ kind: "categories" });
  const [search, setSearch] = useState("");
  const [focused, setFocused] = useState<Starter | null>(null);

  // Category list with live counts.  Empty categories don't show.
  const categories = useMemo(() => {
    const map = new Map<StarterCategory, Starter[]>();
    for (const s of STARTERS) {
      const arr = map.get(s.category) ?? [];
      arr.push(s);
      map.set(s.category, arr);
    }
    return Array.from(map.entries()).map(([cat, items]) => ({ cat, items }));
  }, []);

  // Templates in the current category, filtered by search.
  const visibleTemplates = useMemo(() => {
    if (view.kind !== "templates") return [];
    const q = search.trim().toLowerCase();
    return STARTERS.filter((s) => s.category === view.category).filter((s) => {
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [view, search]);

  function openCategory(cat: StarterCategory) {
    setView({ kind: "templates", category: cat });
    setFocused(null);
    setSearch("");
  }

  function backToCategories() {
    setView({ kind: "categories" });
    setFocused(null);
    setSearch("");
  }

  async function handleCreateCustom() {
    if (onCreateCustom) {
      await onCreateCustom();
    } else {
      await onSelect(BLANK_STARTER);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl gap-0 overflow-hidden p-0 sm:rounded-xl">
        <DialogHeader className="border-b p-5">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Start a new document
          </DialogTitle>
          <DialogDescription>
            Pick a category to browse our standard templates, or start from a
            blank canvas to design your own.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-[560px]">
          {view.kind === "categories" ? (
            <CategoriesView
              categories={categories}
              onOpenCategory={openCategory}
              onCreateCustom={handleCreateCustom}
              creating={creatingId === BLANK_STARTER.id}
            />
          ) : (
            <TemplatesView
              category={view.category}
              templates={visibleTemplates}
              search={search}
              setSearch={setSearch}
              focused={focused}
              setFocused={setFocused}
              onBack={backToCategories}
              onUse={onSelect}
              creatingId={creatingId}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Categories
// ---------------------------------------------------------------------------

function CategoriesView({
  categories,
  onOpenCategory,
  onCreateCustom,
  creating,
}: {
  categories: { cat: StarterCategory; items: Starter[] }[];
  onOpenCategory: (cat: StarterCategory) => void;
  onCreateCustom: () => void | Promise<void>;
  creating: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-6 p-6 lg:grid-cols-[1fr_320px]">
      {/* Left: standard template categories */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Standard templates</h3>
          <span className="text-[11px] text-muted-foreground">
            Pre-designed · just fill in the data
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {categories.map(({ cat, items }) => {
            const Icon = CATEGORY_ICONS[cat] ?? Folder;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => onOpenCategory(cat)}
                className="group flex items-start gap-3 rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/30"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                  <Icon className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold">
                      {cat}
                    </span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {items.length} template{items.length === 1 ? "" : "s"}
                    {" · "}
                    {items
                      .slice(0, 2)
                      .map((s) => s.name)
                      .join(", ")}
                    {items.length > 2 ? "…" : ""}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right: custom path */}
      <div>
        <div className="mb-3 text-sm font-semibold">Custom</div>
        <button
          type="button"
          onClick={() => void onCreateCustom()}
          disabled={creating}
          className="flex h-full w-full flex-col items-start gap-3 rounded-lg border-2 border-dashed border-border bg-background p-5 text-left transition-colors hover:border-primary/40 hover:bg-primary/5 disabled:opacity-60"
        >
          <span className="grid h-10 w-10 place-items-center rounded-md bg-primary text-primary-foreground">
            <Wand2 className="h-5 w-5" />
          </span>
          <span className="block text-sm font-semibold">
            Create custom template
          </span>
          <span className="block text-xs text-muted-foreground">
            Open the designer with a blank canvas. Build your own layout, add
            data fields, repeats, conditionals — everything is yours to shape.
          </span>
          <span className="mt-auto inline-flex items-center gap-1 text-xs font-medium text-primary">
            {creating ? "Opening…" : "Start blank"}
            <ChevronRight className="h-3.5 w-3.5" />
          </span>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Templates within a category
// ---------------------------------------------------------------------------

function TemplatesView({
  category,
  templates,
  search,
  setSearch,
  focused,
  setFocused,
  onBack,
  onUse,
  creatingId,
}: {
  category: StarterCategory;
  templates: Starter[];
  search: string;
  setSearch: (v: string) => void;
  focused: Starter | null;
  setFocused: (s: Starter | null) => void;
  onBack: () => void;
  onUse: (s: Starter) => void | Promise<void>;
  creatingId: string | null;
}) {
  const active = focused ?? templates[0] ?? null;
  const CategoryIcon = CATEGORY_ICONS[category] ?? Folder;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr]">
      {/* Left: template list within the category */}
      <div className="flex max-h-[560px] flex-col border-r">
        <div className="space-y-3 border-b p-4">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            All categories
          </button>
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-primary/10 text-primary">
              <CategoryIcon className="h-4 w-4" />
            </span>
            <div>
              <div className="text-sm font-semibold">{category}</div>
              <div className="text-[11px] text-muted-foreground">
                {templates.length} template{templates.length === 1 ? "" : "s"}
              </div>
            </div>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${category.toLowerCase()}…`}
              className="pl-9"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {templates.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              No templates match your search.
            </p>
          ) : (
            templates.map((s) => {
              const Icon = ICONS[s.id] ?? FileText;
              const isActive = active?.id === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setFocused(s)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-accent",
                    isActive && "bg-accent",
                  )}
                >
                  <span className="mt-0.5 grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {s.name}
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
        {active ? (
          <>
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
                onClick={() => onUse(active)}
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
          </>
        ) : (
          <div className="grid flex-1 place-items-center p-8 text-center">
            <div>
              <Plus className="mx-auto h-8 w-8 text-muted-foreground/40" />
              <p className="mt-2 text-sm text-muted-foreground">
                No templates in this category yet.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
