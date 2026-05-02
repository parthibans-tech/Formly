// Per-organization analytics dashboard — a full-page operator view scoped
// to one workspace.
//
// This sits next to the cross-org dashboard at /admin/orgs/analytics.
// Where that page answers "how is the platform doing?", this one answers
// "how is org X doing?" — useful when triaging a support ticket, evaluating
// an enterprise renewal, or hunting a specific abuser.
//
// Data comes from GET /v1/admin/orgs/{id}/analytics?window=… and is
// rendered with the same inline-SVG primitives the rest of the admin
// console uses.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Building2,
  RefreshCcw,
  Snowflake,
  Trash2,
} from "lucide-react";
import {
  BarChart,
  Donut,
  HourHeatmap,
  KpiTile,
  LineChart,
  TopList,
  formatBytes,
  formatCount,
  type LabelValue,
  type TimePoint,
} from "@/components/admin-charts";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";

type Quota = {
  userCount: number;
  maxUsers: number | null;
  storageBytes: number;
  maxStorageBytes: number | null;
  usersPercent: number | null;
  storagePercent: number | null;
};

type OrgAnalytics = {
  window: string;
  bucket: string;
  memberGrowth: TimePoint[];
  storageGrowth: TimePoint[];
  activity: TimePoint[];
  dauSeries: TimePoint[];
  hourlyPattern: number[];
  roleDistribution: LabelValue[];
  actionBreakdown: LabelValue[];
  topContributors: Array<{ actor: string; value: number }>;
  topFiles: Array<{ id: string; name: string; size: number }>;
  failedLogins30d: number;
  quota: Quota;
};

// Lightweight org header — name, plan, status badges. Pulled separately
// from /v1/admin/orgs/{id} so the dashboard doesn't depend on the parent
// list page being loaded.
type OrgHeader = {
  id: string;
  name: string;
  plan: string;
  userCount: number;
  storageBytes: number;
  frozenAt?: string | null;
  deletedAt?: string | null;
};

