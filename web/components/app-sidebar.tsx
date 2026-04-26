"use client";

// Sidebar: search across all visible items, pin/unpin frequent ones,
// collapse sections you never use. Pins and collapse state live in
// localStorage so the layout sticks across sessions per browser. Items
// are still source-of-truth here; pins just promote them to the top.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AtSign,
  BookOpen,
  Building2,
  CalendarClock,
  ChevronDown,
  CheckSquare,
  Clock,
  CreditCard,
  FileSignature,
  Files,
  Gauge,
  HardDrive,
  KeyRound,
  Layers,
  LayoutDashboard,
  Lock,
  Mail,
  Pin,
  PinOff,
  Plug,
  ScanText,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  UserCog,
  Users,
  Webhook,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getUser } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { useAIConfig, type AIFeatureFlags } from "@/hooks/use-ai-config";

type Role = "admin" | "editor" | "viewer";

type Item = {
  href: string;
  label: string;
  icon: any;
  external?: boolean;
  // roles that can see this entry. Omitted = visible to everyone.
  // The API still enforces authorization — this is purely cosmetic so
  // users don't see links that 403 the moment they're clicked.
  roles?: Role[];
  // superAdmin: when true, only platform operators (admin of the
  // PLATFORM_ROOT_ORG_ID workspace) see this. Org admins of other
  // workspaces won't, even though their role is still "admin".
  superAdmin?: boolean;
  // Hint shown under the label in search results so users can tell apart
  // similarly-named items (e.g. "Audit log" vs "Platform audit").
  hint?: string;
  // aiFeature: when set, the entry only renders if that AI feature flag
  // is on. Mirrors the `<AIFeature>` component's gate on the page side
  // so the sidebar and the actual route are consistent — no dead links.
  aiFeature?: keyof AIFeatureFlags;
};

type Section = {
  id: string;
  title: string;
  items: Item[];
  // Super-admins manage the platform, not day-to-day org content. Sections
  // marked here disappear from their sidebar to avoid duplication with the
  // Platform section (e.g. their org's audit log vs the cross-org one).
  hideForSuperAdmin?: boolean;
  // Sections that should only render for super-admin (the Platform section).
  superAdminOnly?: boolean;
};

