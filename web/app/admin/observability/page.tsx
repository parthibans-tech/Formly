"use client";

// Super-admin observability page: a static directory of the
// platform-level telemetry surfaces. We don't render the metrics
// inline (Prometheus is a far better viewer than anything we'd ship
// here) — we describe what's exposed, where, and how to scrape it,
// so an operator stitching up Grafana doesn't have to hunt through
// docs or env files.
//
// All info on this page is static configuration that's safe to ship
// to the browser: endpoint paths, env-var names, and the canonical
// PromQL starters. Credentials live on the API process, not here.

import {
  AlertTriangle,
  BookOpen,
  Cog,
  Gauge,
  KeyRound,
  LineChart,
  Server,
  Workflow,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { LiveDashboard } from "./LiveDashboard";

// Readable endpoint URLs come from the public site origin so a
// production operator copy-pasting from this page lands on the right
// host. Falls back to the runtime origin when the env var isn't set.
function apiOrigin(): string {
  if (typeof window === "undefined") return "";
  return (
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ||
    window.location.origin
  );
}

export default function ObservabilityPage() {
  const origin = apiOrigin();

  return (
    <>
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Gauge className="h-6 w-6" />
          Observability
        </h1>
        <p className="text-sm text-muted-foreground">
          Where Prometheus scrapes, what it sees, and how to wire up
          dashboards + alerts. Read-only — actual config lives in
          <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">
            infra/prometheus/
          </code>
          and the API/worker env.
        </p>
      </div>

      {/* Live, Prometheus-fed panels. Hidden when PROMETHEUS_URL is
          unset — the static reference below still renders. */}
      <LiveDashboard />

      {/* Endpoints */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="h-4 w-4" />
            Scrape endpoints
          </CardTitle>
          <CardDescription>
            Both processes expose <code>/metrics</code> in Prometheus
            text exposition format. Auth is basic-auth in production
            and loopback-only when env credentials are unset.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <EndpointRow
            label="API"
            url={`${origin}/metrics`}
            note="Mounted on the public API router; goes through the same TLS / proxy."
          />
          <EndpointRow
            label="Worker"
            url="http://worker.internal:9090/metrics"
            note="Dedicated listener (asynq has no HTTP surface). Override port via WORKER_METRICS_ADDR."
          />
          <Separator />
          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
              <KeyRound className="h-3.5 w-3.5" />
              Auth
            </div>
            Set{" "}
            <code className="rounded bg-background px-1 py-0.5">
              METRICS_BASIC_AUTH_USER
            </code>{" "}
            and{" "}
            <code className="rounded bg-background px-1 py-0.5">
              METRICS_BASIC_AUTH_PASSWORD
            </code>{" "}
            on both the API and worker processes. When unset, the
            handler accepts only loopback callers (
            <code>127.0.0.0/8</code>, <code>::1</code>, unix sockets) —
            useful for dev, never publish to the internet without
            credentials.
          </div>
        </CardContent>
      </Card>

      {/* Series shape */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <LineChart className="h-4 w-4" />
            Series exposed
          </CardTitle>
          <CardDescription>
            Cardinality is bounded: <code>route</code> is the chi
            pattern (so a million file IDs collapse to one series),{" "}
            <code>code</code> is bucketed to 2xx/3xx/4xx/5xx, and{" "}
            <code>/healthz</code>/<code>/metrics</code> are excluded.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Metric</th>
                <th className="py-2 pr-3 font-medium">Type</th>
                <th className="py-2 font-medium">Labels</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              <SeriesRow
                name="formly_http_requests_total"
                type="counter"
                labels="method, route, code"
              />
              <SeriesRow
                name="formly_http_request_duration_seconds"
                type="histogram"
                labels="method, route"
              />
              <SeriesRow
                name="formly_http_requests_in_flight"
                type="gauge"
                labels="—"
              />
              <SeriesRow
                name="formly_http_response_size_bytes"
                type="histogram"
                labels="method, route"
              />
              <SeriesRow
                name="formly_build_info"
                type="gauge"
                labels="process, version, commit, go_version"
              />
              <SeriesRow
                name="formly_db_pool_connections"
                type="gauge"
                labels="state (acquired/idle/total/max)"
              />
              <SeriesRow
                name="formly_queue_tasks_total"
                type="counter"
                labels="queue, task, result"
              />
              <SeriesRow
                name="formly_queue_task_duration_seconds"
                type="histogram"
                labels="queue, task"
              />
              <SeriesRow
                name="formly_queue_tasks_in_flight"
                type="gauge"
                labels="queue"
              />
              <SeriesRow
                name="formly_webhook_deliveries_total"
                type="counter"
                labels="result"
              />
              <SeriesRow
                name="formly_webhook_delivery_duration_seconds"
                type="histogram"
                labels="result"
              />
              <SeriesRow
                name="formly_mail_sent_total"
                type="counter"
                labels="kind, provider, result"
              />
              <SeriesRow
                name="formly_ai_requests_total"
                type="counter"
                labels="provider, op, result"
              />
              <SeriesRow
                name="formly_ai_request_duration_seconds"
                type="histogram"
                labels="provider, op"
              />
              <SeriesRow
                name="formly_ai_tokens_total"
                type="counter"
                labels="provider, op, kind"
              />
              <SeriesRow
                name="formly_tenant_requests_total"
                type="counter"
                labels="tier, code"
              />
              <SeriesRow
                name="formly_auth_attempts_total"
                type="counter"
                labels="kind, result"
              />
              <SeriesRow
                name="formly_auth_apikey_attempts_total"
                type="counter"
                labels="result"
              />
              <SeriesRow
                name="formly_security_rate_limit_hits_total"
                type="counter"
                labels="bucket"
              />
              <SeriesRow
                name="formly_cron_last_run_timestamp_seconds"
                type="gauge"
                labels="name"
              />
              <SeriesRow
                name="go_*"
                type="various"
                labels="standard Go runtime collectors"
              />
              <SeriesRow
                name="formly_process_*"
                type="various"
                labels="standard process collector (FDs, RSS, CPU)"
              />
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Rules */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Workflow className="h-4 w-4" />
              Recording rules
            </CardTitle>
            <CardDescription>
              Pre-computed in{" "}
              <code>infra/prometheus/recording.rules.yml</code>.
              Naming follows <code>level:metric:operation</code>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              <RuleRow name="route:formly_http_requests:rate5m" />
              <RuleRow name="route:formly_http_requests_5xx:rate5m" />
              <RuleRow name="route:formly_http_error_ratio:rate5m" />
              <RuleRow name="route:formly_http_request_duration_seconds:p50" />
              <RuleRow name="route:formly_http_request_duration_seconds:p95" />
              <RuleRow name="route:formly_http_request_duration_seconds:p99" />
              <RuleRow name="route:formly_http_availability:ratio1h" />
              <RuleRow name="task:formly_queue_tasks:rate5m" />
              <RuleRow name="task:formly_queue_error_ratio:rate5m" />
              <RuleRow name="task:formly_queue_task_duration_seconds:p95" />
              <RuleRow name="process:formly_db_pool_utilization:ratio" />
              <RuleRow name="webhook:formly_webhook_failure_ratio:rate5m" />
              <RuleRow name="kind:formly_mail_failed:rate5m" />
              <RuleRow name="provider:formly_ai_error_ratio:rate5m" />
              <RuleRow name="provider:formly_ai_request_duration_seconds:p95" />
              <RuleRow name="tier:formly_tenant_error_ratio:rate5m" />
              <RuleRow name="tier:formly_tenant_error_ratio:rate30m" />
              <RuleRow name="tier:formly_tenant_error_ratio:rate1h" />
              <RuleRow name="tier:formly_tenant_error_ratio:rate6h" />
              <RuleRow name="tier:formly_tenant_requests:rate5m" />
              <RuleRow name="kind:formly_auth_failure_ratio:rate5m" />
              <RuleRow name="formly_apikey_abuse:rate5m" />
              <RuleRow name="bucket:formly_rate_limit_hits:rate5m" />
              <RuleRow name="tier_kind:formly_tenant_error_ratio:rate5m" />
              <RuleRow name="tier_kind:formly_tenant_error_ratio:rate1h" />
              <RuleRow name="tier_kind:formly_tenant_requests:rate5m" />
              <RuleRow name="tier:formly_tenant_error_ratio:avg28d" />
              <RuleRow name="tier:formly_error_budget_remaining:ratio28d" />
              <RuleRow name="tier:formly_error_budget_exhaustion_seconds:predict6h" />
              <RuleRow name="metric:formly_series_count:active" />
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              Alerts
            </CardTitle>
            <CardDescription>
              Defined in{" "}
              <code>infra/prometheus/alerts.rules.yml</code>. Severity
              <code className="mx-1">page</code> wakes someone up;
              <code className="mx-1">ticket</code> files during work
              hours.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              <AlertRow name="FormlyProcessDown" severity="page" />
              <AlertRow name="FormlyHighErrorRate" severity="page" />
              <AlertRow name="FormlyFDExhaustion" severity="page" />
              <AlertRow name="FormlyDBPoolNearExhaustion" severity="page" />
              <AlertRow name="FormlyBillingMailFailures" severity="page" />
              <AlertRow name="FormlyRouteErrorRate" severity="ticket" />
              <AlertRow name="FormlyHighP95Latency" severity="ticket" />
              <AlertRow name="FormlyHighInFlight" severity="ticket" />
              <AlertRow name="FormlyHighGCPause" severity="ticket" />
              <AlertRow name="FormlyBuildInfoMissing" severity="ticket" />
              <AlertRow name="FormlyDBPoolHigh" severity="ticket" />
              <AlertRow name="FormlyQueueTaskErrorRate" severity="ticket" />
              <AlertRow name="FormlyWorkerSaturated" severity="ticket" />
              <AlertRow name="FormlyWebhookHighFailureRate" severity="ticket" />
              <AlertRow name="FormlyMailFailureRate" severity="ticket" />
              <AlertRow name="FormlyAIProviderErrors" severity="ticket" />
              <AlertRow name="FormlyTenantSLOFastBurn" severity="page" />
              <AlertRow name="FormlyAPIKeyAbuseProbe" severity="page" />
              <AlertRow name="FormlyTenantWriteSLOFastBurn" severity="page" />
              <AlertRow name="FormlyCronSchedulesStuck" severity="page" />
              <AlertRow name="FormlyTenantSLOSlowBurn" severity="ticket" />
              <AlertRow name="FormlyAuthFailureSpike" severity="ticket" />
              <AlertRow name="FormlyMFAVerifyFailureSpike" severity="ticket" />
              <AlertRow name="FormlyRateLimitTripping" severity="ticket" />
              <AlertRow name="FormlyTenantReadSLOFastBurn" severity="ticket" />
              <AlertRow name="FormlyErrorBudgetExhausted" severity="ticket" />
              <AlertRow name="FormlyErrorBudgetExhaustionForecast" severity="ticket" />
              <AlertRow name="FormlyCronDunningStuck" severity="ticket" />
              <AlertRow name="FormlyMetricCardinalityHigh" severity="ticket" />
            </ul>
          </CardContent>
        </Card>
      </div>

      {/* PromQL starters */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BookOpen className="h-4 w-4" />
            PromQL starters
          </CardTitle>
          <CardDescription>
            Drop these into Grafana panel queries. The recorded series
            (above) are cheaper to render than re-computing.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <PromExample
            title="Global error rate"
            expr={`sum(rate(formly_http_requests_total{code="5xx"}[5m]))
  /
sum(rate(formly_http_requests_total[5m]))`}
          />
          <PromExample
            title="Top 10 slowest routes by p95"
            expr={`topk(10,
  route:formly_http_request_duration_seconds:p95
)`}
          />
          <PromExample
            title="Requests per second per process"
            expr={`sum by (process) (rate(formly_http_requests_total[1m]))`}
          />
          <PromExample
            title="Pin every chart to a release in the legend"
            expr={`sum(rate(formly_http_requests_total[5m]))
  * on() group_left(version) formly_build_info`}
          />
          <PromExample
            title="Per-tier 5xx ratio (Tier 2 SLO grain)"
            expr={`sum by (tier) (rate(formly_tenant_requests_total{code="5xx"}[5m]))
  /
sum by (tier) (rate(formly_tenant_requests_total[5m]))`}
          />
          <PromExample
            title="Failed login burst by kind"
            expr={`sum by (kind) (
  rate(formly_auth_attempts_total{result="failed"}[5m])
)`}
          />
          <PromExample
            title="Tier 4: 28d error budget remaining (per tier)"
            expr={`tier:formly_error_budget_remaining:ratio28d`}
          />
          <PromExample
            title="Tier 4: write-side error ratio per tier (5m)"
            expr={`tier_kind:formly_tenant_error_ratio:rate5m{kind="write"}`}
          />
          <PromExample
            title="Tier 4: top-10 metrics by active series (cardinality watchdog)"
            expr={`topk(10, metric:formly_series_count:active)`}
          />
          <PromExample
            title="Tier 4: cron heartbeat freshness (seconds since last run)"
            expr={`time() - max by (name) (formly_cron_last_run_timestamp_seconds)`}
          />
        </CardContent>
      </Card>

      {/* Runbook pointer */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Cog className="h-4 w-4" />
            Operator notes
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Adding a new metric? Declare the vector in{" "}
            <code>api/internal/metrics/metrics.go</code> so the
            registry stays the single declaration site, then have the
            owning package observe it.
          </p>
          <p>
            Cardinality &gt; usefulness: never label by{" "}
            <code>org_id</code>, <code>user_id</code>, or{" "}
            <code>file_id</code> — those go to the{" "}
            <code>request_metrics</code> rollup table (
            <code>/v1/ops/metrics</code>) which is built for high
            cardinality.
          </p>
          <p>
            Need to debug a scrape failure? Hit the endpoint from
            inside the cluster (<code>curl localhost:8080/metrics</code>{" "}
            on the API host) — loopback-only is the dev fallback even
            when basic-auth is configured for off-host scrapers.
          </p>
        </CardContent>
      </Card>
    </>
  );
}

function EndpointRow({
  label,
  url,
  note,
}: {
  label: string;
  url: string;
  note: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-card p-3 sm:flex-row sm:items-center sm:gap-3">
      <Badge variant="outline" className="w-fit text-[10px] uppercase">
        {label}
      </Badge>
      <code className="flex-1 truncate font-mono text-xs">{url}</code>
      <span className="text-xs text-muted-foreground">{note}</span>
    </div>
  );
}

function SeriesRow({
  name,
  type,
  labels,
}: {
  name: string;
  type: string;
  labels: string;
}) {
  return (
    <tr>
      <td className="py-2 pr-3 font-mono text-xs">{name}</td>
      <td className="py-2 pr-3 text-xs text-muted-foreground">{type}</td>
      <td className="py-2 text-xs text-muted-foreground">{labels}</td>
    </tr>
  );
}

function RuleRow({ name }: { name: string }) {
  return (
    <li className="font-mono text-xs">
      <span className="text-muted-foreground">→ </span>
      {name}
    </li>
  );
}

function AlertRow({
  name,
  severity,
}: {
  name: string;
  severity: "page" | "ticket";
}) {
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="font-mono text-xs">{name}</span>
      <Badge
        variant="outline"
        className={
          severity === "page"
            ? "border-rose-500/40 text-rose-700 text-[10px] uppercase"
            : "text-[10px] uppercase text-muted-foreground"
        }
      >
        {severity}
      </Badge>
    </li>
  );
}

function PromExample({ title, expr }: { title: string; expr: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">
        {title}
      </div>
      <pre className="overflow-x-auto rounded-md border bg-muted/30 p-3 font-mono text-xs">
        {expr}
      </pre>
    </div>
  );
}

