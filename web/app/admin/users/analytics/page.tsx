// Cross-org user analytics for super-admins.
//
// Pulls /v1/admin/users/analytics in one round-trip and renders:
//
//   1. Engagement KPIs (active5m / 1h / 24h / DAU / WAU / MAU)
//   2. Signups + DAU + login-failure time-series
//   3. Role distribution donut + MFA adoption gauge
//   4. Lock-reason buckets + session-count buckets
//   5. Top engaged users + recent locks
//
// Uses the same admin-charts primitives as the orgs page.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  AlertTriangle,
  Download,
  ShieldCheck,
  ShieldOff,
  Users,
  Activity,
  RefreshCcw,
} from "lucide-react";
import {
  BarChart,
  Donut,
  KpiTile,
  LineChart,
  TopList,
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
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, API_URL, getToken } from "@/lib/api";
import { useToast } from "@/components/toast";

type Engagement = {
  active5m: number;
  active1h: number;
  active24h: number;
  dau: number;
  wau: number;
  mau: number;
};

type MfaAdoption = {
  withMfa: number;
  withoutMfa: number;
  adoptionPercent: number;
};

type TopEngaged = { id: string; email: string; value: number };

type RecentLock = {
  id: string;
  email: string;
  reason: string;
  lockedAt: string;
  orgName: string;
  orgId: string;
};

type UserAnalytics = {
  window: string;
  bucket: string;
  signups: TimePoint[];
  roleDistribution: LabelValue[];
  mfaAdoption: MfaAdoption;
  lockedByReason: LabelValue[];
  engagement: Engagement;
  dauSeries: TimePoint[];
  loginFailures: TimePoint[];
  topEngaged: TopEngaged[];
  sessionDistribution: LabelValue[];
  recentLocks: RecentLock[];
};

