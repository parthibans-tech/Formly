"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  HardDrive,
  Inbox,
  RefreshCw,
  Server,
  ShieldAlert,
  Zap,
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
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

type Component = {
  component: string;
  status: "ok" | "degraded" | "down";
  latencyMs: number;
  detail?: string;
};

type Summary = {
  status: "ok" | "degraded" | "down";
  components: Component[];
  uptimeSec: number;
  version: string;
  goroutines: number;
  heapAllocBytes: number;
  requests24h: number;
  errors24h: number;
  jobs: {
    completed24h: number;
    failed24h: number;
    running: number;
    queued: number;
  };
  activeSessions: number;
};

type QueueStat = {
  name: string;
  pending: number;
  active: number;
  scheduled: number;
  retry: number;
  archived: number;
  completed: number;
  processed24h: number;
  failed24h: number;
  latencyMs: number;
  paused: boolean;
};

type HourlyPoint = {
  hour: string;
  status: string;
  count: number;
  avgMs: number;
  maxMs: number;
};

type EndpointRow = {
  method: string;
  path: string;
  count: number;
  avgMs: number;
  maxMs: number;
  errors: number;
};

type JobRow = {
  id: string;
  kind: string;
  status: string;
  templateId: string;
  total: number;
  done: number;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};

type ErrorRow = {
  id: string;
  component: string;
  kind: string;
  message: string;
  path?: string;
  status?: number;
  context?: Record<string, any>;
  createdAt: string;
};

