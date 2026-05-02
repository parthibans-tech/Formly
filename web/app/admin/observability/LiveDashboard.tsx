"use client";

// Live observability dashboard — enterprise-grade rewrite.
//
// Layout (top to bottom)
// ----------------------
//   1. Header strip: live/stale indicator, generated-at, time range
//      selector, refresh button.
//   2. Connectivity row: one chip per Prometheus scrape target
//      (formly-api / formly-worker). Red when down — this is the
//      first thing to look at when "live preview is empty."
//   3. Active alerts banner: every firing/pending alert from the
//      same Prometheus, severity-coloured, with summary + runbook.
//   4. KPI strip: dense 4-up cards each with a sparkline below the
//      number — request rate, 5xx ratio, p95 latency, DB pool.
//   5. Service health: queue, webhook, AI providers — three side-by-side
//      cards, each with a tiny inline sparkline.
//   6. Tenant SLO row: per-tier read vs write 5xx ratio, error budget
//      remaining bar with the predicted exhaustion forecast.
//   7. Auth abuse signals.
//   8. Trend explorer: the curated PromQL series picker.
//   9. Build version pins.
//
// All numbers come from the backend allowlist (PromQL stays on the
// API). The dashboard is a strict consumer.
//
// Polling: 30s default, but the time-range selector also drives a
// re-fetch so bumping to "24h" pulls the longer-window series
// immediately rather than waiting for the next tick.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BellRing,
  CheckCircle2,
  Clock,
  Database,
  ExternalLink,
  Gauge,
  Globe,
  KeyRound,
  Minus,
  PlugZap,
  Plug,
  RefreshCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Workflow,
  XCircle,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  fetchAlerts,
  fetchInfra,
  fetchSeries,
  fetchSnapshot,
  fetchTargets,
  isPromUnconfigured,
  type Alert as PromAlert,
  type InfraComponent,
  type Series,
  type SeriesMetric,
  type Snapshot,
  type Target,
} from "@/lib/observability";

const REFRESH_MS = 30_000;

// Time ranges drive both the sparkline window and the trend
// explorer's range query. Steps mirror what Prometheus considers
// reasonable for a 60-point chart.
const RANGES = [
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "6h", minutes: 360 },
  { label: "24h", minutes: 1440 },
] as const;
type RangeMinutes = (typeof RANGES)[number]["minutes"];

