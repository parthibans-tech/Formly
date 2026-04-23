"use client";

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
  HardDrive,
  Inbox,
  KeyRound,
  Mail,
  Plug,
  Settings,
  ShieldCheck,
  Trash2,
  Users,
  Webhook,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Item = {
  href: string;
  label: string;
  icon: any;
  external?: boolean;
};

const WORKSPACE: Item[] = [
  { href: "/drive", label: "My Drive", icon: HardDrive },
  { href: "/drive/templates", label: "Templates", icon: Files },
  { href: "/drive/recent", label: "Recent", icon: Clock },
  { href: "/drive/trash", label: "Trash", icon: Trash2 },
];

const INBOX: Item[] = [
  { href: "/inbox/mentions", label: "Mentions", icon: AtSign },
  { href: "/inbox/reviews", label: "Reviews", icon: CheckSquare },
];

const SETTINGS: Item[] = [
  { href: "/settings/account", label: "Account", icon: Settings },
  { href: "/settings/security", label: "Security", icon: ShieldCheck },
  { href: "/settings/audit", label: "Audit log", icon: Activity },
  { href: "/settings/team", label: "Team", icon: Users },
  { href: "/settings/api-keys", label: "API keys", icon: KeyRound },
  { href: "/settings/webhooks", label: "Webhooks", icon: Webhook },
  { href: "/settings/email", label: "Email", icon: Mail },
  { href: "/settings/schedules", label: "Schedules", icon: CalendarClock },
];

const RESOURCES: Item[] = [
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/docs/api", label: "API docs", icon: BookOpen, external: true },
];

export function AppSidebar({ onNavigate }: { onNavigate?: () => void }) {
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
        Formly
      </Link>

      <Section title="Workspace" items={WORKSPACE} onNavigate={onNavigate} />
      <Section title="Inbox" items={INBOX} onNavigate={onNavigate} />
      <Section title="Settings" items={SETTINGS} onNavigate={onNavigate} />
      <Section title="Resources" items={RESOURCES} onNavigate={onNavigate} />

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