// Sections are ordered by daily usage frequency: workspace (constant
// access) → inbox (notifications) → admin (occasional) → developer →
// billing → account → platform (super-admin) → resources.
const SECTIONS: Section[] = [
  {
    id: "workspace",
    title: "Workspace",
    hideForSuperAdmin: true,
    items: [
      { href: "/drive", label: "My Drive", icon: HardDrive },
      { href: "/drive/shared", label: "Shared with me", icon: Share2 },
      { href: "/drive/starred", label: "Starred", icon: Star },
      {
        href: "/drive/smart-search",
        label: "Smart search",
        icon: Sparkles,
        aiFeature: "smartSearch",
        hint: "AI semantic search",
      },
      { href: "/drive/templates", label: "Templates", icon: Files },
      { href: "/merge-recipes", label: "Merge recipes", icon: Layers },
      { href: "/drive/recent", label: "Recent", icon: Clock },
      { href: "/drive/trash", label: "Trash", icon: Trash2 },
    ],
  },
  {
    id: "inbox",
    title: "Inbox",
    hideForSuperAdmin: true,
    items: [
      { href: "/inbox/mentions", label: "Mentions", icon: AtSign },
      { href: "/inbox/reviews", label: "Reviews", icon: CheckSquare },
    ],
  },
  {
    id: "admin",
    title: "Admin",
    hideForSuperAdmin: true,
    items: [
      {
        href: "/dashboard",
        label: "Dashboard",
        icon: LayoutDashboard,
        roles: ["admin"],
        hint: "Org overview",
      },
      { href: "/settings/team", label: "Team", icon: Users, roles: ["admin"] },
      {
        href: "/settings/access-requests",
        label: "Access requests",
        icon: Share2,
        roles: ["admin"],
      },
      {
        href: "/settings/schedules",
        label: "Schedules",
        icon: CalendarClock,
        roles: ["admin", "editor"],
      },
      {
        href: "/settings/email",
        label: "Email",
        icon: Mail,
        roles: ["admin"],
        hint: "Sender + templates",
      },
      {
        href: "/settings/audit",
        label: "Audit",
        icon: ShieldCheck,
        roles: ["admin"],
        hint: "Activity & email",
      },
      {
        href: "/settings/upload-policy",
        label: "Upload policy",
        icon: Lock,
        roles: ["admin"],
        hint: "File security",
      },
      {
        href: "/settings/ocr-profiles",
        label: "OCR profiles",
        icon: ScanText,
        roles: ["admin"],
        hint: "Document-type presets",
      },
      {
        href: "/settings/ops",
        label: "Operations",
        icon: Gauge,
        roles: ["admin"],
      },
    ],
  },
  {
    id: "developer",
    title: "Developer",
    hideForSuperAdmin: true,
    items: [
      {
        href: "/settings/api-keys",
        label: "API keys",
        icon: KeyRound,
        roles: ["admin"],
      },
      {
        href: "/settings/webhooks",
        label: "Webhooks",
        icon: Webhook,
        roles: ["admin"],
      },
      {
        href: "/integrations",
        label: "Integrations",
        icon: Plug,
        roles: ["admin"],
      },
    ],
  },
  {
    id: "billing",
    title: "Billing",
    hideForSuperAdmin: true,
    items: [
      {
        href: "/settings/billing",
        label: "Plan & invoices",
        icon: CreditCard,
        roles: ["admin"],
      },
    ],
  },
  {
    id: "account",
    title: "Account",
    items: [
      { href: "/settings/account", label: "Profile", icon: Settings },
      { href: "/settings/security", label: "Security", icon: ShieldCheck },
    ],
  },
  {
    id: "platform",
    title: "Platform",
    superAdminOnly: true,
    // Items here run cross-org and are gated by requireSuperAdmin on the
    // server (admin of PLATFORM_ROOT_ORG_ID). We mirror that gate on the
    // client via superAdmin: true so org admins of regular workspaces
    // don't see links the API would 403 anyway.
    items: [
      {
        href: "/settings/admin",
        label: "Dashboard",
        icon: LayoutDashboard,
        superAdmin: true,
        hint: "Platform overview",
      },
      {
        href: "/settings/admin/orgs",
        label: "Organizations",
        icon: Building2,
        superAdmin: true,
      },
      {
        href: "/settings/admin/users",
        label: "Users (all orgs)",
        icon: UserCog,
        superAdmin: true,
      },
      {
        href: "/settings/admin/billing",
        label: "Billing & plans",
        icon: CreditCard,
        superAdmin: true,
        hint: "Plan catalog",
      },
      {
        href: "/settings/admin/product-config",
        label: "Product config",
        icon: Lock,
        superAdmin: true,
        hint: "Upload defaults",
      },
      {
        href: "/settings/ocr-profiles",
        label: "OCR profiles",
        icon: ScanText,
        superAdmin: true,
        hint: "Built-in document types",
      },
      {
        href: "/settings/audit",
        label: "Audit",
        icon: ShieldCheck,
        superAdmin: true,
        hint: "Cross-org activity & email",
      },
    ],
  },
  {
    id: "resources",
    title: "Resources",
    items: [{ href: "/docs/api", label: "API docs", icon: BookOpen, external: true }],
  },
];

const PINS_KEY = "df_sidebar_pins";
const COLLAPSED_KEY = "df_sidebar_collapsed";

function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, v: unknown) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // Quota / private mode — silently no-op. The sidebar still works,
    // it just won't persist this preference.
  }
}

function visibleFor(
  role: Role | null,
  isSuperAdmin: boolean,
  items: Item[],
  aiFeatureOn: (k: keyof AIFeatureFlags) => boolean,
): Item[] {
  // Default to most-restrictive ("viewer") when role is unknown — keeps
  // a half-loaded sidebar from briefly flashing admin links to a viewer.
  const r: Role = role ?? "viewer";
  return items.filter((it) => {
    if (it.superAdmin && !isSuperAdmin) return false;
    if (it.roles && !it.roles.includes(r)) return false;
    // AI gate: hide entries whose feature flag is off so the sidebar
    // never advertises a route the page itself would 503 on.
    if (it.aiFeature && !aiFeatureOn(it.aiFeature)) return false;
    return true;
  });
}

// sectionVisible decides whether a section should render at all based on
// the user's identity. Super-admins (platform operators) get a focused
// sidebar — Platform + Account + Resources — to keep cross-org tools from
// being mixed up with their own org's day-to-day controls.
function sectionVisible(s: Section, isSuperAdmin: boolean): boolean {
  if (s.superAdminOnly && !isSuperAdmin) return false;
  if (s.hideForSuperAdmin && isSuperAdmin) return false;
  return true;
}

