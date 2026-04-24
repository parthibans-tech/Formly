"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  AtSign,
  BookOpen,
  CalendarClock,
  CheckSquare,
  Clock,
  FileSignature,
  Files,
  Gauge,
  HardDrive,
  Inbox,
  KeyRound,
  Mail,
  Plug,
  Settings,
  Share2,
  ShieldCheck,
  Star,
  Trash2,
  UserCog,
  Users,
  Webhook,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getUser } from "@/lib/api";

type Role = "admin" | "editor" | "viewer";

type Item = {
  href: string;
  label: string;
  icon: any;
  external?: boolean;
  // roles that can see this entry. Omitted = visible to everyone.
  // The API still enforces authorization — this is purely cosmetic
  // so users don't see links that 403 the moment they're clicked.
  roles?: Role[];
};

const WORKSPACE: Item[] = [
  { href: "/drive", label: "My Drive", icon: HardDrive },
  { href: "/drive/shared", label: "Shared with me", icon: Share2 },
  { href: "/drive/starred", label: "Starred", icon: Star },
  { href: "/drive/templates", label: "Templates", icon: Files },
  { href: "/drive/recent", label: "Recent", icon: Clock },
  { href: "/drive/trash", label: "Trash", icon: Trash2 },
];

const INBOX: Item[] = [
  { href: "/inbox/mentions", label: "Mentions", icon: AtSign },
  { href: "/inbox/reviews", label: "Reviews", icon: CheckSquare },
];

const SETTINGS: Item[] = [
  // Personal-account settings — always visible.
  { href: "/settings/account", label: "Account", icon: Settings },
  { href: "/settings/security", label: "Security", icon: ShieldCheck },

  // Org-wide governance — admin only. Editors and viewers can't change
  // these and the API rejects their writes; hiding the links keeps the
  // nav honest about what they can actually do.
  { href: "/settings/audit", label: "Audit log", icon: Activity, roles: ["admin"] },
  { href: "/settings/ops", label: "Operations", icon: Gauge, roles: ["admin"] },
  { href: "/settings/team", label: "Team", icon: Users, roles: ["admin"] },
  { href: "/settings/access-requests", label: "Access requests", icon: Share2, roles: ["admin"] },
  { href: "/settings/api-keys", label: "API keys", icon: KeyRound, roles: ["admin"] },
  { href: "/settings/webhooks", label: "Webhooks", icon: Webhook, roles: ["admin"] },
  { href: "/settings/email", label: "Email", icon: Mail, roles: ["admin"] },
  { href: "/settings/admin-email", label: "Email audit (org-wide)", icon: Inbox, roles: ["admin"] },
  { href: "/settings/admin/users", label: "Users (all orgs)", icon: UserCog, roles: ["admin"] },
  { href: "/settings/schedules", label: "Schedules", icon: CalendarClock, roles: ["admin", "editor"] },
];

const RESOURCES: Item[] = [
  // Integrations write secrets into the org config — admin only.
  { href: "/integrations", label: "Integrations", icon: Plug, roles: ["admin"] },
  // API docs are reference material; everyone can read them.
  { href: "/docs/api", label: "API docs", icon: BookOpen, external: true },
];

function visibleFor(role: Role | null, items: Item[]): Item[] {
  // Default to most-restrictive ("viewer") when role is unknown — keeps
  // a half-loaded sidebar from briefly flashing admin links to a viewer.
  const r: Role = role ?? "viewer";
  return items.filter((it) => !it.roles || it.roles.includes(r));
}

export function AppSidebar({ onNavigate }: { onNavigate?: () => void }) {
  // Read role from the cached user blob. We re-read on mount so the
  // sidebar reflects role changes after the user accepts an invite or
  // an admin promotes them — getUser is a localStorage lookup, not a
  // network call, so this is cheap.
  const [role, setRole] = useState<Role | null>(null);
  useEffect(() => {
    const u = getUser();
    setRole((u?.role as Role) ?? null);
  }, []);

  const settings = visibleFor(role, SETTINGS);
  const resources = visibleFor(role, RESOURCES);

  return (
    <nav
      aria-label="Primary"
      className="flex h-full flex-col gap-1 overflow-y-auto p-3"
    >
      <Link
        href="/drive"
        onClick={onNavigate}
        className="mb-3 inline-flex items-center gap-2 px-2 text-sm font-semibold"
      >
        <span className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground">
          <FileSignature className="h-4 w-4" />
        </span>
        Drive360
      </Link>

      <Section title="Workspace" items={WORKSPACE} onNavigate={onNavigate} />
      <Section title="Inbox" items={INBOX} onNavigate={onNavigate} />
      {settings.length > 0 && (
        <Section title="Settings" items={settings} onNavigate={onNavigate} />
      )}
      {resources.length > 0 && (
        <Section title="Resources" items={resources} onNavigate={onNavigate} />
      )}

      <div className="mt-auto px-2 pt-4">
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

function Section({
  title,
  items,
  onNavigate,
}: {
  title: string;
  items: Item[];
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <div className="mb-2">
      <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <ul>
        {items.map((item) => {
          const Icon = item.icon;
          const active =
            pathname === item.href ||
            (item.href !== "/drive" && pathname.startsWith(item.href));
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                target={item.external ? "_blank" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                  active
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
