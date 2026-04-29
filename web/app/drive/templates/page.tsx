"use client";

/**
 * /drive/templates — the in-built templates gallery.
 *
 * Two-step browse:
 *   1. Categories grid (Billing, Legal, HR, …) plus a "Create custom" card
 *      that opens the blank designer.
 *   2. Templates within a chosen category, each with a live mini preview.
 *      Clicking "Use this template" seeds a new doc-mode template from the
 *      starter and opens it in the designer.
 *
 * The same starters surface in the in-app StarterBrowser dialog; this page
 * is the full-screen "browse and start" experience for users who land here
 * from the sidebar.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Award,
  BadgeCheck,
  BarChart3,
  BookCheck,
  BookOpen,
  BookText,
  Briefcase,
  BriefcaseBusiness,
  CalendarCheck,
  CalendarHeart,
  CheckSquare,
  ChevronRight,
  ClipboardList,
  Cloud,
  Code2,
  Coins,
  Columns,
  Crown,
  FileBarChart,
  FileCheck2,
  FilePlus2,
  FileSignature,
  FileSpreadsheet,
  FileText,
  Folder,
  Gem,
  Globe,
  GraduationCap,
  HandHeart,
  Handshake,
  HeartHandshake,
  IndianRupee,
  Landmark,
  Layers,
  ListChecks,
  Mail,
  Medal,
  Megaphone,
  Minus,
  Newspaper,
  Palette,
  PenLine,
  PlaneTakeoff,
  Presentation,
  Printer,
  Receipt,
  Repeat,
  ScrollText,
  Search,
  Smartphone,
  Sparkle,
  Sparkles,
  Stamp,
  Star,
  Store,
  Target,
  ThumbsUp,
  Ticket,
  TrendingUp,
  Trophy,
  Users,
  UserSquare,
  UserX,
  Wallet,
  Wand2,
  Workflow,
  Wrench,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  BLANK_STARTER,
  STARTERS,
  getStarterDoc,
  type Starter,
  type StarterCategory,
} from "@/lib/starters";
import { miniRender } from "@/lib/starters/mini-render";
import { createDocTemplate } from "@/lib/create-doc";

const ICONS: Record<string, LucideIcon> = {
  invoice: FileText,
  receipt: Receipt,
  statement: FileSpreadsheet,
  "thermal-bill": Printer,
  "e-bill": Zap,
  "mobile-bill": Smartphone,
  "manual-bill": PenLine,
  "pos-bill": Store,
  "cloud-bill": Cloud,
  "subscription-bill": Repeat,
  "gst-invoice": IndianRupee,
  nda: FileSignature,
  "lease-agreement": Stamp,
  "offer-letter": FileCheck2,
  "appointment-letter": Handshake,
  "employment-contract": BookText,
  "job-description": Newspaper,
  "onboarding-checklist": ListChecks,
  "promotion-letter": Trophy,
  pip: Target,
  "warning-letter": AlertTriangle,
  "recommendation-letter": ThumbsUp,
  "leave-application": PlaneTakeoff,
  "salary-slip": Wallet,
  "experience-certificate": BadgeCheck,
  "termination-letter": UserX,
  resume: UserSquare,
  "resume-classic": ScrollText,
  "resume-two-column": Columns,
  "resume-creative": Palette,
  "resume-executive": Crown,
  "resume-tech": Code2,
  "resume-academic": BookOpen,
  "resume-functional": Layers,
  "resume-infographic": BarChart3,
  "resume-federal": Landmark,
  "resume-european": Globe,
  "resume-onepage": Minus,
  "resume-with-cover": FilePlus2,
  "performance-review": TrendingUp,
  certificate: Award,
  "certificate-achievement": Medal,
  "certificate-participation": Users,
  "certificate-appreciation": HeartHandshake,
  "certificate-excellence": Gem,
  "certificate-training": BookCheck,
  "certificate-internship": BriefcaseBusiness,
  "certificate-award": Sparkle,
  "certificate-employee-month": Star,
  "certificate-volunteer": HandHeart,
  "certificate-workshop": Wrench,
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
  Resume: UserSquare,
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

type View =
  | { kind: "categories" }
  | { kind: "templates"; category: StarterCategory };

export default function TemplatesPage() {
  const router = useRouter();
  const toast = useToast();
  const [view, setView] = useState<View>({ kind: "categories" });
  const [search, setSearch] = useState("");
  const [creatingId, setCreatingId] = useState<string | null>(null);

  const categories = useMemo(() => {
    const map = new Map<StarterCategory, Starter[]>();
    for (const s of STARTERS) {
      const arr = map.get(s.category) ?? [];
      arr.push(s);
      map.set(s.category, arr);
    }
    return Array.from(map.entries()).map(([cat, items]) => ({ cat, items }));
  }, []);

  const inCategory = useMemo(() => {
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

  async function useStarter(s: Starter) {
    // In-built starters open in fill mode — non-tech users get a structured
    // form + live preview, never raw placeholders. Blank custom starts go
    // through the designer for full authoring control.
    if (s.id !== BLANK_STARTER.id) {
      setCreatingId(s.id);
      router.push(`/starters/${s.id}`);
      return;
    }

    setCreatingId(s.id);
    try {
      const { stored, diagnostics } = getStarterDoc(s);
      const { templateId } = await createDocTemplate({
        name: "Untitled template",
        seedDoc: stored.doc,
        themeCss: stored.themeCss,
      });
      toast.show("success", "Created blank template", {
        description:
          diagnostics.length > 0
            ? `${diagnostics.length} block${diagnostics.length === 1 ? "" : "s"} kept as raw HTML — open the doc to clean up.`
            : "Opening the editor…",
      });
      router.push(`/templates/${templateId}/designer`);
    } catch (e: unknown) {
      toast.show("error", "Couldn't create template", {
        description: (e as Error).message,
      });
    } finally {
      setCreatingId(null);
    }
  }

  return (
    <AppShell
      search={
        view.kind === "templates"
          ? {
              value: search,
              onChange: setSearch,
              placeholder: `Search ${view.category.toLowerCase()}…`,
            }
          : undefined
      }
    >
      {view.kind === "categories" ? (
        <CategoriesView
          categories={categories}
          onOpenCategory={(cat) => {
            setView({ kind: "templates", category: cat });
            setSearch("");
          }}
          onCreateCustom={() => useStarter(BLANK_STARTER)}
          creating={creatingId === BLANK_STARTER.id}
        />
      ) : (
        <TemplatesView
          category={view.category}
          templates={inCategory}
          search={search}
          onBack={() => {
            setView({ kind: "categories" });
            setSearch("");
          }}
          onUse={useStarter}
          creatingId={creatingId}
        />
      )}
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Categories view
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
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Templates</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Start from a pre-designed template, or build your own from scratch.
        </p>
      </div>

      <section className="mb-8">
        <div className="mb-3 flex items-end justify-between">
          <div>
            <h2 className="text-base font-semibold">Standard templates</h2>
            <p className="text-xs text-muted-foreground">
              Pick a category — fill in the data, we keep the design.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {categories.map(({ cat, items }) => {
            const Icon = CATEGORY_ICONS[cat] ?? Folder;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => onOpenCategory(cat)}
                className="group flex items-start gap-3 rounded-xl border bg-card p-5 text-left transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
              >
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-base font-semibold">
                      {cat}
                    </span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {items.length} template{items.length === 1 ? "" : "s"}
                  </span>
                  <span className="mt-2 flex flex-wrap gap-1">
                    {items.slice(0, 3).map((s) => (
                      <Badge
                        key={s.id}
                        variant="outline"
                        className="text-[10px] font-normal"
                      >
                        {s.name}
                      </Badge>
                    ))}
                    {items.length > 3 ? (
                      <Badge variant="outline" className="text-[10px]">
                        +{items.length - 3}
                      </Badge>
                    ) : null}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <div className="mb-3">
          <h2 className="text-base font-semibold">Custom</h2>
          <p className="text-xs text-muted-foreground">
            Need something different? Start with a blank canvas.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void onCreateCustom()}
          disabled={creating}
          className="flex w-full items-center gap-4 rounded-xl border-2 border-dashed border-border bg-background p-5 text-left transition-colors hover:border-primary/40 hover:bg-primary/5 disabled:opacity-60"
        >
          <span className="grid h-11 w-11 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Wand2 className="h-5 w-5" />
          </span>
          <span className="flex-1">
            <span className="block text-base font-semibold">
              Create custom template
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Open the designer with a blank canvas. Add data fields, repeats,
              conditionals — full control.
            </span>
          </span>
          <span className="inline-flex items-center gap-1 text-sm font-medium text-primary">
            {creating ? "Opening…" : "Start blank"}
            <ChevronRight className="h-4 w-4" />
          </span>
        </button>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Templates within a category
// ---------------------------------------------------------------------------

function TemplatesView({
  category,
  templates,
  search,
  onBack,
  onUse,
  creatingId,
}: {
  category: StarterCategory;
  templates: Starter[];
  search: string;
  onBack: () => void;
  onUse: (s: Starter) => void | Promise<void>;
  creatingId: string | null;
}) {
  const Icon = CATEGORY_ICONS[category] ?? Folder;
  return (
    <>
      <div className="mb-6">
        <button
          type="button"
          onClick={onBack}
          className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All categories
        </button>
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
            <Icon className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {category}
            </h1>
            <p className="text-sm text-muted-foreground">
              {templates.length} template{templates.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
      </div>

      {templates.length === 0 ? (
        <div className="rounded-lg border bg-card p-10 text-center">
          <Search className="mx-auto h-8 w-8 text-muted-foreground/40" />
          <p className="mt-2 text-sm text-muted-foreground">
            {search
              ? "No templates match your search."
              : "No templates in this category yet."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((s) => (
            <TemplateCard
              key={s.id}
              starter={s}
              onUse={() => onUse(s)}
              creating={creatingId === s.id}
            />
          ))}
        </div>
      )}
    </>
  );
}

function TemplateCard({
  starter,
  onUse,
  creating,
}: {
  starter: Starter;
  onUse: () => void | Promise<void>;
  creating: boolean;
}) {
  const Icon = ICONS[starter.id] ?? FileText;
  return (
    <div className="group flex flex-col overflow-hidden rounded-xl border bg-card transition-shadow hover:shadow-lg">
      {/* Mini preview */}
      <div className="relative h-56 w-full overflow-hidden bg-muted">
        <iframe
          srcDoc={miniRender(starter.html, starter.sampleData)}
          sandbox="allow-same-origin"
          title={`${starter.name} preview`}
          className="absolute left-0 top-0 h-[1400px] w-[1000px] origin-top-left bg-white"
          style={{ transform: "scale(0.36)" }}
        />
        <div className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-border/40" />
      </div>

      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start gap-2">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{starter.name}</div>
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {starter.description}
            </p>
          </div>
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 pt-2">
          <Badge variant="secondary" className="text-[10px]">
            {starter.category}
          </Badge>
          <Button size="sm" loading={creating} onClick={() => void onUse()}>
            Use this template
          </Button>
        </div>
      </div>
    </div>
  );
}