export function AppSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const [role, setRole] = useState<Role | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [query, setQuery] = useState("");
  const [pins, setPins] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  // One AI-config fetch per page-load (the hook is module-cached).
  // We synthesize a per-feature predicate here so visibleFor stays a
  // pure function — no hook calls inside its filter loop.
  const aiCfg = useAIConfig();
  const aiFeatureOn = useCallback(
    (k: keyof AIFeatureFlags) => aiCfg.enabled && !!aiCfg.features[k],
    [aiCfg],
  );

  // Hydrate from localStorage / user blob on mount. Both are sync reads
  // so the first paint already has the right state.
  useEffect(() => {
    const u = getUser();
    setRole((u?.role as Role) ?? null);
    setIsSuperAdmin(!!u?.isSuperAdmin);
    setPins(readJSON<string[]>(PINS_KEY, []));
    setCollapsed(readJSON<Record<string, boolean>>(COLLAPSED_KEY, {}));
  }, []);

  // Cmd/Ctrl-K focuses the sidebar search. Mirrors the muscle memory of
  // command-palette shortcuts users already have.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape" && document.activeElement === searchRef.current) {
        setQuery("");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const togglePin = (href: string) => {
    setPins((prev) => {
      const next = prev.includes(href)
        ? prev.filter((h) => h !== href)
        : [...prev, href];
      writeJSON(PINS_KEY, next);
      return next;
    });
  };

  const toggleSection = (id: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      writeJSON(COLLAPSED_KEY, next);
      return next;
    });
  };

  // Flatten + filter once per render. Search matches across label, hint,
  // and section title so "audit" finds both org and platform variants.
  const q = query.trim().toLowerCase();

  // Super-admins see Platform first — the operator console is what they
  // log in to use. Other roles keep the workspace-first ordering.
  const orderedSections = useMemo(() => {
    const base = SECTIONS.filter((s) => sectionVisible(s, isSuperAdmin));
    if (!isSuperAdmin) return base;
    return [...base].sort((a, b) => {
      if (a.id === "platform") return -1;
      if (b.id === "platform") return 1;
      return 0;
    });
  }, [isSuperAdmin]);

  const allVisible = useMemo(() => {
    return orderedSections.flatMap((s) =>
      visibleFor(role, isSuperAdmin, s.items, aiFeatureOn).map((it) => ({
        ...it,
        sectionTitle: s.title,
      })),
    );
  }, [orderedSections, role, isSuperAdmin, aiFeatureOn]);

  const pinnedItems = useMemo(() => {
    if (pins.length === 0) return [];
    const byHref = new Map(allVisible.map((it) => [it.href, it]));
    return pins.map((h) => byHref.get(h)).filter(Boolean) as (Item & {
      sectionTitle: string;
    })[];
  }, [pins, allVisible]);

  const searchHits = useMemo(() => {
    if (!q) return null;
    return allVisible.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        (it.hint && it.hint.toLowerCase().includes(q)) ||
        it.sectionTitle.toLowerCase().includes(q),
    );
  }, [q, allVisible]);

  return (
    <nav
      aria-label="Primary"
      className="flex h-full flex-col overflow-hidden"
    >
      <div className="flex flex-col gap-3 p-3 pb-2">
        <Link
          href={isSuperAdmin ? "/settings/admin" : "/drive"}
          onClick={onNavigate}
          className="inline-flex items-center gap-2 px-2 text-sm font-semibold"
        >
          <span className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground">
            <FileSignature className="h-4 w-4" />
          </span>
          Drive360
        </Link>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            aria-label="Search navigation"
            className="h-8 pl-8 pr-12 text-xs"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border bg-muted px-1 text-[10px] text-muted-foreground sm:inline-block">
              ⌘K
            </kbd>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {searchHits ? (
          <SearchResults
            hits={searchHits}
            pins={pins}
            onTogglePin={togglePin}
            onNavigate={onNavigate}
          />
        ) : (
          <>
            {pinnedItems.length > 0 && (
              <SectionBlock
                id="pinned"
                title="Pinned"
                items={pinnedItems}
                pins={pins}
                onTogglePin={togglePin}
                collapsed={!!collapsed["pinned"]}
                onToggleCollapse={() => toggleSection("pinned")}
                onNavigate={onNavigate}
                pinnable={false}
              />
            )}

            {orderedSections.map((s) => {
              const items = visibleFor(role, isSuperAdmin, s.items, aiFeatureOn);
              if (items.length === 0) return null;
              return (
                <SectionBlock
                  key={s.id}
                  id={s.id}
                  title={s.title}
                  items={items}
                  pins={pins}
                  onTogglePin={togglePin}
                  collapsed={!!collapsed[s.id]}
                  onToggleCollapse={() => toggleSection(s.id)}
                  onNavigate={onNavigate}
                />
              );
            })}
          </>
        )}
      </div>

      <div className="border-t bg-muted/30 px-3 py-3">
        <div className="rounded-md border bg-card p-3">
          <div className="flex items-center gap-2 text-xs font-semibold">
            <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
            Storage
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Files &amp; generated PDFs are stored in your workspace bucket.
          </p>
        </div>
      </div>
    </nav>
  );
}

