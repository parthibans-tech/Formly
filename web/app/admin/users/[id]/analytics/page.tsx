// Per-user analytics dashboard — a full-page operator view scoped to one
// account.
//
// Sister page to the cross-user dashboard at /admin/users/analytics.
// This page is the surface support / SRE jumps to when triaging "is this
// account compromised?", "is this person actually using the product?", or
// "what does Bob from Acme actually do all day?".
//
// Pulls GET /v1/admin/users/{id}/analytics?window=… and the user header.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Lock,
  RefreshCcw,
  ShieldCheck,
  ShieldOff,
  UserCog,
} from "lucide-react";
import {
  BarChart,
  HourHeatmap,
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

type UserAnalytics = {
  window: string;
  bucket: string;
  activity: TimePoint[];
  hourlyPattern: number[];
  sessionStarts: TimePoint[];
  failedLogins30d: number;
  actions30d: { total: number; distinct: number };
  actionBreakdown: LabelValue[];
  ipBreakdown: LabelValue[];
  uaBreakdown: LabelValue[];
  sessionSnapshot: { activeSessions: number; lastActiveAt?: string };
};

type UserHeader = {
  id: string;
  email: string;
  name: string;
  role: string;
  orgId: string;
  orgName: string;
  hasMfa: boolean;
  lockedAt?: string | null;
  createdAt: string;
  lastSeenAt?: string | null;
};

export default function UserAnalyticsPage() {
  const params = useParams<{ id: string }>();
  const userId = params?.id;
  const toast = useToast();

  const [windowParam, setWindowParam] = useState("30d");
  const [data, setData] = useState<UserAnalytics | null>(null);
  const [header, setHeader] = useState<UserHeader | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!userId) return;
    setRefreshing(true);
    try {
      const [a, h] = await Promise.all([
        api<UserAnalytics>(
          `/v1/admin/users/${userId}/analytics?window=${windowParam}`
        ),
        api<UserHeader>(`/v1/admin/users/${userId}`),
      ]);
      setData(a);
      setHeader(h);
    } catch (e: any) {
      toast.show("error", "Couldn't load user analytics", {
        description: e?.message,
      });
    } finally {
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, windowParam]);

  useEffect(() => {
    load();
  }, [load]);

  if (!userId) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button asChild size="icon" variant="ghost" className="shrink-0">
            <Link href="/admin/users" aria-label="Back to users">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <UserCog className="h-5 w-5 text-muted-foreground" />
              <h1 className="truncate text-2xl font-semibold tracking-tight">
                {header?.name || header?.email || "User"}
              </h1>
              {header?.role && (
                <Badge variant="outline" className="text-[10px] uppercase">
                  {header.role}
                </Badge>
              )}
              {header?.lockedAt && (
                <Badge variant="destructive" className="gap-1 text-[10px]">
                  <Lock className="h-3 w-3" />
                  Locked
                </Badge>
              )}
              {header?.hasMfa ? (
                <Badge variant="secondary" className="gap-1 text-[10px]">
                  <ShieldCheck className="h-3 w-3" />
                  MFA
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="gap-1 text-[10px] text-amber-600"
                >
                  <ShieldOff className="h-3 w-3" />
                  No MFA
                </Badge>
              )}
            </div>
            <p className="truncate text-[11px] text-muted-foreground">
              {header?.email}
              {header?.orgName ? ` · ${header.orgName}` : ""}
            </p>
            <p className="truncate font-mono text-[10px] text-muted-foreground">
              {userId}
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
          {/* KPI strip */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <KpiTile
              label="Actions (30d)"
              value={formatCount(data.actions30d.total)}
              sublabel={`${data.actions30d.distinct} distinct`}
            />
            <KpiTile
              label={`Activity (${data.window})`}
              value={formatCount(
                data.activity.reduce((a, p) => a + p.value, 0)
              )}
              sublabel="audit events"
            />
            <KpiTile
              label={`Sessions (${data.window})`}
              value={formatCount(
                data.sessionStarts.reduce((a, p) => a + p.value, 0)
              )}
              sublabel="new sign-ins"
            />
            <KpiTile
              label="Active sessions"
              value={formatCount(data.sessionSnapshot.activeSessions)}
              sublabel={
                data.sessionSnapshot.lastActiveAt
                  ? `last seen ${new Date(
                      data.sessionSnapshot.lastActiveAt
                    ).toLocaleString()}`
                  : "never"
              }
            />
            <KpiTile
              label="Failed logins (30d)"
              value={formatCount(data.failedLogins30d)}
              sublabel="security signal"
            />
          </div>

          {/* Time-series row */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Activity</CardTitle>
                <CardDescription className="text-xs">
                  Audit-log events authored by this user, last {data.window}.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <LineChart
                  height={170}
                  series={[
                    {
                      name: "Events",
                      color: "#3b82f6",
                      data: data.activity,
                    },
                  ]}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Session starts</CardTitle>
                <CardDescription className="text-xs">
                  New sessions per {data.bucket}. Spikes can mean a new
                  device — or a brute-forced credential.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <LineChart
                  height={170}
                  series={[
                    {
                      name: "Sessions",
                      color: "#22c55e",
                      data: data.sessionStarts,
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
                Auth events by UTC hour, last 60 days. A 3 AM burst from a
                normally-9-to-5 user is the canonical takeover signal.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <HourHeatmap data={data.hourlyPattern} />
            </CardContent>
          </Card>

          {/* Action breakdown — wide */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Action breakdown (30d)</CardTitle>
              <CardDescription className="text-xs">
                Top 12 audit actions performed. The texture of how this user
                actually uses the product.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <BarChart data={data.actionBreakdown} height={200} />
            </CardContent>
          </Card>

          {/* Security signals row */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  Sign-in IPs (last 60d)
                </CardTitle>
                <CardDescription className="text-xs">
                  Diversity here is the most useful single takeover signal.
                  A normally-single-IP user suddenly seen from 5 networks
                  warrants a lock.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TopList
                  items={data.ipBreakdown}
                  emptyLabel="No sign-in events."
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  User agents (last 60d)
                </CardTitle>
                <CardDescription className="text-xs">
                  Browser / client family this user signs in from. A new
                  agent paired with a new IP is suspicious.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TopList
                  items={data.uaBreakdown}
                  emptyLabel="No data yet."
                />
              </CardContent>
            </Card>
          </div>
        </>
      )}
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
