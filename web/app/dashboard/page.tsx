"use client";

// Org-admin landing page. Mirrors the super-admin operator console but
// scoped to the caller's org: members, files, jobs, quotas, subscription,
// recent invoices/members/audit. Backed by GET /v1/dashboard/admin which
// rejects non-admin callers — non-admins are redirected to /drive on
// login, so this page never renders for them.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Files,
  Gauge,
  HardDrive,
  History,
  Inbox,
  KeyRound,
  LayoutDashboard,
  Mail,
  RefreshCcw,
  Sparkles,
  UserPlus,
  Users,
  Webhook,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { api, getUser } from "@/lib/api";
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
import { Progress } from "@/components/ui/progress";

type MemberCounts = {
  total: number;
  active: number;
  locked: number;
  pending: number;
  last30d: number;
};

type FileCounts = {
  total: number;
  active: number;
  trashed: number;
  bytesUsed: number;
  last30d: number;
};

type JobCounts = {
  completed24h: number;
  failed24h: number;
  running: number;
  queued: number;
};

type Quota = {
  maxUsers?: number | null;
  maxStorageBytes?: number | null;
  usersUsed: number;
  storageUsed: number;
};

type Sub = {
  planName: string;
  tier: string;
  status: string;
  trialEndsAt?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd: boolean;
  pastDueSince?: string | null;
  currency: string;
  amountCents?: number | null;
  interval: string;
};

type InvoiceRow = {
  id: string;
  number: string;
  status: string;
  currency: string;
  totalCents: number;
  issuedAt: string;
  hostedUrl?: string | null;
};

type MemberRow = {
  id: string;
  email: string;
  name?: string;
  role: string;
  createdAt: string;
};

type AuditRow = {
  id: string;
  action: string;
  actorEmail?: string | null;
  createdAt: string;
};