function SectionBlock({
  id,
  title,
  items,
  pins,
  onTogglePin,
  collapsed,
  onToggleCollapse,
  onNavigate,
  pinnable = true,
}: {
  id: string;
  title: string;
  items: Item[];
  pins: string[];
  onTogglePin: (href: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onNavigate?: () => void;
  pinnable?: boolean;
}) {
  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={onToggleCollapse}
        aria-expanded={!collapsed}
        aria-controls={`section-${id}`}
        className="group flex w-full items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        <ChevronDown
          className={cn(
            "h-3 w-3 transition-transform",
            collapsed && "-rotate-90",
          )}
        />
        {title}
        <span className="ml-auto text-[10px] font-normal text-muted-foreground/60">
          {items.length}
        </span>
      </button>
      {!collapsed && (
        <ul id={`section-${id}`}>
          {items.map((item) => (
            <NavRow
              key={item.href}
              item={item}
              pinned={pins.includes(item.href)}
              onTogglePin={onTogglePin}
              onNavigate={onNavigate}
              pinnable={pinnable}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SearchResults({
  hits,
  pins,
  onTogglePin,
  onNavigate,
}: {
  hits: (Item & { sectionTitle: string })[];
  pins: string[];
  onTogglePin: (href: string) => void;
  onNavigate?: () => void;
}) {
  if (hits.length === 0) {
    return (
      <div className="mt-4 rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
        No matches.
      </div>
    );
  }
  return (
    <ul className="mt-1">
      {hits.map((item) => (
        <NavRow
          key={item.href}
          item={item}
          pinned={pins.includes(item.href)}
          onTogglePin={onTogglePin}
          onNavigate={onNavigate}
          subtitle={item.sectionTitle}
        />
      ))}
    </ul>
  );
}

function NavRow({
  item,
  pinned,
  onTogglePin,
  onNavigate,
  subtitle,
  pinnable = true,
}: {
  item: Item;
  pinned: boolean;
  onTogglePin: (href: string) => void;
  onNavigate?: () => void;
  subtitle?: string;
  pinnable?: boolean;
}) {
  const pathname = usePathname();
  const Icon = item.icon;
  const active =
    pathname === item.href ||
    (item.href !== "/drive" && pathname.startsWith(item.href));

  return (
    <li className="group/row relative">
      <Link
        href={item.href}
        onClick={onNavigate}
        target={item.external ? "_blank" : undefined}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
          active
            ? "bg-primary/10 text-primary font-medium"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {item.label}
          {(subtitle || item.hint) && (
            <span className="ml-1 text-[10px] font-normal text-muted-foreground">
              · {subtitle || item.hint}
            </span>
          )}
        </span>
      </Link>
      {pinnable && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onTogglePin(item.href);
          }}
          aria-label={pinned ? `Unpin ${item.label}` : `Pin ${item.label}`}
          aria-pressed={pinned}
          className={cn(
            "absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 transition",
            pinned
              ? "text-primary opacity-100"
              : "text-muted-foreground opacity-0 hover:bg-accent group-hover/row:opacity-100 focus:opacity-100",
          )}
        >
          {pinned ? (
            <PinOff className="h-3 w-3" />
          ) : (
            <Pin className="h-3 w-3" />
          )}
        </button>
      )}
    </li>
  );
}
