"use client";

// Super-admin console: a single page that pulls /v1/admin/dashboard and
// surfaces org / user / billing aggregates plus recent activity, so the
// operator can triage without page-hopping. Each section deep-links to
// the dedicated admin page for that domain.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CreditCard,
  ExternalLink,
  Gauge,
  History,
  Inbox,
  LayoutDashboard,
  RefreshCcw,
  Sparkles,
  TrendingUp,
  UserCog,
  Users,
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";

type Counts = {
  total: number;
  active?: number;
  frozen?: number;
  deleted?: number;
  locked?: number;
  last30d?: number;
};

type SubCounts = {
  trialing: number;
  active: number;
  pastDue: number;
  canceled: number;
  paused: number;
};

type RevPoint = { day: string; totalCents: number; count: number };

type Revenue = {
  last30dCents: number;
  last30dCount: number;
  byCurrency: Record<string, number>;
  daily: RevPoint[];
  mrr: Record<string, number>;
};

type SignupRow = {
  id: string;
  email: string;
  name?: string;
  orgId: string;
  orgName: string;
  createdAt: string;
};

type InvoiceRow = {
  id: string;
  number: string;
  status: string;
  provider: string;
  currency: string;
  totalCents: number;
  orgId: string;
  orgName: string;
  issuedAt: string;
  paidAt?: string | null;
  hostedUrl?: string | null;
};

type AuditRow = {
  id: string;
  action: string;
  actorEmail?: string | null;
  orgId?: string | null;
  orgName?: string | null;
  createdAt: string;
};

type Dashboard = {
  orgs: Counts;
  users: Counts;
  subscriptions: SubCounts;
  revenue: Revenue;
  recentSignups: SignupRow[];
  recentInvoices: InvoiceRow[];
  failedInvoices: InvoiceRow[];
  recentAudit: AuditRow[];
};

const CURRENCY_SYMBOL: Record<string, string> = { INR: "₹", USD: "$" };