type Dashboard = {
  members: MemberCounts;
  files: FileCounts;
  templatesTotal: number;
  jobs: JobCounts;
  quota: Quota;
  subscription: Sub | null;
  recentInvoices: InvoiceRow[];
  recentMembers: MemberRow[];
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

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
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

function statusTone(status: string): "ok" | "warn" | "muted" {
  if (status === "active" || status === "trialing") return "ok";
  if (status === "past_due" || status === "paused") return "warn";
  return "muted";
}

export default function OrgDashboardPage() {
  const router = useRouter();
  const toast = useToast();
  const [data, setData] = useState<Dashboard | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Belt-and-braces: the API gate is authoritative, but a non-admin who
  // pastes the URL would otherwise see an error toast on every load. We
  // redirect them to /drive instead.
  useEffect(() => {
    const u = getUser();
    if (u && u.role !== "admin") router.replace("/drive");
  }, [router]);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const d = await api<Dashboard>("/v1/dashboard/admin");
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

  const userPct =
    data?.quota.maxUsers && data.quota.maxUsers > 0
      ? Math.min(100, (data.quota.usersUsed / data.quota.maxUsers) * 100)
      : null;
  const storagePct =
    data?.quota.maxStorageBytes && data.quota.maxStorageBytes > 0
      ? Math.min(
          100,
          (data.quota.storageUsed / data.quota.maxStorageBytes) * 100,
        )
      : null;

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <LayoutDashboard className="h-6 w-6" />
              Dashboard
            </h1>
            <p className="text-sm text-muted-foreground">
              Workspace health, billing, and recent activity for your org.
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

        {/* Past-due banner */}
        {data?.subscription?.status === "past_due" && (
          <div className="flex items-center gap-3 rounded-md border border-amber-500/40 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
            <div className="flex-1">
              <div className="font-medium">Payment is past due</div>
              <div className="text-xs text-muted-foreground">
                {data.subscription.pastDueSince
                  ? `Last successful charge ${relTime(data.subscription.pastDueSince)}.`
                  : "Update your payment method to keep your workspace active."}
              </div>
            </div>
            <Button asChild size="sm" variant="outline" className="h-8">
              <Link href="/settings/billing">Fix billing</Link>
            </Button>
          </div>
        )}

        {/* KPI cards */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            icon={<Users className="h-4 w-4" />}
            label="Members"
            value={data?.members.total}
            sub={
              data
                ? `${data.members.active} active · ${data.members.pending} pending · ${data.members.last30d} new (30d)`
                : undefined
            }
            href="/settings/team"
          />
          <KpiCard
            icon={<Files className="h-4 w-4" />}
            label="Files"
            value={data?.files.active}
            sub={
              data
                ? `${formatBytes(data.files.bytesUsed)} used · ${data.files.last30d} new (30d)`
                : undefined
            }
            href="/drive"
          />
          <KpiCard
            icon={<Activity className="h-4 w-4" />}
            label="Generations (24h)"
            value={data ? data.jobs.completed24h : undefined}
            sub={
              data
                ? `${data.jobs.failed24h} failed · ${data.jobs.running} running · ${data.jobs.queued} queued`
                : undefined
            }
            href="/settings/ops"
          />
          <KpiCard
            icon={<CreditCard className="h-4 w-4" />}
            label="Plan"
            value={data?.subscription?.planName || (data ? "—" : undefined)}
            sub={
              data?.subscription
                ? `${data.subscription.status}${data.subscription.amountCents ? ` · ${formatMoney(data.subscription.amountCents, data.subscription.currency)}/${data.subscription.interval}` : ""}`
                : data
                  ? "No active subscription"
                  : undefined
            }
            href="/settings/billing"
          />
        </div>

        {/* Quota + Subscription */}
        <div className="grid gap-3 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Gauge className="h-4 w-4" />
                Quota usage
              </CardTitle>
              <CardDescription>
                Per-org limits inherited from your plan. Approaching the cap
                blocks new uploads and invites.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <QuotaBar
                label="Users"
                used={data?.quota.usersUsed ?? 0}
                max={data?.quota.maxUsers ?? null}
                pct={userPct}
                format={(n) => `${n}`}
                loading={!data}
              />
              <QuotaBar
                label="Storage"
                used={data?.quota.storageUsed ?? 0}
                max={data?.quota.maxStorageBytes ?? null}
                pct={storagePct}
                format={formatBytes}
                loading={!data}
              />
              {data && (
                <div className="grid gap-2 text-xs sm:grid-cols-2">
                  <ChipRow
                    label="Templates"
                    value={data.templatesTotal.toString()}
                  />
                  <ChipRow
                    label="Trashed files"
                    value={data.files.trashed.toString()}
                  />
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <CreditCard className="h-4 w-4" />
                Subscription
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {!data ? (
                <Skeleton className="h-24 w-full" />
              ) : !data.subscription ? (
                <div className="space-y-2">
                  <div className="text-muted-foreground">
                    No active subscription on this workspace.
                  </div>
                  <Button asChild size="sm" className="h-8">
                    <Link href="/settings/billing">Choose a plan</Link>
                  </Button>
                </div>
              ) : (
                <>
                  <DetailRow
                    label="Plan"
                    value={`${data.subscription.planName} (${data.subscription.tier})`}
                  />
                  <DetailRow
                    label="Status"
                    value={
                      <Badge
                        variant="outline"
                        className={
                          statusTone(data.subscription.status) === "warn"
                            ? "border-amber-500/40 text-amber-700"
                            : statusTone(data.subscription.status) === "ok"
                              ? "border-emerald-500/40 text-emerald-700"
                              : ""
                        }
                      >
                        {data.subscription.status}
                      </Badge>
                    }
                  />
                  {data.subscription.trialEndsAt && (
                    <DetailRow
                      label="Trial ends"
                      value={new Date(
                        data.subscription.trialEndsAt,
                      ).toLocaleDateString()}
                    />
                  )}
                  {data.subscription.currentPeriodEnd && (
                    <DetailRow
                      label="Renews"
                      value={
                        data.subscription.cancelAtPeriodEnd
                          ? `Cancels ${new Date(data.subscription.currentPeriodEnd).toLocaleDateString()}`
                          : new Date(
                              data.subscription.currentPeriodEnd,
                            ).toLocaleDateString()
                      }
                    />
                  )}
                  <Separator />
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    className="h-8 w-full"
                  >
                    <Link href="/settings/billing">Manage billing</Link>
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Activity rows */}
        <div className="grid gap-3 lg:grid-cols-2">
          <PanelCard
            icon={<Sparkles className="h-4 w-4" />}
            title="Recent members"
            href="/settings/team"
          >
            {!data ? (
              <Skeleton className="h-32 w-full" />
            ) : data.recentMembers.length === 0 ? (
              <Empty
                icon={<Inbox className="h-6 w-6" />}
                text="No members yet."
              />
            ) : (
              <ul className="divide-y text-sm">
                {data.recentMembers.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center gap-3 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {m.name || m.email}
                      </div>
                      {m.name && (
                        <div className="truncate text-xs text-muted-foreground">
                          {m.email}
                        </div>
                      )}
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <Badge variant="outline" className="text-[10px]">
                        {m.role}
                      </Badge>
                      <div>{relTime(m.createdAt)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </PanelCard>

          <PanelCard
            icon={<CreditCard className="h-4 w-4" />}
            title="Recent invoices"
            href="/settings/billing"
          >
            {!data ? (
              <Skeleton className="h-32 w-full" />
            ) : data.recentInvoices.length === 0 ? (
              <Empty
                icon={<Inbox className="h-6 w-6" />}
                text="No invoices yet."
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
                          {iv.number}
                        </span>
                        <Badge
                          variant="outline"
                          className={
                            iv.status === "paid"
                              ? "border-emerald-500/40 text-emerald-700 text-[10px]"
                              : iv.status === "open" ||
                                  iv.status === "uncollectible"
                                ? "border-amber-500/40 text-amber-700 text-[10px]"
                                : "text-[10px]"
                          }
                        >
                          {iv.status}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {relTime(iv.issuedAt)}
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
            icon={<Activity className="h-4 w-4" />}
            title="Generation jobs"
            href="/settings/ops"
          >
            {!data ? (
              <Skeleton className="h-32 w-full" />
            ) : (
              <div className="grid grid-cols-2 gap-px bg-border text-sm">
                <JobCell
                  icon={<CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}
                  label="Completed (24h)"
                  value={data.jobs.completed24h}
                />
                <JobCell
                  icon={<AlertTriangle className="h-3.5 w-3.5 text-amber-600" />}
                  label="Failed (24h)"
                  value={data.jobs.failed24h}
                  warn={data.jobs.failed24h > 0}
                />
                <JobCell
                  icon={<Activity className="h-3.5 w-3.5" />}
                  label="Running"
                  value={data.jobs.running}
                />
                <JobCell
                  icon={<CalendarClock className="h-3.5 w-3.5" />}
                  label="Queued"
                  value={data.jobs.queued}
                />
              </div>
            )}
          </PanelCard>

          <PanelCard
            icon={<History className="h-4 w-4" />}
            title="Recent audit events"
            href="/settings/audit"
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
              href="/settings/team"
              icon={<UserPlus className="h-4 w-4" />}
              label="Invite members"
            />
            <QuickLink
              href="/settings/billing"
              icon={<CreditCard className="h-4 w-4" />}
              label="Billing"
            />
            <QuickLink
              href="/settings/api-keys"
              icon={<KeyRound className="h-4 w-4" />}
              label="API keys"
            />
            <QuickLink
              href="/settings/webhooks"
              icon={<Webhook className="h-4 w-4" />}
              label="Webhooks"
            />
            <QuickLink
              href="/settings/email"
              icon={<Mail className="h-4 w-4" />}
              label="Email"
            />
            <QuickLink
              href="/settings/audit"
              icon={<History className="h-4 w-4" />}
              label="Audit log"
            />
            <QuickLink
              href="/drive/templates"
              icon={<Files className="h-4 w-4" />}
              label="Templates"
            />
            <QuickLink
              href="/drive"
              icon={<HardDrive className="h-4 w-4" />}
              label="My Drive"
            />
          </CardContent>
        </Card>
      </div>
    </AppShell>
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

function QuotaBar({
  label,
  used,
  max,
  pct,
  format,
  loading,
}: {
  label: string;
  used: number;
  max: number | null;
  pct: number | null;
  format: (n: number) => string;
  loading: boolean;
}) {
  if (loading) return <Skeleton className="h-10 w-full" />;
  const unlimited = !max;
  const warn = pct !== null && pct >= 80;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={warn ? "font-medium text-amber-700" : ""}>
          {format(used)} {unlimited ? "" : `/ ${format(max!)}`}
          {unlimited && (
            <span className="ml-1 text-muted-foreground">(unlimited)</span>
          )}
        </span>
      </div>
      {!unlimited && (
        <Progress value={pct ?? 0} className={warn ? "[&>div]:bg-amber-500" : ""} />
      )}
    </div>
  );
}

function ChipRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-md border bg-card px-3 py-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  );
}

function JobCell({
  icon,
  label,
  value,
  warn,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  warn?: boolean;
}) {
  return (
    <div className="bg-card p-3">
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <div
        className={`mt-1 text-xl font-semibold ${warn ? "text-amber-700" : ""}`}
      >
        {value}
      </div>
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