export default function UsersAnalyticsPage() {
  const toast = useToast();
  const [windowParam, setWindowParam] = useState("30d");
  const [data, setData] = useState<UserAnalytics | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await api<UserAnalytics>(
        `/v1/admin/users/analytics?window=${windowParam}`
      );
      setData(r);
      setForbidden(false);
    } catch (e: any) {
      if (e?.status === 403) setForbidden(true);
      else toast.show("error", "Couldn't load analytics", { description: e?.message });
    } finally {
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowParam]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  async function exportCSV() {
    try {
      const res = await fetch(`${API_URL}/v1/admin/users/export.csv`, {
        headers: { Authorization: `Bearer ${getToken() ?? ""}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `formly-users-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.show("success", "Export downloaded");
    } catch (e: any) {
      toast.show("error", "Export failed", { description: e?.message });
    }
  }

  if (forbidden) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Super-admin only
          </CardTitle>
          <CardDescription>
            Cross-org user analytics are restricted to platform operators.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const eng = data?.engagement;
  const mfa = data?.mfaAdoption;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Link
              href="/admin/users"
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Users
            </Link>
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Users · Analytics
          </h1>
          <p className="text-sm text-muted-foreground">
            Engagement, MFA adoption, login health and lock activity across
            every workspace.
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

      {/* 1. Engagement KPIs */}
      {!eng ? (
        <KpiSkeleton n={6} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <KpiTile
            label="Active now"
            value={formatCount(eng.active5m)}
            sublabel="Last 5 min"
          />
          <KpiTile
            label="Active 1h"
            value={formatCount(eng.active1h)}
            sublabel="Last hour"
          />
          <KpiTile
            label="Active 24h"
            value={formatCount(eng.active24h)}
            sublabel="Last day"
          />
          <KpiTile
            label="DAU"
            value={formatCount(eng.dau)}
            sublabel="Distinct users · 1d"
          />
          <KpiTile
            label="WAU"
            value={formatCount(eng.wau)}
            sublabel="Distinct users · 7d"
          />
          <KpiTile
            label="MAU"
            value={formatCount(eng.mau)}
            sublabel="Distinct users · 30d"
          />
        </div>
      )}

      {/* 2. Time series */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">New users</CardTitle>
            <CardDescription>
              Created per {data?.bucket ?? "day"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data ? (
              <LineChart
                series={[
                  { name: "Signups", color: "#3b82f6", data: data.signups },
                ]}
              />
            ) : (
              <Skeleton className="h-[180px] w-full" />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Active users</CardTitle>
            <CardDescription>
              Distinct user_id per {data?.bucket ?? "day"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data ? (
              <LineChart
                series={[
                  { name: "Active", color: "#22c55e", data: data.dauSeries },
                ]}
              />
            ) : (
              <Skeleton className="h-[180px] w-full" />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Login failures</CardTitle>
            <CardDescription>
              `auth.*failed*` audit events per {data?.bucket ?? "day"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data ? (
              <LineChart
                series={[
                  {
                    name: "Failures",
                    color: "#ef4444",
                    data: data.loginFailures,
                  },
                ]}
              />
            ) : (
              <Skeleton className="h-[180px] w-full" />
            )}
          </CardContent>
        </Card>
      </div>

      {/* 3. Roles + MFA gauge */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Role distribution</CardTitle>
            <CardDescription>Users grouped by primary role</CardDescription>
          </CardHeader>
          <CardContent>
            {data ? (
              <Donut data={data.roleDistribution} centerLabel="users" />
            ) : (
              <Skeleton className="h-[140px] w-full" />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4 text-emerald-500" />
              MFA adoption
            </CardTitle>
            <CardDescription>
              Verified TOTP enrollments vs total users
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!mfa ? (
              <Skeleton className="h-[140px] w-full" />
            ) : (
              <div className="space-y-3">
                <div className="flex items-baseline gap-3">
                  <span className="text-4xl font-semibold tabular-nums">
                    {mfa.adoptionPercent.toFixed(1)}%
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {formatCount(mfa.withMfa)} of{" "}
                    {formatCount(mfa.withMfa + mfa.withoutMfa)} users enrolled
                  </span>
                </div>
                <div className="h-3 overflow-hidden rounded-sm bg-muted">
                  <div
                    className="h-full bg-emerald-500 transition-all"
                    style={{ width: `${mfa.adoptionPercent}%` }}
                  />
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className="inline-flex items-center gap-1 text-emerald-600">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {formatCount(mfa.withMfa)} with MFA
                  </span>
                  <span className="inline-flex items-center gap-1 text-amber-600">
                    <ShieldOff className="h-3.5 w-3.5" />
                    {formatCount(mfa.withoutMfa)} without
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Aim for 100%. Compliance frameworks (SOC 2, ISO 27001)
                  expect MFA on every operator account.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 4. Lock + session distributions */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Lock reasons</CardTitle>
            <CardDescription>
              First 60 chars of `locked_reason` · top 10
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data ? (
              <BarChart data={data.lockedByReason} color="#ef4444" />
            ) : (
              <Skeleton className="h-[160px] w-full" />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Sessions per user</CardTitle>
            <CardDescription>
              Distinct active sessions held per user
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data ? (
              <BarChart data={data.sessionDistribution} color="#3b82f6" />
            ) : (
              <Skeleton className="h-[160px] w-full" />
            )}
          </CardContent>
        </Card>
      </div>

      {/* 5. Top engaged + recent locks */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4 text-emerald-500" />
              Top engaged users
            </CardTitle>
            <CardDescription>
              Most distinct active days in the last 30 days
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data ? (
              <TopList
                items={data.topEngaged.map((u) => ({
                  id: u.id,
                  label: u.email,
                  value: u.value,
                  sub: `${u.value} active days`,
                }))}
                href={(id) => `/admin/users?focus=${id}`}
                formatV={(n) => `${n}d`}
              />
            ) : (
              <Skeleton className="h-40 w-full" />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4 text-amber-500" />
              Recent locks
            </CardTitle>
            <CardDescription>
              Most-recently locked accounts (any reason)
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!data ? (
              <Skeleton className="h-40 w-full" />
            ) : data.recentLocks.length === 0 ? (
              <p className="rounded-md border border-dashed bg-muted/20 p-6 text-center text-xs text-muted-foreground">
                No locked accounts. 🎉
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {data.recentLocks.map((u) => (
                  <li key={u.id} className="px-3 py-2 text-xs">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium">{u.email}</span>
                      <span className="text-muted-foreground">
                        {new Date(u.lockedAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {u.orgName || u.orgId.slice(0, 8) + "…"}
                    </div>
                    {u.reason && (
                      <div className="mt-1 line-clamp-2 rounded bg-muted/40 px-2 py-1 text-[11px]">
                        {u.reason}
                      </div>
                    )}
                    <div className="mt-1.5">
                      <Badge variant="destructive" className="text-[10px]">
                        Locked
                      </Badge>
                    </div>
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

function KpiSkeleton({ n }: { n: number }) {
  return (
    <div
      className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6"
    >
      {Array.from({ length: n }).map((_, i) => (
        <Skeleton key={i} className="h-[88px] w-full" />
      ))}
    </div>
  );
}
