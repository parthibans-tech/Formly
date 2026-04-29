"use client";

// Breadcrumbs — a thin renderer plus a path-derived auto-builder.
//
// Most pages don't need custom labels: the URL is the breadcrumb.
// `autoCrumbs(pathname)` turns "/settings/admin/users" into a
// [Settings, Admin, Users] trail using the SEGMENT_LABELS table for
// well-known segments and humanizing the rest. Pages that need
// dynamic data (e.g. /drive nests folders fetched from the API) pass
// a `breadcrumbs` prop to AppShell to override the auto behavior.

import Link from "next/link";
import { ChevronRight, Home } from "lucide-react";

export type Crumb = {
  label: string;
  // Omit href on the last/current crumb so it renders as plain text.
  href?: string;
};

// Map of literal URL segments to their display label. Anything not in
// this table falls back to titleCase(segment).
const SEGMENT_LABELS: Record<string, string> = {
  drive: "My Drive",
  trash: "Trash",
  recent: "Recent",
  shared: "Shared with me",
  starred: "Starred",
  templates: "Templates",
  "smart-search": "Smart search",
  dashboard: "Dashboard",
  settings: "Settings",
  account: "Account",
  team: "Team",
  security: "Security",
  billing: "Billing",
  webhooks: "Webhooks",
  "api-keys": "API keys",
  schedules: "Schedules",
  "access-requests": "Access requests",
  email: "Email",
  audit: "Audit log",
  ops: "Operations",
  "upload-policy": "Upload policy",
  "ocr-profiles": "OCR profiles",
  "admin-email": "Admin email",
  admin: "Admin",
  orgs: "Organizations",
  users: "Users",
  "product-config": "Product config",
  integrations: "Integrations",
  inbox: "Inbox",
  mentions: "Mentions",
  reviews: "Reviews",
  "merge-recipes": "Merge recipes",
  integrate: "Integrate",
  designer: "Designer",
  "designer-v2": "Designer",
  playground: "Playground",
  api: "API reference",
  versions: "Versions",
  docs: "Docs",
  editor: "Editor",
  code: "Code",
};

function titleCase(s: string) {
  return s
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Heuristic for "this segment is an opaque id, don't include it as a
// labeled crumb". UUIDs and 20+ char URL-safe blobs both qualify.
function looksLikeId(s: string) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return true;
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return true;
  return false;
}

export function autoCrumbs(pathname: string): Crumb[] {
  const parts = pathname.split("/").filter(Boolean);
  const out: Crumb[] = [];
  let acc = "";
  for (const p of parts) {
    acc += "/" + p;
    if (looksLikeId(p)) continue;
    out.push({
      label: SEGMENT_LABELS[p] || titleCase(p),
      href: acc,
    });
  }
  // The last visible crumb is the current page — render as plain text.
  if (out.length > 0) out[out.length - 1].href = undefined;
  return out;
}

export function Breadcrumbs({
  items,
  className = "",
}: {
  items: Crumb[];
  className?: string;
}) {
  if (!items || items.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className={`mb-3 ${className}`}>
      <ol className="flex flex-wrap items-center gap-0.5 text-xs">
        <li>
          <Link
            href="/drive"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Home className="h-3 w-3" />
            <span className="sr-only">Home</span>
          </Link>
        </li>
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${c.label}-${i}`} className="flex items-center gap-0.5">
              <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
              {c.href && !last ? (
                <Link
                  href={c.href}
                  className="rounded px-1.5 py-0.5 font-medium text-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
                >
                  {c.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? "page" : undefined}
                  className="rounded px-1.5 py-0.5 font-medium text-foreground"
                >
                  {c.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