function formatMoney(cents: number, currency: string) {
  const major = cents / 100;
  const sym = CURRENCY_SYMBOL[currency] || `${currency} `;
  return `${sym}${major.toLocaleString(undefined, {
    minimumFractionDigits: major % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function relTime(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function AdminDashboardPage() {
  const toast = useToast();
  const [data, setData] = useState<Dashboard | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const d = await api<Dashboard>("/v1/admin/dashboard");
      setData(d);
    } catch (e: any) {
      toast.show("error", "Couldn't load dashboard", {
        description: e?.message,
      });
    } finally {
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <LayoutDashboard className="h-6 w-6" />
            Dashboard
          </h1>
          <p className="text-sm text-muted-foreground">
            Single pane of glass across orgs, users, billing, and audit.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          onClick={load}
          disabled={refreshing}
        >
          <RefreshCcw className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      {/* KPI cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          icon={<Building2 className="h-4 w-4" />}
          label="Organizations"
          value={data?.orgs.total}
          sub={
            data
              ? `${data.orgs.active ?? 0} active · ${data.orgs.frozen ?? 0} frozen · ${data.orgs.last30d ?? 0} new (30d)`
              : undefined
          }
          href="/admin/orgs"
        />
        <KpiCard
          icon={<Users className="h-4 w-4" />}
          label="Users"
          value={data?.users.total}
          sub={
            data
              ? `${data.users.locked ?? 0} locked · ${data.users.last30d ?? 0} new (30d)`
              : undefined
          }
          href="/admin/users"
        />
        <KpiCard
          icon={<CreditCard className="h-4 w-4" />}
          label="Active subscriptions"
          value={
            data
              ? data.subscriptions.active +
                data.subscriptions.trialing +
                data.subscriptions.pastDue
              : undefined
          }
          sub={
            data
              ? `${data.subscriptions.trialing} trial · ${data.subscriptions.active} paid · ${data.subscriptions.pastDue} past-due`
              : undefined
          }
        />
        <KpiCard
          icon={<TrendingUp className="h-4 w-4" />}
          label="Revenue (30 days)"
          value={
            data
              ? Object.entries(data.revenue.byCurrency)
                  .map(([c, n]) => formatMoney(n, c))
                  .join(" + ") || "—"
              : undefined
          }
          sub={
            data
              ? `${data.revenue.last30dCount} paid invoices`
              : undefined
          }
        />
      </div>

      {/* MRR + Past-due alert */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Gauge className="h-4 w-4" />
              Monthly recurring revenue
            </CardTitle>
            <CardDescription>
              Yearly plans rebased to monthly (÷ 12). Active, trialing, and
              past-due subs are summed; canceled are excluded.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!data ? (
              <Skeleton className="h-12 w-full" />
            ) : Object.keys(data.revenue.mrr).length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No paying subscriptions yet.
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {Object.entries(data.revenue.mrr).map(([cur, cents]) => (
                  <div
                    key={cur}
                    className="rounded-md border bg-card p-3"
                  >
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      MRR · {cur}
                    </div>
                    <div className="text-2xl font-semibold">
                      {formatMoney(cents, cur)}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {data && data.revenue.daily.length > 0 && (
              <div className="rounded-md border bg-card p-3">
                <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                  Last 7 days · paid invoices
                </div>
                <Sparkline points={data.revenue.daily} />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              Needs attention
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <AttentionRow
              label="Past-due subscriptions"
              count={data?.subscriptions.pastDue ?? 0}
              tone={data?.subscriptions.pastDue ? "warn" : "ok"}
            />
            <AttentionRow
              label="Open / uncollectible invoices"
              count={data?.failedInvoices.length ?? 0}
              tone={data?.failedInvoices.length ? "warn" : "ok"}
            />
            <AttentionRow
              label="Frozen workspaces"
              count={data?.orgs.frozen ?? 0}
              tone={data?.orgs.frozen ? "warn" : "ok"}
            />
            <AttentionRow
              label="Locked users"
              count={data?.users.locked ?? 0}
              tone={data?.users.locked ? "warn" : "ok"}
            />
          </CardContent>
        </Card>
      </div>

      {/* Two-column activity rows */}
      <div className="grid gap-3 lg:grid-cols-2">
        <PanelCard
          icon={<Sparkles className="h-4 w-4" />}
          title="Recent signups"
          href="/admin/users"
        >
          {!data ? (
            <Skeleton className="h-32 w-full" />
          ) : data.recentSignups.length === 0 ? (
            <Empty icon={<Inbox className="h-6 w-6" />} text="No signups yet." />
          ) : (
            <ul className="divide-y text-sm">
              {data.recentSignups.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-3 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">
                      {s.name || s.email}
                    </div>
                    {s.name && (
                      <div className="truncate text-xs text-muted-foreground">
                        {s.email}
                      </div>
                    )}
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <div className="truncate">{s.orgName}</div>
                    <div>{relTime(s.createdAt)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </PanelCard>

        <PanelCard
          icon={<CreditCard className="h-4 w-4" />}
          title="Recent paid invoices"
        >
          {!data ? (
            <Skeleton className="h-32 w-full" />
          ) : data.recentInvoices.length === 0 ? (
            <Empty
              icon={<Inbox className="h-6 w-6" />}
              text="No paid invoices yet."
            />
          ) : (
            <ul className="divide-y text-sm">
              {data.recentInvoices.map((iv) => (
                <li
                  key={iv.id}
                  className="flex items-center gap-3 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">
                        {iv.orgName || "—"}
                      </span>
                      <Badge variant="outline" className="text-[10px]">
                        {iv.provider}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {iv.number} · {relTime(iv.issuedAt)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-medium">
                      {formatMoney(iv.totalCents, iv.currency)}
                    </div>
                    {iv.hostedUrl && (
                      <a
                        href={iv.hostedUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" />
                        View
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </PanelCard>

        <PanelCard
          icon={<AlertTriangle className="h-4 w-4 text-amber-600" />}
          title="Open / failed invoices"
        >
          {!data ? (
            <Skeleton className="h-32 w-full" />
          ) : data.failedInvoices.length === 0 ? (
            <Empty
              icon={<Inbox className="h-6 w-6" />}
              text="No problem invoices."
            />
          ) : (
            <ul className="divide-y text-sm">
              {data.failedInvoices.map((iv) => (
                <li
                  key={iv.id}
                  className="flex items-center gap-3 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">
                        {iv.orgName || "—"}
                      </span>
                      <Badge
                        variant="outline"
                        className="border-amber-500/40 text-amber-700 text-[10px]"
                      >
                        {iv.status}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {iv.number} · {relTime(iv.issuedAt)}
                    </div>
                  </div>
                  <div className="text-right text-sm font-medium">
                    {formatMoney(iv.totalCents, iv.currency)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </PanelCard>

        <PanelCard
          icon={<History className="h-4 w-4" />}
          title="Recent audit events"
          href="/admin/audit"
        >
          {!data ? (
            <Skeleton className="h-32 w-full" />
          ) : data.recentAudit.length === 0 ? (
            <Empty
              icon={<Inbox className="h-6 w-6" />}
              text="No audit events yet."
            />
          ) : (
            <ul className="divide-y text-sm">
              {data.recentAudit.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center gap-3 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs">
                      {a.action}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {a.actorEmail || "system"}
                      {a.orgName ? ` · ${a.orgName}` : ""}
                    </div>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    {relTime(a.createdAt)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </PanelCard>
      </div>

      <Separator />

      {/* Quick links */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Jump to</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2 md:grid-cols-4">
          <QuickLink
            href="/admin/orgs"
            icon={<Building2 className="h-4 w-4" />}
            label="Organizations"
          />
          <QuickLink
            href="/admin/users"
            icon={<UserCog className="h-4 w-4" />}
            label="Users (all orgs)"
          />
          <QuickLink
            href="/admin/audit"
            icon={<History className="h-4 w-4" />}
            label="Platform audit"
          />
          <QuickLink
            href="/settings/admin-email"
            icon={<Inbox className="h-4 w-4" />}
            label="Email audit"
          />
          <QuickLink
            href="/admin/observability"
            icon={<Gauge className="h-4 w-4" />}
            label="Observability (Prometheus)"
          />
        </CardContent>
      </Card>
    </>
  );
}

function KpiCard({
  icon,
  label,
  value,
  sub,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  value?: number | string;
  sub?: string;
  href?: string;
}) {
  const body = (
    <Card className={href ? "transition hover:border-primary/40" : undefined}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className="mt-1 text-2xl font-semibold">
          {value === undefined ? <Skeleton className="h-7 w-20" /> : value}
        </div>
        {sub && (
          <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
        )}
      </CardContent>
    </Card>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

function PanelCard({
  icon,
  title,
  href,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  href?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          {icon}
          {title}
        </CardTitle>
        {href && (
          <Link
            href={href}
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            See all
            <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </CardHeader>
      <CardContent className="p-0">{children}</CardContent>
    </Card>
  );
}

function AttentionRow({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "ok" | "warn";
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <Badge
        variant="outline"
        className={
          tone === "warn"
            ? "border-amber-500/40 text-amber-700"
            : "text-muted-foreground"
        }
      >
        {count}
      </Badge>
    </div>
  );
}

function Empty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="grid place-items-center gap-2 p-8 text-center text-sm text-muted-foreground">
      {icon}
      {text}
    </div>
  );
}

function QuickLink({
  href,
  icon,
  label,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2 rounded-md border bg-card p-3 text-sm transition hover:border-primary/40"
    >
      {icon}
      <span className="flex-1">{label}</span>
      <ArrowRight className="h-3 w-3 text-muted-foreground" />
    </Link>
  );
}

// Tiny SVG sparkline. Each point gets a vertical bar scaled to the
// largest total in the window — keeps the dashboard self-contained
// without pulling in a chart library.
function Sparkline({ points }: { points: RevPoint[] }) {
  if (points.length === 0) return null;
  const max = Math.max(...points.map((p) => p.totalCents), 1);
  const w = 320;
  const h = 48;
  const step = w / Math.max(points.length - 1, 1);
  return (
    <div className="overflow-hidden">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="block h-12 w-full"
        preserveAspectRatio="none"
      >
        {points.map((p, i) => {
          const barH = (p.totalCents / max) * (h - 4);
          const x = i * step;
          return (
            <rect
              key={p.day}
              x={x}
              y={h - barH}
              width={Math.max(step - 4, 4)}
              height={barH}
              rx={2}
              className="fill-primary/70"
            >
              <title>
                {p.day} — {p.count} invoices
              </title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}