export default function OpsPage() {
  const toast = useToast();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [queues, setQueues] = useState<{
    queues: QueueStat[];
    available: boolean;
    error?: string;
  } | null>(null);
  const [metrics, setMetrics] = useState<{
    hourly: HourlyPoint[];
    top: EndpointRow[];
  } | null>(null);
  const [jobs, setJobs] = useState<{
    jobs: JobRow[];
    counts: Record<string, number>;
  } | null>(null);
  const [errors, setErrors] = useState<ErrorRow[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // `toast` is read via ref to avoid invalidating this callback on every
  // render — useToast() returns a fresh object literal each render, which
  // would otherwise cause useEffect + setInterval below to tear down/rebuild
  // on every tick and fire the API calls continuously.
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const load = useCallback(async () => {
    setErr(null);
    setRefreshing(true);
    try {
      const [s, q, m, j, e] = await Promise.all([
        api<Summary>("/v1/ops/summary"),
        api<{ queues: QueueStat[]; available: boolean; error?: string }>(
          "/v1/ops/queue"
        ),
        api<{ hourly: HourlyPoint[]; top: EndpointRow[] }>("/v1/ops/metrics"),
        api<{ jobs: JobRow[]; counts: Record<string, number> }>(
          "/v1/ops/jobs"
        ),
        api<{ events: ErrorRow[] }>("/v1/ops/errors?limit=20"),
      ]);
      setSummary(s);
      setQueues(q);
      setMetrics(m);
      setJobs(j);
      setErrors(e.events);
    } catch (e: any) {
      setErr(e.message);
      if (!e.message?.includes("admin")) {
        toastRef.current.show("error", e.message);
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (err && err.includes("admin")) {
    return (
      <>
        <PageHeader />
        <Card className="border-warning/50 bg-warning/5">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <ShieldAlert className="mt-0.5 h-4 w-4 text-warning" />
            <div>
              <div className="font-medium">Admin only</div>
              <div className="text-muted-foreground">
                Operations & observability is restricted to workspace
                administrators.
              </div>
            </div>
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <PageHeader />
        <Button variant="outline" onClick={load} loading={refreshing}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      <SystemHealth summary={summary} />

      <div className="grid gap-4 lg:grid-cols-4">
        <StatCard
          label="Requests (24h)"
          icon={Activity}
          value={fmtCount(summary?.requests24h)}
          tone="primary"
        />
        <StatCard
          label="Errors (24h)"
          icon={AlertTriangle}
          value={fmtCount(summary?.errors24h)}
          tone={(summary?.errors24h ?? 0) > 0 ? "destructive" : "muted"}
        />
        <StatCard
          label="Active sessions"
          icon={Inbox}
          value={fmtCount(summary?.activeSessions)}
          tone="muted"
        />
        <StatCard
          label="Uptime"
          icon={Clock}
          value={formatUptime(summary?.uptimeSec)}
          tone="muted"
        />
      </div>

      <RequestChart hourly={metrics?.hourly} />

      <div className="grid gap-4 lg:grid-cols-2">
        <TopEndpoints top={metrics?.top} />
        <QueueCard data={queues} />
      </div>

      <JobStats data={jobs} />

      <RecentErrors errors={errors} />

      <ProcessStats summary={summary} />
    </>
  );
}

function PageHeader() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">
        Operations &amp; observability
      </h1>
      <p className="text-sm text-muted-foreground">
        System health, request throughput, background queue state, and a live
        feed of errors. Refreshes every 30 seconds.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* System health                                                       */
/* ------------------------------------------------------------------ */

function SystemHealth({ summary }: { summary: Summary | null }) {
  if (!summary) {
    return <Skeleton className="h-24 w-full" />;
  }
  const statusColor = statusTone(summary.status);
  return (
    <Card className={cn("border-2", statusColor.border)}>
      <CardContent className="flex flex-wrap items-center gap-6 p-4">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "grid h-10 w-10 place-items-center rounded-full",
              statusColor.bg
            )}
          >
            {summary.status === "ok" ? (
              <CheckCircle2 className={cn("h-5 w-5", statusColor.fg)} />
            ) : (
              <AlertTriangle className={cn("h-5 w-5", statusColor.fg)} />
            )}
          </span>
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              System status
            </div>
            <div
              className={cn(
                "text-lg font-semibold capitalize",
                statusColor.fg
              )}
            >
              {summary.status}
            </div>
          </div>
        </div>
        <div className="h-10 w-px bg-border" />
        <div className="flex flex-wrap gap-3">
          {summary.components.map((c) => (
            <ComponentChip key={c.component} c={c} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ComponentChip({ c }: { c: Component }) {
  const tone = statusTone(c.status);
  const Icon =
    c.component === "db"
      ? Database
      : c.component === "storage"
      ? HardDrive
      : c.component === "redis"
      ? Zap
      : Server;
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs",
        tone.border,
        tone.bg
      )}
      title={c.detail}
    >
      <Icon className={cn("h-3.5 w-3.5", tone.fg)} />
      <span className="font-medium capitalize">{c.component}</span>
      <span className="text-muted-foreground">{c.latencyMs} ms</span>
      <Badge
        variant="outline"
        className={cn("ml-1 border-0 text-[10px]", tone.fg)}
      >
        {c.status}
      </Badge>
    </div>
  );
}

function statusTone(status: "ok" | "degraded" | "down") {
  switch (status) {
    case "ok":
      return {
        fg: "text-emerald-600",
        bg: "bg-emerald-500/10",
        border: "border-emerald-500/40",
      };
    case "degraded":
      return {
        fg: "text-amber-600",
        bg: "bg-amber-500/10",
        border: "border-amber-500/40",
      };
    case "down":
      return {
        fg: "text-destructive",
        bg: "bg-destructive/10",
        border: "border-destructive/40",
      };
  }
}

/* ------------------------------------------------------------------ */
/* Stat cards                                                          */
/* ------------------------------------------------------------------ */

function StatCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: "primary" | "destructive" | "muted";
}) {
  const classes =
    tone === "primary"
      ? "bg-primary/10 text-primary"
      : tone === "destructive"
      ? "bg-destructive/10 text-destructive"
      : "bg-muted text-muted-foreground";
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <span
          className={cn("grid h-10 w-10 place-items-center rounded-md", classes)}
        >
          <Icon className="h-5 w-5" />
        </span>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {label}
          </div>
          <div className="text-xl font-semibold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Request chart (CSS-only, no chart lib)                               */
/* ------------------------------------------------------------------ */

function RequestChart({ hourly }: { hourly?: HourlyPoint[] }) {
  // Bucket by hour, then stack the status buckets for a simple bar view.
  const rows = useMemo(() => {
    if (!hourly) return [] as { hour: string; label: string; bars: Record<string, number>; total: number }[];
    const byHour = new Map<string, { bars: Record<string, number>; total: number }>();
    for (const h of hourly) {
      const e = byHour.get(h.hour) || { bars: {}, total: 0 };
      e.bars[h.status] = (e.bars[h.status] || 0) + h.count;
      e.total += h.count;
      byHour.set(h.hour, e);
    }
    return Array.from(byHour.entries())
      .map(([hour, v]) => ({
        hour,
        label: new Date(hour).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        bars: v.bars,
        total: v.total,
      }))
      .sort((a, b) => a.hour.localeCompare(b.hour));
  }, [hourly]);

  const max = Math.max(1, ...rows.map((r) => r.total));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          Request volume (last 24h)
        </CardTitle>
        <CardDescription>
          Hourly request count, split by status bucket.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!hourly ? (
          <Skeleton className="h-40 w-full" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="No traffic yet"
            description="Once requests flow through the API, hourly volume will appear here."
          />
        ) : (
          <div className="space-y-4">
            <div className="flex items-end gap-1 h-32">
              {rows.map((r) => {
                const h2 = ((r.bars["2xx"] || 0) / max) * 100;
                const h3 = ((r.bars["3xx"] || 0) / max) * 100;
                const h4 = ((r.bars["4xx"] || 0) / max) * 100;
                const h5 = ((r.bars["5xx"] || 0) / max) * 100;
                return (
                  <div
                    key={r.hour}
                    className="flex-1 flex flex-col justify-end"
                    title={`${r.label} · ${r.total} requests`}
                  >
                    <div
                      className="bg-destructive"
                      style={{ height: `${h5}%` }}
                    />
                    <div
                      className="bg-amber-500"
                      style={{ height: `${h4}%` }}
                    />
                    <div
                      className="bg-sky-500"
                      style={{ height: `${h3}%` }}
                    />
                    <div
                      className="bg-emerald-500"
                      style={{ height: `${h2}%` }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <Legend color="bg-emerald-500" label="2xx" />
              <Legend color="bg-sky-500" label="3xx" />
              <Legend color="bg-amber-500" label="4xx" />
              <Legend color="bg-destructive" label="5xx" />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("h-2.5 w-2.5 rounded-sm", color)} />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Top endpoints + Queue + Jobs + Errors                                */
/* ------------------------------------------------------------------ */

function TopEndpoints({ top }: { top?: EndpointRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-primary" />
          Busiest endpoints (1h)
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {!top ? (
          <div className="space-y-1 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : top.length === 0 ? (
          <EmptyState
            icon={Zap}
            title="No recent traffic"
            description="Top endpoints populate as requests roll in."
          />
        ) : (
          <ul className="divide-y">
            {top.map((e, i) => (
              <li
                key={i}
                className="flex items-center gap-3 px-4 py-2 text-sm"
              >
                <Badge
                  variant="outline"
                  className="font-mono text-[10px] shrink-0"
                >
                  {e.method}
                </Badge>
                <span className="truncate flex-1 font-mono text-xs text-muted-foreground">
                  {e.path}
                </span>
                <span className="tabular-nums text-xs text-muted-foreground">
                  {e.count}
                </span>
                <span className="tabular-nums text-xs w-14 text-right">
                  {e.avgMs}ms
                </span>
                {e.errors > 0 && (
                  <Badge variant="destructive" className="text-[10px]">
                    {e.errors} err
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function QueueCard({
  data,
}: {
  data: { queues: QueueStat[]; available: boolean; error?: string } | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="h-4 w-4 text-primary" />
          Background queues
        </CardTitle>
        <CardDescription>
          Live snapshot of Asynq queues (generation, webhooks, mail).
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {!data ? (
          <div className="p-4">
            <Skeleton className="h-20 w-full" />
          </div>
        ) : !data.available ? (
          <EmptyState
            icon={Server}
            title="Queue inspector unavailable"
            description={
              data.error ||
              "Redis is unreachable. Jobs may be paused until it comes back."
            }
          />
        ) : data.queues.length === 0 ? (
          <EmptyState
            icon={Server}
            title="No queues registered"
            description="Workers have not registered any queues yet."
          />
        ) : (
          <ul className="divide-y">
            {data.queues.map((q) => (
              <li key={q.name} className="px-4 py-3 text-sm">
                <div className="flex items-center justify-between">
                  <div className="font-medium">{q.name}</div>
                  <div className="flex items-center gap-2 text-xs">
                    {q.paused && (
                      <Badge variant="destructive" className="text-[10px]">
                        Paused
                      </Badge>
                    )}
                    <span className="text-muted-foreground">
                      latency {q.latencyMs}ms
                    </span>
                  </div>
                </div>
                <div className="mt-1.5 grid grid-cols-4 gap-1 text-[11px]">
                  <QueuePill label="Pending" value={q.pending} />
                  <QueuePill label="Active" value={q.active} />
                  <QueuePill label="Retry" value={q.retry} />
                  <QueuePill label="Archived" value={q.archived} tone="warn" />
                </div>
                <div className="mt-1.5 flex gap-3 text-[11px] text-muted-foreground">
                  <span>Processed 24h: {q.processed24h}</span>
                  {q.failed24h > 0 && (
                    <span className="text-destructive">
                      Failed 24h: {q.failed24h}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function QueuePill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "warn";
}) {
  return (
    <div
      className={cn(
        "rounded-md border px-2 py-1 flex flex-col",
        tone === "warn" && value > 0
          ? "border-amber-500/40 bg-amber-500/5"
          : "bg-muted/40"
      )}
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums font-semibold">{value}</span>
    </div>
  );
}

function JobStats({
  data,
}: {
  data: { jobs: JobRow[]; counts: Record<string, number> } | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          Recent generation jobs
        </CardTitle>
        <CardDescription>
          Last 50 PDF / batch jobs for this workspace. 7-day totals:
          {data ? (
            <span className="ml-2 font-medium text-foreground">
              {Object.entries(data.counts)
                .map(([k, v]) => `${k}: ${v}`)
                .join(" · ") || "—"}
            </span>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {!data ? (
          <div className="space-y-1 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : data.jobs.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="No jobs yet"
            description="Generate a document to see it here."
          />
        ) : (
          <ul className="divide-y">
            {data.jobs.map((j) => (
              <li
                key={j.id}
                className="flex items-center gap-3 px-4 py-2 text-sm"
              >
                <JobStatusBadge status={j.status} />
                <span className="flex-1 truncate font-mono text-[11px] text-muted-foreground">
                  {j.id.slice(0, 8)} · {j.kind}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {j.done}/{j.total}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground w-32 text-right">
                  {new Date(j.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function JobStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    completed: "bg-emerald-500/10 text-emerald-600 border-emerald-500/40",
    running: "bg-sky-500/10 text-sky-600 border-sky-500/40",
    queued: "bg-muted text-muted-foreground border-border",
    failed: "bg-destructive/10 text-destructive border-destructive/40",
  };
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-[10px] capitalize",
        map[status] || "bg-muted text-muted-foreground"
      )}
    >
      {status}
    </Badge>
  );
}

function RecentErrors({ errors }: { errors: ErrorRow[] | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          Recent errors
        </CardTitle>
        <CardDescription>
          Latest 20 server errors, panics, and failed health probes.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {!errors ? (
          <div className="space-y-1 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : errors.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="No errors in the last 30 days"
            description="Nothing to report — the service has been healthy."
          />
        ) : (
          <ul className="divide-y">
            {errors.map((e) => (
              <li key={e.id} className="px-4 py-2.5 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">
                    {e.component}
                  </Badge>
                  <Badge variant="secondary" className="text-[10px]">
                    {e.kind}
                  </Badge>
                  {e.status ? (
                    <Badge
                      variant="outline"
                      className="font-mono text-[10px] text-destructive"
                    >
                      {e.status}
                    </Badge>
                  ) : null}
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {new Date(e.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {e.path && (
                    <span className="font-mono mr-2">{e.path}</span>
                  )}
                  {e.message}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ProcessStats({ summary }: { summary: Summary | null }) {
  if (!summary) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="h-4 w-4 text-primary" />
          Process stats
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <div>
          <div className="text-xs text-muted-foreground">Goroutines</div>
          <div className="text-lg font-semibold tabular-nums">
            {summary.goroutines}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Heap alloc</div>
          <div className="text-lg font-semibold tabular-nums">
            {fmtBytes(summary.heapAllocBytes)}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Version</div>
          <div className="text-lg font-semibold tabular-nums">
            {summary.version}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Uptime</div>
          <div className="text-lg font-semibold tabular-nums">
            {formatUptime(summary.uptimeSec)}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function fmtCount(n?: number): string {
  if (n === undefined || n === null) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "k";
  return (n / 1_000_000).toFixed(1) + "m";
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatUptime(sec?: number): string {
  if (!sec) return "—";
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