export function LiveDashboard() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [alerts, setAlerts] = useState<PromAlert[]>([]);
  const [infra, setInfra] = useState<InfraComponent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);
  const [range, setRange] = useState<RangeMinutes>(60);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Fan out — snapshot is the slowest (10 parallel PromQLs
      // server-side), targets/alerts are single calls. allSettled
      // so a transient targets failure doesn't blank the KPI strip.
      const [snapRes, targetsRes, alertsRes, infraRes] =
        await Promise.allSettled([
          fetchSnapshot(),
          fetchTargets(),
          fetchAlerts(),
          fetchInfra(),
        ]);
      if (snapRes.status === "fulfilled") {
        setSnap(snapRes.value);
        setError(null);
        setUnconfigured(false);
      } else {
        if (isPromUnconfigured(snapRes.reason)) {
          setUnconfigured(true);
          setError(null);
        } else {
          setError(
            snapRes.reason instanceof Error
              ? snapRes.reason.message
              : String(snapRes.reason),
          );
        }
      }
      setTargets(
        targetsRes.status === "fulfilled" ? targetsRes.value.targets : [],
      );
      setAlerts(
        alertsRes.status === "fulfilled" ? alertsRes.value.alerts : [],
      );
      setInfra(
        infraRes.status === "fulfilled" ? infraRes.value.components : [],
      );
      setLastFetched(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  if (unconfigured) {
    return <UnconfiguredCard />;
  }

  const downTargets = targets.filter((t) => t.health === "down");
  const firingAlerts = alerts.filter((a) => a.state === "firing");
  const pendingAlerts = alerts.filter((a) => a.state === "pending");

  return (
    <div className="space-y-4">
      <DashboardHeader
        lastFetched={lastFetched}
        loading={loading}
        onRefresh={refresh}
        range={range}
        onRangeChange={setRange}
        targets={targets}
        firingCount={firingAlerts.length}
      />

      {error && (
        <Card className="border-rose-300/60 bg-rose-50/50 dark:border-rose-900/60 dark:bg-rose-950/30">
          <CardContent className="flex items-start gap-2 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 text-rose-600 dark:text-rose-400" />
            <div>
              <div className="font-medium text-rose-900 dark:text-rose-200">
                Couldn't load live snapshot
              </div>
              <div className="text-xs text-rose-700 dark:text-rose-300">
                {error}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {targets.length === 0 && !loading && !error && (
        <NoTargetsHint />
      )}

      {targets.length > 0 && (
        <ScrapeTargetsStrip targets={targets} downCount={downTargets.length} />
      )}

      {infra.length > 0 && <InfraStrip infra={infra} />}

      {(firingAlerts.length > 0 || pendingAlerts.length > 0) && (
        <ActiveAlertsPanel firing={firingAlerts} pending={pendingAlerts} />
      )}

      {snap && (
        <>
          <SectionHeader
            icon={<Globe className="h-4 w-4" />}
            title="Global health"
            description="Request rate, error ratio, latency, pool saturation."
          />
          <KPIStrip snap={snap} range={range} />

          <SectionHeader
            icon={<Workflow className="h-4 w-4" />}
            title="Service health"
            description="Background queue, outbound webhooks, AI providers."
          />
          <ServiceHealthRow snap={snap} range={range} />

          <SectionHeader
            icon={<ShieldCheck className="h-4 w-4" />}
            title="Tenant SLO & error budget"
            description="99.5% per-tenant target. Budget remaining over 28 days, split by read vs write."
          />
          <SLORow snap={snap} range={range} />

          <SectionHeader
            icon={<KeyRound className="h-4 w-4" />}
            title="Auth abuse signals"
            description="Per-second rates over the trailing 5 minutes."
          />
          <AuthRow snap={snap} />

          <SectionHeader
            icon={<Activity className="h-4 w-4" />}
            title="Trend explorer"
            description="Pick a metric and time window. The set is fixed server-side; the browser never issues PromQL."
          />
          <Card>
            <CardContent className="p-4">
              <SparklineExplorer range={range} />
            </CardContent>
          </Card>

          {snap.build && snap.build.length > 0 && (
            <BuildVersionRow build={snap.build} />
          )}
        </>
      )}
    </div>
  );
}

// ---------- top-level scaffolding ------------------------------- //

function DashboardHeader({
  lastFetched,
  loading,
  onRefresh,
  range,
  onRangeChange,
  targets,
  firingCount,
}: {
  lastFetched: Date | null;
  loading: boolean;
  onRefresh: () => void;
  range: RangeMinutes;
  onRangeChange: (m: RangeMinutes) => void;
  targets: Target[];
  firingCount: number;
}) {
  const allUp = targets.length > 0 && targets.every((t) => t.health === "up");
  const noData = targets.length === 0;
  const stale = lastFetched
    ? Date.now() - lastFetched.getTime() > 90_000
    : false;

  let connTone: "ok" | "warn" | "bad" | "muted" = "muted";
  let connLabel = "Connecting…";
  if (noData && lastFetched) {
    connTone = "warn";
    connLabel = "No targets";
  } else if (allUp) {
    connTone = "ok";
    connLabel = "Live";
  } else if (targets.length > 0) {
    connTone = "bad";
    connLabel = "Degraded";
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
            connTone === "ok"
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
              : connTone === "warn"
              ? "bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-300"
              : connTone === "bad"
              ? "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300"
              : "bg-muted text-muted-foreground"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              connTone === "ok"
                ? "bg-emerald-500 animate-pulse"
                : connTone === "warn"
                ? "bg-amber-500"
                : connTone === "bad"
                ? "bg-rose-500 animate-pulse"
                : "bg-muted-foreground"
            }`}
          />
          {connLabel}
        </div>
        {firingCount > 0 && (
          <Badge variant="outline" className="border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            <BellRing className="mr-1 h-3 w-3" />
            {firingCount} firing
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          {lastFetched ? (
            <>
              Updated {lastFetched.toLocaleTimeString()}
              {stale && (
                <span className="ml-1 text-amber-700 dark:text-amber-400">
                  (stale)
                </span>
              )}
              {" "}• polls every 30s
            </>
          ) : (
            "Loading…"
          )}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <div className="inline-flex rounded-md border bg-background p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.minutes}
              onClick={() => onRangeChange(r.minutes)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                range === r.minutes
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={onRefresh}
          disabled={loading}
          className="gap-1.5"
        >
          <RefreshCcw
            className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>
    </div>
  );
}

function SectionHeader({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 pt-2">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      {description && (
        <p className="hidden truncate text-xs text-muted-foreground md:block">
          {description}
        </p>
      )}
    </div>
  );
}

// ---------- connectivity & alerts ------------------------------- //

function ScrapeTargetsStrip({
  targets,
  downCount,
}: {
  targets: Target[];
  downCount: number;
}) {
  return (
    <div
      className={`rounded-lg border ${
        downCount > 0
          ? "border-rose-300/70 bg-rose-50/40 dark:border-rose-900/60 dark:bg-rose-950/20"
          : "border-emerald-200/70 bg-emerald-50/30 dark:border-emerald-900/50 dark:bg-emerald-950/20"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 p-3">
        <Plug
          className={`h-4 w-4 ${
            downCount > 0
              ? "text-rose-600 dark:text-rose-400"
              : "text-emerald-600 dark:text-emerald-400"
          }`}
        />
        <span className="text-sm font-medium">
          {downCount > 0
            ? `${downCount} of ${targets.length} scrape target${targets.length === 1 ? "" : "s"} down`
            : `Prometheus reaching all ${targets.length} target${targets.length === 1 ? "" : "s"}`}
        </span>
        <div className="ml-auto flex flex-wrap gap-1.5">
          {targets.map((t, i) => (
            <TargetChip key={i} target={t} />
          ))}
        </div>
      </div>
      {downCount > 0 && (
        <div className="border-t border-rose-200/60 bg-rose-50/40 px-3 py-2 text-xs text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
          Live numbers below depend on these scrapes succeeding. If the
          API target is down, Prometheus can't reach
          <code className="mx-1 rounded bg-rose-100 px-1 py-0.5 font-mono dark:bg-rose-900/60">
            host.docker.internal:8080
          </code>
          — confirm the API process is running and that the
          <code className="mx-1 rounded bg-rose-100 px-1 py-0.5 font-mono dark:bg-rose-900/60">
            extra_hosts
          </code>
          mapping is in place on Linux.
        </div>
      )}
    </div>
  );
}

function TargetChip({ target }: { target: Target }) {
  const up = target.health === "up";
  const down = target.health === "down";
  const Icon = up ? CheckCircle2 : down ? XCircle : AlertCircle;
  const colorClass = up
    ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300"
    : down
    ? "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-300"
    : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300";
  return (
    <div
      title={
        target.lastError
          ? `${target.endpoint}\n\nLast error: ${target.lastError}`
          : target.endpoint
      }
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${colorClass}`}
    >
      <Icon className="h-3 w-3" />
      <span className="font-medium">{target.job}</span>
      <span className="opacity-70">
        {up ? "up" : down ? "down" : target.health}
      </span>
    </div>
  );
}

function InfraStrip({ infra }: { infra: InfraComponent[] }) {
  // Render order is fixed so the strip doesn't reshuffle on every
  // poll. The backend already emits in this order; we're just
  // defending against future reorderings.
  const order = [
    "prometheus",
    "alertmanager",
    "tempo",
    "loki",
    "pyroscope",
    "grafana",
    "blackbox",
    "postgres-exporter",
    "redis-exporter",
    "cadvisor",
  ];
  const sorted = [...infra].sort(
    (a, b) =>
      (order.indexOf(a.name) === -1 ? 99 : order.indexOf(a.name)) -
      (order.indexOf(b.name) === -1 ? 99 : order.indexOf(b.name)),
  );
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card/40 p-2.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Observability stack
      </span>
      {sorted.map((c) => (
        <InfraChip key={c.name} c={c} />
      ))}
    </div>
  );
}

function InfraChip({ c }: { c: InfraComponent }) {
  // Three states:
  //   - configured + healthy → green dot
  //   - configured + unhealthy → red dot, tooltip carries the
  //     server-side detail string (timeout, 502, etc.)
  //   - not configured → muted dot, hint at what env var to set
  const tone: "ok" | "bad" | "muted" = !c.configured
    ? "muted"
    : c.healthy
    ? "ok"
    : "bad";
  const label =
    c.name === "prometheus"
      ? "Prometheus"
      : c.name === "alertmanager"
      ? "Alertmanager"
      : c.name === "tempo"
      ? "Tempo"
      : c.name === "loki"
      ? "Loki"
      : c.name === "pyroscope"
      ? "Pyroscope"
      : c.name === "grafana"
      ? "Grafana"
      : c.name === "blackbox"
      ? "Blackbox"
      : c.name === "postgres-exporter"
      ? "pg exporter"
      : c.name === "redis-exporter"
      ? "redis exporter"
      : c.name === "cadvisor"
      ? "cAdvisor"
      : c.name;
  const envHint =
    c.name === "alertmanager"
      ? "Set ALERTMANAGER_URL to enable"
      : c.name === "tempo"
      ? "Set OTEL_EXPORTER_OTLP_ENDPOINT to enable"
      : c.name === "loki"
      ? "Set LOKI_URL to enable"
      : c.name === "pyroscope"
      ? "Set PYROSCOPE_URL to enable"
      : c.name === "grafana"
      ? "Set GRAFANA_URL to enable"
      : c.name === "blackbox"
      ? "Set BLACKBOX_URL to enable"
      : c.name === "postgres-exporter"
      ? "Set POSTGRES_EXPORTER_URL to enable"
      : c.name === "redis-exporter"
      ? "Set REDIS_EXPORTER_URL to enable"
      : c.name === "cadvisor"
      ? "Set CADVISOR_URL to enable"
      : "Set PROMETHEUS_URL to enable";
  const title = !c.configured
    ? envHint
    : c.healthy
    ? c.url || "healthy"
    : `${c.url ?? ""}\n${c.detail ?? "unhealthy"}`.trim();
  const dotClass =
    tone === "ok"
      ? "bg-emerald-500"
      : tone === "bad"
      ? "bg-rose-500"
      : "bg-muted-foreground/40";
  const wrapperClass =
    tone === "ok"
      ? "border-emerald-200/70 bg-emerald-50/40 dark:border-emerald-900/60 dark:bg-emerald-950/20"
      : tone === "bad"
      ? "border-rose-300/70 bg-rose-50/40 dark:border-rose-900/60 dark:bg-rose-950/20"
      : "border-dashed bg-muted/30 text-muted-foreground";
  return (
    <div
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs ${wrapperClass}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
      <span className="font-medium">{label}</span>
      <span className="opacity-70">
        {!c.configured
          ? "not configured"
          : c.healthy
          ? "healthy"
          : "unhealthy"}
      </span>
    </div>
  );
}

function ActiveAlertsPanel({
  firing,
  pending,
}: {
  firing: PromAlert[];
  pending: PromAlert[];
}) {
  return (
    <Card
      className={
        firing.length
          ? "border-rose-300/70 dark:border-rose-900/60"
          : "border-amber-300/70 dark:border-amber-900/60"
      }
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          {firing.length > 0 ? (
            <ShieldAlert className="h-4 w-4 text-rose-600 dark:text-rose-400" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          )}
          Active alerts
          <Badge variant="outline" className="ml-1 font-mono">
            {firing.length} firing · {pending.length} pending
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {firing.map((a, i) => (
          <AlertRow key={`f${i}`} alert={a} />
        ))}
        {pending.map((a, i) => (
          <AlertRow key={`p${i}`} alert={a} />
        ))}
      </CardContent>
    </Card>
  );
}

function AlertRow({ alert }: { alert: PromAlert }) {
  const firing = alert.state === "firing";
  const page = alert.severity === "page";
  const tone = firing
    ? page
      ? "rose"
      : "amber"
    : "amber";
  const colorClass =
    tone === "rose"
      ? "border-rose-300/70 bg-rose-50/60 dark:border-rose-900/60 dark:bg-rose-950/30"
      : "border-amber-300/70 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/30";
  return (
    <div
      className={`flex flex-col gap-1 rounded-md border p-2.5 text-sm md:flex-row md:items-start md:gap-3 ${colorClass}`}
    >
      <div className="flex shrink-0 items-center gap-2">
        <Badge
          variant="outline"
          className={
            firing
              ? "border-rose-400 bg-rose-100 font-mono text-rose-900 dark:border-rose-700 dark:bg-rose-950/60 dark:text-rose-300"
              : "border-amber-400 bg-amber-100 font-mono text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
          }
        >
          {alert.state.toUpperCase()}
        </Badge>
        {alert.severity && (
          <Badge variant="outline" className="font-mono uppercase">
            {alert.severity}
          </Badge>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-semibold">{alert.name}</span>
          <span className="font-mono text-xs text-muted-foreground">
            since {timeAgo(alert.activeAt)}
          </span>
          {alert.value && (
            <span className="font-mono text-xs text-muted-foreground">
              · value {formatNumberSafe(parseFloat(alert.value))}
            </span>
          )}
        </div>
        {alert.summary && (
          <div className="text-xs text-muted-foreground">{alert.summary}</div>
        )}
        {alert.runbook && (
          <a
            href={alert.runbook}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            Runbook <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}

// ---------- KPI strip with sparklines --------------------------- //

function KPIStrip({ snap, range }: { snap: Snapshot; range: RangeMinutes }) {
  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
      <KpiCard
        icon={<Globe className="h-4 w-4" />}
        label="HTTP request rate"
        value={`${formatNumber(snap.http.rps)}`}
        unit="rps"
        caption={`${formatNumber(snap.http.inFlight)} in-flight`}
        seriesKey="http.rps"
        range={range}
        soft={fieldErr(snap, "http.rps")}
      />
      <KpiCard
        icon={<AlertTriangle className="h-4 w-4" />}
        label="5xx error ratio (5m)"
        value={formatPercent(snap.http.errorRatio)}
        caption="Target: < 0.5%"
        tone={
          snap.http.errorRatio > 0.05
            ? "bad"
            : snap.http.errorRatio > 0.005
            ? "warn"
            : "ok"
        }
        seriesKey="http.errorRatio"
        range={range}
        soft={fieldErr(snap, "http.errorRatio")}
      />
      <KpiCard
        icon={<Gauge className="h-4 w-4" />}
        label="HTTP p95 latency"
        value={formatSeconds(snap.http.p95Latency)}
        caption="Budget: < 2s"
        tone={
          snap.http.p95Latency > 2
            ? "bad"
            : snap.http.p95Latency > 1
            ? "warn"
            : "ok"
        }
        seriesKey="http.p95Latency"
        range={range}
        soft={fieldErr(snap, "http.p95Latency")}
      />
      <KpiCard
        icon={<Database className="h-4 w-4" />}
        label="DB pool utilization"
        value={formatPercent(snap.dbPool.utilization)}
        caption={`${formatNumber(snap.dbPool.acquired)} / ${formatNumber(snap.dbPool.max)} connections`}
        tone={
          snap.dbPool.utilization > 0.95
            ? "bad"
            : snap.dbPool.utilization > 0.8
            ? "warn"
            : "ok"
        }
        seriesKey="dbPool.utilization"
        range={range}
        soft={fieldErr(snap, "dbPool")}
      />
    </div>
  );
}

type Tone = "ok" | "warn" | "bad";

function KpiCard(props: {
  icon: React.ReactNode;
  label: string;
  value: string;
  unit?: string;
  caption?: string;
  tone?: Tone;
  seriesKey?: SeriesMetric;
  range: RangeMinutes;
  soft?: string | null;
}) {
  const toneClass =
    props.tone === "bad"
      ? "text-rose-700 dark:text-rose-400"
      : props.tone === "warn"
      ? "text-amber-700 dark:text-amber-400"
      : "text-foreground";
  const ringClass =
    props.tone === "bad"
      ? "ring-1 ring-rose-200/60 dark:ring-rose-900/60"
      : props.tone === "warn"
      ? "ring-1 ring-amber-200/60 dark:ring-amber-900/60"
      : "";
  return (
    <Card className={ringClass}>
      <CardContent className="space-y-2 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {props.icon}
            {props.label}
          </div>
          {props.tone && <ToneDot tone={props.tone} />}
        </div>
        <div className="flex items-baseline gap-1.5">
          <div className={`text-2xl font-semibold tabular-nums ${toneClass}`}>
            {props.value}
          </div>
          {props.unit && (
            <span className="text-xs text-muted-foreground">{props.unit}</span>
          )}
        </div>
        {props.seriesKey && (
          <InlineSparkline
            metric={props.seriesKey}
            range={props.range}
            tone={props.tone}
          />
        )}
        {props.caption && (
          <div className="text-xs text-muted-foreground">{props.caption}</div>
        )}
        {props.soft && (
          <div className="text-[10px] text-rose-700 dark:text-rose-400">
            err: {props.soft}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ToneDot({ tone }: { tone: Tone }) {
  const c =
    tone === "bad"
      ? "bg-rose-500"
      : tone === "warn"
      ? "bg-amber-500"
      : "bg-emerald-500";
  return <span className={`h-2 w-2 rounded-full ${c}`} />;
}

// ---------- Service health row ---------------------------------- //

function ServiceHealthRow({
  snap,
  range,
}: {
  snap: Snapshot;
  range: RangeMinutes;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Workflow className="h-4 w-4" />
            Queue throughput
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <BigStat
            value={`${formatNumber(snap.queue.tasksPerSec)} tasks/s`}
            caption={`${formatNumber(snap.queue.inFlight)} in-flight`}
          />
          <InlineSparkline metric="queue.rate" range={range} />
          <DetailRow
            k="failure ratio"
            v={formatPercent(snap.queue.failRatio)}
            tone={
              snap.queue.failRatio > 0.1
                ? "bad"
                : snap.queue.failRatio > 0.02
                ? "warn"
                : "ok"
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <PlugZap className="h-4 w-4" />
            Outbound webhooks
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <BigStat
            value={`${formatNumber(snap.webhook.rate)} /s`}
            caption="last 5 minutes"
          />
          <InlineSparkline metric="webhook.failRatio" range={range} />
          <DetailRow
            k="failure ratio"
            v={formatPercent(snap.webhook.failRatio)}
            tone={
              snap.webhook.failRatio > 0.25
                ? "bad"
                : snap.webhook.failRatio > 0.1
                ? "warn"
                : "ok"
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Sparkles className="h-4 w-4" />
            AI providers
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {snap.ai.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              No AI traffic in the last 5m.
            </div>
          ) : (
            snap.ai.map((row, i) => (
              <DetailRow
                key={i}
                k={`${row.labels.provider ?? "—"} / ${row.labels.op ?? "—"}`}
                v={formatPercent(row.value)}
                tone={
                  row.value > 0.2
                    ? "bad"
                    : row.value > 0.05
                    ? "warn"
                    : "ok"
                }
              />
            ))
          )}
          <InlineSparkline metric="ai.errorRatio" range={range} />
        </CardContent>
      </Card>
    </div>
  );
}

function BigStat({ value, caption }: { value: string; caption?: string }) {
  return (
    <div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      {caption && (
        <div className="text-xs text-muted-foreground">{caption}</div>
      )}
    </div>
  );
}

// ---------- SLO row --------------------------------------------- //

function SLORow({ snap, range }: { snap: Snapshot; range: RangeMinutes }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4" />
            Per-tier 5xx ratio (5m)
          </CardTitle>
          <CardDescription className="text-xs">
            Same series the fast-burn alert reads. Read vs write
            available in the trend explorer below.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {snap.tenant.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              No tenant traffic recorded yet.
            </div>
          ) : (
            snap.tenant.map((row, i) => (
              <div key={i} className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase text-muted-foreground">
                    {row.labels.tier ?? "—"}
                  </span>
                  <span
                    className={`tabular-nums text-sm ${toneTextClass(
                      row.value > 14.4 * 0.005
                        ? "bad"
                        : row.value > 6 * 0.005
                        ? "warn"
                        : "ok",
                    )}`}
                  >
                    {formatPercent(row.value)}
                  </span>
                </div>
                <Progress
                  value={Math.min(100, (row.value / 0.05) * 100)}
                  className={
                    row.value > 14.4 * 0.005
                      ? "[&>div]:bg-rose-500"
                      : row.value > 6 * 0.005
                      ? "[&>div]:bg-amber-500"
                      : "[&>div]:bg-emerald-500"
                  }
                />
              </div>
            ))
          )}
          <Separator className="my-2" />
          <InlineSparkline
            metric="tenant.errorRatio.5m"
            range={range}
            label="Trend"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Gauge className="h-4 w-4" />
            Error budget remaining (28d)
          </CardTitle>
          <CardDescription className="text-xs">
            Negative = budget overspent. Forecast comes from
            <code className="mx-1 rounded bg-muted px-1 py-0.5">
              predict_linear
            </code>
            in the recording rules.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <InlineSparkline
            metric="errorBudget.remaining.28d"
            range={range}
            tall
          />
          <p className="text-xs text-muted-foreground">
            Each line is one tier. The
            <code className="mx-1 rounded bg-muted px-1 py-0.5">
              FormlyErrorBudgetExhaustionForecast
            </code>
            alert pages when the predicted exhaustion is under 7
            days.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- Auth row -------------------------------------------- //

function AuthRow({ snap }: { snap: Snapshot }) {
  return (
    <Card>
      <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
        <AuthStat
          label="Login failures"
          value={`${formatNumber(snap.auth.loginFailRate)} /s`}
          tone={snap.auth.loginFailRate > 1 ? "warn" : "ok"}
        />
        <AuthStat
          label="Login successes"
          value={`${formatNumber(snap.auth.loginSuccessRate)} /s`}
        />
        <AuthStat
          label="MFA verify failures"
          value={`${formatNumber(snap.auth.mfaFailRate)} /s`}
          tone={snap.auth.mfaFailRate > 0.2 ? "warn" : "ok"}
        />
        <AuthStat
          label="API key abuse"
          value={`${formatNumber(snap.auth.apiKeyAbuseRate)} /s`}
          tone={snap.auth.apiKeyAbuseRate > 0.1 ? "bad" : "ok"}
        />
        <AuthStat
          label="429 rate-limit hits"
          value={`${formatNumber(snap.auth.rateLimit429Rate)} /s`}
          tone={snap.auth.rateLimit429Rate > 0.5 ? "warn" : "ok"}
        />
      </CardContent>
    </Card>
  );
}

function AuthStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: Tone;
}) {
  return (
    <div className="space-y-1 rounded-md border bg-muted/20 p-2.5">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        {tone && <ToneDot tone={tone} />}
        {label}
      </div>
      <div
        className={`text-base font-semibold tabular-nums ${toneTextClass(tone)}`}
      >
        {value}
      </div>
    </div>
  );
}

// ---------- Build versions -------------------------------------- //

function BuildVersionRow({ build }: { build: Record<string, string>[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Clock className="h-4 w-4" />
          Running versions
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2 text-xs">
          {build.map((b, i) => (
            <Badge key={i} variant="outline" className="font-mono">
              {b.process}@{b.version}{" "}
              <span className="opacity-60">
                ({(b.commit ?? "").slice(0, 7)})
              </span>
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- Trend explorer -------------------------------------- //

function SparklineExplorer({ range }: { range: RangeMinutes }) {
  const options: { key: SeriesMetric; label: string; group: string }[] = useMemo(
    () => [
      { key: "http.rps", label: "HTTP rps", group: "HTTP" },
      { key: "http.errorRatio", label: "5xx ratio", group: "HTTP" },
      { key: "http.p95Latency", label: "p95 latency", group: "HTTP" },
      { key: "queue.rate", label: "Tasks /s", group: "Queue" },
      { key: "queue.fails", label: "Failures /s", group: "Queue" },
      { key: "dbPool.utilization", label: "DB pool", group: "DB" },
      { key: "tenant.errorRatio.5m", label: "All tiers", group: "Tenant" },
      { key: "tenant.errorRatio.read.5m", label: "Reads", group: "Tenant" },
      { key: "tenant.errorRatio.write.5m", label: "Writes", group: "Tenant" },
      {
        key: "errorBudget.remaining.28d",
        label: "Budget 28d",
        group: "Tenant",
      },
      { key: "auth.failRate", label: "Auth fails /s", group: "Auth" },
      { key: "auth.rateLimit429", label: "429 hits", group: "Auth" },
      { key: "webhook.failRatio", label: "Failure ratio", group: "Webhook" },
      { key: "ai.errorRatio", label: "Error ratio", group: "AI" },
      {
        key: "cardinality.activeSeries",
        label: "Top-10 cardinality",
        group: "Meta",
      },
    ],
    [],
  );
  const groups = useMemo(() => {
    const out = new Map<string, typeof options>();
    for (const o of options) {
      if (!out.has(o.group)) out.set(o.group, []);
      out.get(o.group)!.push(o);
    }
    return out;
  }, [options]);
  const [metric, setMetric] = useState<SeriesMetric>("http.rps");
  const [series, setSeries] = useState<Series[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchSeries(metric, range)
      .then((res) => {
        if (cancelled) return;
        setSeries(res.series);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [metric, range]);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {[...groups.entries()].map(([group, opts]) => (
          <div key={group} className="flex flex-wrap items-center gap-1.5">
            <span className="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {group}
            </span>
            {opts.map((o) => (
              <Button
                key={o.key}
                size="sm"
                variant={metric === o.key ? "default" : "outline"}
                className="h-7 text-xs"
                onClick={() => setMetric(o.key)}
              >
                {o.label}
              </Button>
            ))}
          </div>
        ))}
      </div>
      {error && (
        <div className="rounded-md border border-rose-300/60 bg-rose-50/50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">
          {error}
        </div>
      )}
      {loading && !series.length && (
        <div className="h-32 animate-pulse rounded-md border bg-muted/30" />
      )}
      {!loading && series.length === 0 && !error && (
        <div className="rounded-md border bg-muted/20 p-6 text-center text-xs text-muted-foreground">
          No samples yet for this metric in the selected window.
        </div>
      )}
      <div className="space-y-1">
        {series.map((s, i) => (
          <SparklineRow key={i} s={s} />
        ))}
      </div>
    </div>
  );
}

// ---------- Sparkline drawing ----------------------------------- //

function InlineSparkline({
  metric,
  range,
  tone,
  label,
  tall,
}: {
  metric: SeriesMetric;
  range: RangeMinutes;
  tone?: Tone;
  label?: string;
  tall?: boolean;
}) {
  const [series, setSeries] = useState<Series[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    fetchSeries(metric, range)
      .then((res) => {
        if (cancelled) return;
        setSeries(res.series);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setSeries([]);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [metric, range]);

  const h = tall ? 96 : 36;

  if (!loaded) {
    return (
      <div
        className="animate-pulse rounded-md bg-muted/40"
        style={{ height: h }}
      />
    );
  }
  if (series.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-md border bg-muted/20 text-[10px] text-muted-foreground"
        style={{ height: h }}
      >
        no data yet
      </div>
    );
  }
  // Combined sparkline: overlay every series in the result onto a
  // shared SVG. Picks the global min/max so multi-tier views (e.g.
  // budget remaining per tier) compare apples-to-apples.
  return (
    <SparklineSVG
      series={series}
      tone={tone}
      label={label}
      height={h}
    />
  );
}

function SparklineSVG({
  series,
  tone,
  label,
  height = 36,
}: {
  series: Series[];
  tone?: Tone;
  label?: string;
  height?: number;
}) {
  const w = 360;
  const h = height;
  const allPts = series.flatMap((s) => s.values);
  if (allPts.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-md border bg-muted/20 text-[10px] text-muted-foreground"
        style={{ height: h }}
      >
        no data
      </div>
    );
  }
  const minT = Math.min(...allPts.map((p) => p.t));
  const maxT = Math.max(...allPts.map((p) => p.t));
  const span = Math.max(maxT - minT, 1);
  const minV = Math.min(...allPts.map((p) => p.v));
  const maxV = Math.max(...allPts.map((p) => p.v));
  const vSpan = Math.max(maxV - minV, 1e-9);

  const colorPalette = [
    "stroke-blue-500",
    "stroke-emerald-500",
    "stroke-violet-500",
    "stroke-amber-500",
    "stroke-rose-500",
    "stroke-cyan-500",
    "stroke-fuchsia-500",
  ];

  // Tone overrides the palette for single-series KPI sparklines so
  // a "bad" KPI (red value above) gets a red sparkline below.
  const toneStroke =
    tone === "bad"
      ? "stroke-rose-500"
      : tone === "warn"
      ? "stroke-amber-500"
      : tone === "ok"
      ? "stroke-emerald-500"
      : null;

  // First / last delta arrow for single-series KPIs.
  let trend: "up" | "down" | "flat" | null = null;
  if (series.length === 1 && series[0].values.length >= 2) {
    const first = series[0].values[0].v;
    const last = series[0].values[series[0].values.length - 1].v;
    const diff = last - first;
    const rel = Math.abs(diff) / Math.max(Math.abs(first), 1e-9);
    if (rel < 0.02) trend = "flat";
    else trend = diff > 0 ? "up" : "down";
  }

  return (
    <div className="relative w-full">
      {label && (
        <div className="absolute left-1 top-1 z-10 rounded bg-background/70 px-1 text-[10px] font-medium text-muted-foreground backdrop-blur">
          {label}
        </div>
      )}
      {trend && (
        <div className="absolute right-1 top-1 z-10 rounded bg-background/70 px-1 text-[10px] text-muted-foreground backdrop-blur">
          {trend === "up" && (
            <ArrowUpRight className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
          )}
          {trend === "down" && (
            <ArrowDownRight className="h-3 w-3 text-rose-600 dark:text-rose-400" />
          )}
          {trend === "flat" && (
            <Minus className="h-3 w-3 text-muted-foreground" />
          )}
        </div>
      )}
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="block w-full rounded-md border bg-muted/20"
        style={{ height: h }}
      >
        {/* baseline grid */}
        <line
          x1={0}
          y1={h - 0.5}
          x2={w}
          y2={h - 0.5}
          className="stroke-border"
          strokeWidth={1}
        />
        {series.map((s, i) => {
          const stroke =
            toneStroke || colorPalette[i % colorPalette.length];
          if (s.values.length === 0) return null;
          const path = s.values
            .map((p, j) => {
              const x = ((p.t - minT) / span) * w;
              const y = h - ((p.v - minV) / vSpan) * (h - 6) - 3;
              return `${j === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
            })
            .join(" ");
          return (
            <g key={i}>
              {/* fill area for single-series KPI sparklines */}
              {series.length === 1 && (
                <path
                  d={`${path} L${w},${h} L0,${h} Z`}
                  className={
                    tone === "bad"
                      ? "fill-rose-500/10"
                      : tone === "warn"
                      ? "fill-amber-500/10"
                      : tone === "ok"
                      ? "fill-emerald-500/10"
                      : "fill-blue-500/10"
                  }
                />
              )}
              <path
                d={path}
                fill="none"
                strokeWidth={1.6}
                strokeLinejoin="round"
                strokeLinecap="round"
                className={stroke}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function SparklineRow({ s }: { s: Series }) {
  const last = s.values.length ? s.values[s.values.length - 1].v : NaN;
  const labelStr = formatLabels(s.metric);
  return (
    <div className="flex items-center gap-2 text-xs">
      <div
        className="w-44 truncate text-muted-foreground"
        title={labelStr}
      >
        {labelStr || "—"}
      </div>
      <div className="flex-1">
        <SparklineSVG series={[s]} height={36} />
      </div>
      <div className="w-20 text-right tabular-nums">
        {Number.isFinite(last) ? formatNumber(last) : "—"}
      </div>
    </div>
  );
}

// ---------- detail rows / shared bits --------------------------- //

function DetailRow({ k, v, tone }: { k: string; v: string; tone?: Tone }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{k}</span>
      <span className={`tabular-nums text-sm ${toneTextClass(tone)}`}>
        {v}
      </span>
    </div>
  );
}

function UnconfiguredCard() {
  return (
    <Card className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4" />
          Live data — not configured
        </CardTitle>
        <CardDescription>
          Set <code className="rounded bg-muted px-1">PROMETHEUS_URL</code>{" "}
          (and optionally <code className="rounded bg-muted px-1">PROMETHEUS_USER</code>
          {" / "}
          <code className="rounded bg-muted px-1">PROMETHEUS_PASSWORD</code>)
          on the API process to enable the live panels here. The static
          reference below works without it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="rounded-md border bg-muted/30 p-3 text-xs">
          <div className="mb-1 font-medium">Quick start (dev)</div>
          <ol className="ml-4 list-decimal space-y-1 text-muted-foreground">
            <li>
              <code className="rounded bg-background px-1">
                docker compose -f infra/docker-compose.yml up -d prometheus
              </code>
            </li>
            <li>
              Set{" "}
              <code className="rounded bg-background px-1">
                PROMETHEUS_URL=http://localhost:9091
              </code>{" "}
              in <code className="rounded bg-background px-1">api/.env</code>
            </li>
            <li>Restart the API process so it picks up the new env</li>
            <li>
              Verify at{" "}
              <code className="rounded bg-background px-1">
                http://localhost:9091/targets
              </code>{" "}
              — both jobs should be UP
            </li>
          </ol>
        </div>
      </CardContent>
    </Card>
  );
}

function NoTargetsHint() {
  return (
    <Card className="border-amber-300/70 bg-amber-50/40 dark:border-amber-900/60 dark:bg-amber-950/20">
      <CardContent className="flex items-start gap-2 p-3 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600 dark:text-amber-400" />
        <div className="space-y-1">
          <div className="font-medium">
            Connected to Prometheus but no scrape targets reported
          </div>
          <p className="text-xs text-muted-foreground">
            Either Prometheus has just started (give it a scrape
            interval to populate), or
            <code className="mx-1 rounded bg-muted px-1">prometheus.yml</code>
            isn't pointing at the API/worker. Confirm at
            <code className="mx-1 rounded bg-muted px-1">
              http://localhost:9091/targets
            </code>
            .
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- formatters / helpers -------------------------------- //

function toneTextClass(tone?: Tone): string {
  return tone === "bad"
    ? "text-rose-700 dark:text-rose-400"
    : tone === "warn"
    ? "text-amber-700 dark:text-amber-400"
    : tone === "ok"
    ? "text-emerald-700 dark:text-emerald-400"
    : "text-foreground";
}

function formatLabels(m: Record<string, string>): string {
  const entries = Object.entries(m);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  if (n === 0) return "0";
  return n.toFixed(3);
}

function formatNumberSafe(n: number): string {
  return Number.isFinite(n) ? formatNumber(n) : "—";
}

function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(2)}%`;
}

function formatSeconds(s: number): string {
  if (!Number.isFinite(s)) return "—";
  if (s < 1) return `${(s * 1000).toFixed(0)}ms`;
  return `${s.toFixed(2)}s`;
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function fieldErr(snap: Snapshot, key: string): string | null {
  return snap.errors?.[key] ?? null;
}