export default function OrgAnalyticsPage() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id;
  const toast = useToast();

  const [windowParam, setWindowParam] = useState("30d");
  const [data, setData] = useState<OrgAnalytics | null>(null);
  const [header, setHeader] = useState<OrgHeader | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    setRefreshing(true);
    try {
      const [a, h] = await Promise.all([
        api<OrgAnalytics>(
          `/v1/admin/orgs/${orgId}/analytics?window=${windowParam}`
        ),
        api<OrgHeader>(`/v1/admin/orgs/${orgId}`),
      ]);
      setData(a);
      setHeader(h);
    } catch (e: any) {
      toast.show("error", "Couldn't load org analytics", {
        description: e?.message,
      });
    } finally {
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, windowParam]);

  useEffect(() => {
    load();
  }, [load]);

  if (!orgId) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button asChild size="icon" variant="ghost" className="shrink-0">
            <Link href="/admin/orgs" aria-label="Back to organizations">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Building2 className="h-5 w-5 text-muted-foreground" />
              <h1 className="truncate text-2xl font-semibold tracking-tight">
                {header?.name || "Organization"}
              </h1>
              {header?.plan && (
                <Badge variant="outline" className="text-[10px] uppercase">
                  {header.plan}
                </Badge>
              )}
              {header?.frozenAt && (
                <Badge
                  variant="secondary"
                  className="gap-1 text-[10px] text-blue-600"
                >
                  <Snowflake className="h-3 w-3" />
                  Frozen
                </Badge>
              )}
              {header?.deletedAt && (
                <Badge variant="destructive" className="gap-1 text-[10px]">
                  <Trash2 className="h-3 w-3" />
                  Deleted
                </Badge>
              )}
            </div>
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {orgId}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Select value={windowParam} onValueChange={setWindowParam}>
            <SelectTrigger className="h-8 w-[120px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem>
              <SelectItem value="90d">Last 90 days</SelectItem>
              <SelectItem value="180d">Last 180 days</SelectItem>
              <SelectItem value="365d">Last 365 days</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            onClick={load}
            disabled={refreshing}
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      {data === null ? (
        <DashboardSkeleton />
      ) : (
        <>
          {/* KPI strip — single source of truth for the headline numbers. */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <KpiTile
              label="Members"
              value={formatCount(data.quota.userCount)}
              sublabel={
                data.quota.maxUsers != null
                  ? `${data.quota.usersPercent ?? 0}% of ${data.quota.maxUsers} cap`
                  : "no cap"
              }
            />
            <KpiTile
              label="Storage"
              value={formatBytes(data.quota.storageBytes)}
              sublabel={
                data.quota.maxStorageBytes != null
                  ? `${data.quota.storagePercent ?? 0}% of ${formatBytes(
                      data.quota.maxStorageBytes
                    )}`
                  : "no cap"
              }
            />
            <KpiTile
              label={`Activity (${data.window})`}
              value={formatCount(
                data.activity.reduce((a, p) => a + p.value, 0)
              )}
              sublabel="audit events"
            />
            <KpiTile
              label={`New members (${data.window})`}
              value={formatCount(
                data.memberGrowth.reduce((a, p) => a + p.value, 0)
              )}
              sublabel="net new accounts"
            />
            <KpiTile
              label="Failed logins (30d)"
              value={formatCount(data.failedLogins30d)}
              sublabel="security signal"
            />
          </div>

          {/* Quota gauges — only render the bar when a cap is set. */}
          {(data.quota.maxUsers != null ||
            data.quota.maxStorageBytes != null) && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Quota utilization</CardTitle>
                <CardDescription className="text-xs">
                  How close this workspace is to the plan ceilings configured
                  for it.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                {data.quota.maxUsers != null && (
                  <QuotaBar
                    label="Members"
                    used={`${data.quota.userCount} / ${data.quota.maxUsers}`}
                    pct={data.quota.usersPercent ?? 0}
                  />
                )}
                {data.quota.maxStorageBytes != null && (
                  <QuotaBar
                    label="Storage"
                    used={`${formatBytes(data.quota.storageBytes)} / ${formatBytes(
                      data.quota.maxStorageBytes
                    )}`}
                    pct={data.quota.storagePercent ?? 0}
                  />
                )}
              </CardContent>
            </Card>
          )}

          {/* Growth + activity */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Member growth</CardTitle>
                <CardDescription className="text-xs">
                  New users per {data.bucket}, last {data.window}.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <LineChart
                  height={170}
                  series={[
                    {
                      name: "Members",
                      color: "#22c55e",
                      data: data.memberGrowth,
                    },
                  ]}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Storage growth</CardTitle>
                <CardDescription className="text-xs">
                  Bytes uploaded per {data.bucket}. A spike is usually one
                  power user — drill into "largest files" below.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <LineChart
                  height={170}
                  series={[
                    {
                      name: "Bytes",
                      color: "#a855f7",
                      data: data.storageGrowth,
                    },
                  ]}
                  formatY={formatBytes}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Activity volume</CardTitle>
                <CardDescription className="text-xs">
                  Audit-log events per {data.bucket} — proxy for how busy
                  the workspace is.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <LineChart
                  height={170}
                  series={[
                    { name: "Events", color: "#3b82f6", data: data.activity },
                  ]}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  Daily active members
                </CardTitle>
                <CardDescription className="text-xs">
                  Distinct actors per {data.bucket}. Compare with member
                  growth to spot a stall.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <LineChart
                  height={170}
                  series={[
                    {
                      name: "DAU",
                      color: "#f59e0b",
                      data: data.dauSeries,
                    },
                  ]}
                />
              </CardContent>
            </Card>
          </div>

          {/* Hour-of-day pattern */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Hour-of-day pattern</CardTitle>
              <CardDescription className="text-xs">
                When is this workspace's team active? Each cell is one UTC
                hour, last 30 days. Off-hours spikes are worth investigating.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <HourHeatmap data={data.hourlyPattern} />
            </CardContent>
          </Card>

          {/* Role + action breakdown */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Role distribution</CardTitle>
              </CardHeader>
              <CardContent className="grid place-items-center">
                <Donut size={200} data={data.roleDistribution} />
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  Action breakdown (30d)
                </CardTitle>
                <CardDescription className="text-xs">
                  Top 12 audit actions — the texture of what this workspace
                  actually does.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <BarChart data={data.actionBreakdown} height={200} />
              </CardContent>
            </Card>
          </div>

          {/* Top lists */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  Top contributors (30d)
                </CardTitle>
                <CardDescription className="text-xs">
                  Who's writing the most audit events. Empty rows mean the
                  account hasn't logged in.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TopList
                  items={data.topContributors.map((c) => ({
                    label: c.actor,
                    value: c.value,
                  }))}
                  emptyLabel="No activity yet."
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Largest files</CardTitle>
                <CardDescription className="text-xs">
                  Top 10 files by size — fastest path to a storage offender.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TopList
                  items={data.topFiles.map((f) => ({
                    label: f.name || `(unnamed · ${f.id.slice(0, 8)})`,
                    value: f.size,
                  }))}
                  formatV={formatBytes}
                  emptyLabel="No files."
                />
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function QuotaBar({
  label,
  used,
  pct,
}: {
  label: string;
  used: string;
  pct: number;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  // Color escalates as the bar fills — green / amber / red, mirroring the
  // alarms ops cares about.
  const tone =
    clamped >= 90
      ? "bg-red-500"
      : clamped >= 75
        ? "bg-amber-500"
        : "bg-emerald-500";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium">{label}</span>
        <span className="text-[11px] text-muted-foreground">{used}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full ${tone} transition-all`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <div className="text-right text-[10px] text-muted-foreground">
        {clamped}%
      </div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-24 w-full" />
      <div className="grid gap-3 lg:grid-cols-2">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
