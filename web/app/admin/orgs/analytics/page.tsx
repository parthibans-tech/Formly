// Cross-org analytics dashboard for super-admins.
//
// Fetches /v1/admin/orgs/analytics in one round-trip and lays it out
// across five sections:
//
//   1. Headline KPIs (total / active / dormant / frozen / deleted)
//   2. Growth + churn time-series
//   3. Plan / size / storage distributions (donuts + bars)
//   4. Top orgs (users / storage / revenue)
//   5. Cohort retention + dormant org list
//
// All charts are inline-SVG primitives from @/components/admin-charts so
// the page has no extra runtime dependency on a chart lib.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Download,
  Building2,
  Activity,
  AlertTriangle,
  Snowflake,
  Trash2,
  RefreshCcw,
} from "lucide-react";
import {
  BarChart,
  CohortBars,
  Donut,
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
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { api, API_URL, getToken } from "@/lib/api";
import { useToast } from "@/components/toast";

type ActivityStatus = {
  active: number;
  dormant: number;
  frozen: number;
  deleted: number;
};

type Cohort = { cohort: string; total: number; active: number };

type TopOrg = { id: string; name: string; value: number };

type DormantOrg = {
  id: string;
  name: string;
  createdAt: string;
  lastSeen?: string;
};

type OrgAnalytics = {
  window: string;
  bucket: string;
  generated: string;
  signups: TimePoint[];
  planDistribution: LabelValue[];
  storageDistribution: LabelValue[];
  sizeDistribution: LabelValue[];
  activityStatus: ActivityStatus;
  topByUsers: TopOrg[];
  topByStorage: TopOrg[];
  topByRevenue: TopOrg[];
  churn: TimePoint[];
  cohorts: Cohort[];
  dormant: DormantOrg[];
};

export default function OrgsAnalyticsPage() {
  const toast = useToast();
  const [windowParam, setWindowParam] = useState("30d");
  const [data, setData] = useState<OrgAnalytics | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await api<OrgAnalytics>(
        `/v1/admin/orgs/analytics?window=${windowParam}`
      );
      setData(r);
      setForbidden(false);
    } catch (e: any) {
      if (e?.status === 403) {
        setForbidden(true);
      } else {
        toast.show("error", "Couldn't load analytics", { description: e?.message });
      }
    } finally {
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowParam]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  // CSV export — mint a one-off authenticated request and trigger the
  // browser's download flow. We can't use a plain <a download> because
  // the token has to ride in the Authorization header, not cookies.
  async function exportCSV() {
    try {
      const res = await fetch(`${API_URL}/v1/admin/orgs/export.csv`, {
        headers: { Authorization: `Bearer ${getToken() ?? ""}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `formly-orgs-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.show("success", "Export downloaded");
    } catch (e: any) {
      toast.show("error", "Export failed", { description: e?.message });
    }
  }

  const status = data?.activityStatus;
  const totalOrgs = useMemo(() => {
    if (!status) return 0;
    return status.active + status.dormant + status.frozen + status.deleted;
  }, [status]);

  if (forbidden) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Super-admin only
          </CardTitle>
          <CardDescription>
            Cross-org analytics are restricted to platform operators.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Link
              href="/admin/orgs"
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Organizations
            </Link>
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Organizations · Analytics
          </h1>
          <p className="text-sm text-muted-foreground">
            Growth, churn, and segmentation across every workspace on the
            platform. Generated{" "}
            {data?.generated
              ? new Date(data.generated).toLocaleString()
              : "…"}
            .
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={windowParam} onValueChange={setWindowParam}>
            <SelectTrigger className="h-8 w-[110px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem>
              <SelectItem value="90d">Last 90 days</SelectItem>
              <SelectItem value="180d">Last 180 days</SelectItem>
              <SelectItem value="365d">Last year</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={load} disabled={refreshing}>
            <RefreshCcw className="h-3.5 w-3.5" />
            Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={exportCSV}>
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* 1. KPI strip */}
      {!data ? (
        <KpiSkeleton />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <KpiTile
            label="Total orgs"
            value={formatCount(totalOrgs)}
            sublabel={
              <span className="inline-flex items-center gap-1">
                <Building2 className="h-3 w-3" />
                Includes deleted
              </span>
            }
          />
          <KpiTile
            label="Active (30d)"
            value={formatCount(status?.active ?? 0)}
            sublabel={
              <span className="inline-flex items-center gap-1 text-emerald-600">
                <Activity className="h-3 w-3" />
                Audit activity recent
              </span>
            }
          />
          <KpiTile
            label="Dormant"
            value={formatCount(status?.dormant ?? 0)}
            sublabel="No activity 30d+"
          />
          <KpiTile
            label="Frozen"
            value={formatCount(status?.frozen ?? 0)}
            sublabel={
              <span className="inline-flex items-center gap-1 text-blue-600">
                <Snowflake className="h-3 w-3" />
                Sign-in blocked
              </span>
            }
          />
          <KpiTile
            label="Soft-deleted"
            value={formatCount(status?.deleted ?? 0)}
            sublabel={
              <span className="inline-flex items-center gap-1 text-destructive">
                <Trash2 className="h-3 w-3" />
                Restorable
              </span>
            }
          />
        </div>
      )}

      {/* 2. Growth + churn */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">New organizations</CardTitle>
            <CardDescription>
              Created per {data?.bucket ?? "day"} · {windowParam}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data ? (
              <LineChart
                series={[
                  {
                    name: "Signups",
                    color: "#3b82f6",
                    data: data.signups,
                  },
                ]}
              />
            ) : (
              <Skeleton className="h-[180px] w-full" />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Churn signal</CardTitle>
            <CardDescription>
              Frozen + soft-deleted per {data?.bucket ?? "day"} · {windowParam}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data ? (
              <LineChart
                series={[
                  {
                    name: "Frozen / deleted",
                    color: "#ef4444",
                    data: data.churn,
                  },
                ]}
              />
            ) : (
              <Skeleton className="h-[180px] w-full" />
            )}
          </CardContent>
        </Card>
      </div>

      {/* 3. Distributions */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Plan distribution</CardTitle>
            <CardDescription>Active subscription tier per org</CardDescription>
          </CardHeader>
          <CardContent>
            {data ? (
              <Donut data={data.planDistribution} centerLabel="orgs" />
            ) : (
              <Skeleton className="h-[140px] w-full" />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Org size</CardTitle>
            <CardDescription>Members per workspace</CardDescription>
          </CardHeader>
          <CardContent>
            {data ? (
              <BarChart data={data.sizeDistribution} color="#22c55e" />
            ) : (
              <Skeleton className="h-[160px] w-full" />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Storage footprint</CardTitle>
            <CardDescription>Bytes per workspace</CardDescription>
          </CardHeader>
          <CardContent>
            {data ? (
              <BarChart data={data.storageDistribution} color="#a855f7" />
            ) : (
              <Skeleton className="h-[160px] w-full" />
            )}
          </CardContent>
        </Card>
      </div>

      {/* 4. Top orgs */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Top orgs by users</CardTitle>
            <CardDescription>Includes locked + active members</CardDescription>
          </CardHeader>
          <CardContent>
            {data ? (
              <TopList
                items={data.topByUsers.map((o) => ({
                  id: o.id,
                  label: o.name || "(unnamed)",
                  value: o.value,
                  sub: o.id,
                }))}
                href={(id) => `/admin/orgs?focus=${id}`}
              />
            ) : (
              <Skeleton className="h-40 w-full" />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Top orgs by storage</CardTitle>
            <CardDescription>Sum of file bytes (live files)</CardDescription>
          </CardHeader>
          <CardContent>
            {data ? (
              <TopList
                items={data.topByStorage.map((o) => ({
                  id: o.id,
                  label: o.name || "(unnamed)",
                  value: o.value,
                  sub: o.id,
                }))}
                formatV={formatBytes}
                href={(id) => `/admin/orgs?focus=${id}`}
              />
            ) : (
              <Skeleton className="h-40 w-full" />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Top orgs by revenue</CardTitle>
            <CardDescription>Paid invoices in window</CardDescription>
          </CardHeader>
          <CardContent>
            {data ? (
              <TopList
                items={data.topByRevenue.map((o) => ({
                  id: o.id,
                  label: o.name || "(unnamed)",
                  value: o.value,
                  sub: o.id,
                }))}
                formatV={(n) => "$" + (n / 100).toFixed(2)}
                href={(id) => `/admin/orgs?focus=${id}`}
              />
            ) : (
              <Skeleton className="h-40 w-full" />
            )}
          </CardContent>
        </Card>
      </div>

      {/* 5. Cohorts + dormant */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Cohort retention</CardTitle>
            <CardDescription>
              Orgs by signup week · still active in last 30d
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data ? <CohortBars cohorts={data.cohorts} /> : <Skeleton className="h-40 w-full" />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Dormant orgs</CardTitle>
            <CardDescription>
              Oldest active workspaces with zero activity in 30 days — good
              candidates for outreach or sunset
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!data ? (
              <Skeleton className="h-40 w-full" />
            ) : data.dormant.length === 0 ? (
              <p className="rounded-md border border-dashed bg-muted/20 p-6 text-center text-xs text-muted-foreground">
                Every active workspace has recent audit activity. 🎉
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {data.dormant.map((o) => (
                  <li key={o.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {o.name || "(unnamed)"}
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground">
                        {o.id}
                      </div>
                    </div>
                    <div className="text-right text-[11px] text-muted-foreground">
                      <div>
                        Signed up{" "}
                        {new Date(o.createdAt).toLocaleDateString()}
                      </div>
                      <div>
                        Last seen{" "}
                        {o.lastSeen
                          ? new Date(o.lastSeen).toLocaleDateString()
                          : "never"}
                      </div>
                    </div>
                    <Badge variant="outline" className="text-[10px]">
                      Dormant
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function KpiSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-[88px] w-full" />
      ))}
    </div>
  );
}
