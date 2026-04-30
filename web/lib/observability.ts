// Typed wrappers around /v1/admin/observability/*. Kept separate
// from the larger lib/api.ts so the surface for super-admin pages
// can evolve without touching the everyday client.
//
// Both endpoints are super-admin gated server-side and 503 when
// PROMETHEUS_URL isn't configured — callers should inspect
// `errors[fieldKey]` on the snapshot response and the `code` on a
// thrown ApiError (`prom_unconfigured` / `unknown_metric` /
// `prom_query_failed`) before painting partial state.

import { api, ApiError } from "@/lib/api";

export type Snapshot = {
  generatedAt: string;
  http: {
    rps: number;
    errorRatio: number;
    p95Latency: number;
    inFlight: number;
  };
  dbPool: {
    utilization: number;
    acquired: number;
    max: number;
  };
  queue: {
    tasksPerSec: number;
    failRatio: number;
    inFlight: number;
  };
  ai: LabeledNumber[];
  webhook: {
    failRatio: number;
    rate: number;
  };
  tenant: LabeledNumber[];
  auth: {
    loginFailRate: number;
    loginSuccessRate: number;
    mfaFailRate: number;
    apiKeyAbuseRate: number;
    rateLimit429Rate: number;
  };
  build: Record<string, string>[];
  errors?: Record<string, string>;
};

export type LabeledNumber = {
  labels: Record<string, string>;
  value: number;
};

export type Series = {
  metric: Record<string, string>;
  values: { t: number; v: number }[];
};

export type SeriesResponse = {
  metric: string;
  minutes: number;
  series: Series[];
  generatedAt: string;
};

// The set of metric keys the backend allowlists. Mirrored from
// internal/promquery/handler.go's seriesAllowlist; if the backend
// list grows, add entries here too — TS will surface a compile
// error in the dashboard if the two drift.
export type SeriesMetric =
  | "http.rps"
  | "http.errorRatio"
  | "http.p95Latency"
  | "queue.rate"
  | "queue.fails"
  | "dbPool.utilization"
  | "tenant.errorRatio.5m"
  | "auth.failRate"
  | "auth.rateLimit429"
  | "webhook.failRatio"
  | "ai.errorRatio"
  // Tier 4 — read/write SLO split, 28d budget, cardinality watchdog.
  | "tenant.errorRatio.read.5m"
  | "tenant.errorRatio.write.5m"
  | "errorBudget.remaining.28d"
  | "cardinality.activeSeries";

export async function fetchSnapshot(): Promise<Snapshot> {
  return api<Snapshot>("/v1/admin/observability/snapshot");
}

export async function fetchSeries(
  metric: SeriesMetric,
  minutes = 60,
): Promise<SeriesResponse> {
  const qs = new URLSearchParams({
    metric,
    minutes: String(minutes),
  });
  return api<SeriesResponse>(`/v1/admin/observability/series?${qs}`);
}

// Target / Alert wire shapes. Mirrors api/internal/promquery —
// the backend already filters down to the fields the UI needs, so
// we don't have to chase Prometheus's full schema.
export type Target = {
  job: string;
  endpoint: string;
  health: "up" | "down" | "unknown" | string;
  lastError?: string;
  lastScrape: string; // ISO8601
  labels?: Record<string, string>;
};

export type TargetsResponse = {
  targets: Target[];
  generatedAt: string;
};

export type Alert = {
  name: string;
  state: "firing" | "pending" | "inactive" | string;
  severity?: "page" | "ticket" | string;
  summary?: string;
  description?: string;
  runbook?: string;
  value?: string;
  activeAt: string;
  labels?: Record<string, string>;
};

export type AlertsResponse = {
  alerts: Alert[];
  generatedAt: string;
};

export async function fetchTargets(): Promise<TargetsResponse> {
  return api<TargetsResponse>("/v1/admin/observability/targets");
}

export async function fetchAlerts(): Promise<AlertsResponse> {
  return api<AlertsResponse>("/v1/admin/observability/alerts");
}

// Infrastructure health — Prometheus + Alertmanager + Tempo.
// Each component reports `configured` (env wired up) and
// `healthy` (probe succeeded). UI renders unwired components as a
// neutral "not configured" pill rather than red.
export type InfraComponent = {
  name: string; // "prometheus" | "alertmanager" | "tempo"
  configured: boolean;
  healthy: boolean;
  url?: string;
  detail?: string;
};

export type InfraResponse = {
  generatedAt: string;
  components: InfraComponent[];
};

export async function fetchInfra(): Promise<InfraResponse> {
  return api<InfraResponse>("/v1/admin/observability/infra");
}

// isPromUnconfigured lets the dashboard distinguish "Prometheus
// isn't wired up on this deployment" (= hide the live panels and
// show a configure-me hint) from a real backend failure (= show
// the error to the operator).
export function isPromUnconfigured(e: unknown): boolean {
  return e instanceof ApiError && e.code === "prom_unconfigured";
}
