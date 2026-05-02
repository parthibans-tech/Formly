// Real User Monitoring — Core Web Vitals collector.
//
// What this does
// --------------
// Subscribes to the five Core Web Vitals (LCP, INP, CLS, FCP, TTFB)
// from the `web-vitals` package, batches the samples, and beacons
// them to POST /v1/rum on page-unload. The API increments a
// Prometheus histogram + counter labeled by {metric, rating, route};
// dashboards and alerts read those series.
//
// Why navigator.sendBeacon
// ------------------------
// Web Vitals like LCP and INP only finalise at page-unload (when the
// largest paint can no longer be replaced and the worst interaction
// is locked in). Sending via fetch() at that moment races the
// browser's tab teardown — the request often gets cancelled. The
// sendBeacon API is purpose-built for this case: the browser keeps
// the request alive across navigation and never blocks unload on it.
// Falls back to fetch with keepalive when sendBeacon isn't available.
//
// Why batched not per-metric
// --------------------------
// Five vitals × N route changes is at most a couple of dozen samples
// per session — well below sendBeacon's 64KB cap. One beacon is
// cheaper than five, and the API caps the batch at 32 samples
// regardless, so there's no benefit to fragmenting.
//
// Privacy
// -------
// We send only the metric name, value, the *server-derived* rating
// will replace whatever we send, and a sanitised route string (the
// API collapses /orgs/<uuid>/files → /orgs/[id]/files so per-tenant
// IDs never become Prometheus labels). No user IDs, no session IDs,
// no IP — RUM is a population-level signal, not per-user telemetry.

import { onLCP, onINP, onCLS, onFCP, onTTFB, type Metric } from "web-vitals";
import { API_URL } from "./api";

// Sample shape sent to the API. Mirrors the `inSample` Go struct in
// internal/rum/rum.go. Keep these field names lowerCamelCase JSON.
interface Sample {
  name: string;
  value: number;
  rating: string;
  route: string;
  ts: number;
}

// Module-scoped buffer — the page lives in one window so a singleton
// is fine. Cleared after each successful flush.
const buffer: Sample[] = [];

// Flush guard: once the unload handlers have fired we shouldn't keep
// queueing samples (they'd never be sent and would leak across SPA
// navigations that don't fully reload). Idempotent.
let drained = false;

// One-shot install guard. The collector only needs to register its
// listeners once per browser tab; calling start() from a React effect
// that re-runs (StrictMode double-mount, route changes) must not
// re-attach the web-vitals observers because that would emit
// duplicate samples.
let started = false;

// Convert seconds vs milliseconds. web-vitals reports time metrics
// in milliseconds (LCP, INP, FCP, TTFB) and CLS as a unitless score.
// The API histogram is in seconds, so divide by 1000 for time
// metrics. CLS stays as-is.
function toServerValue(name: string, raw: number): number {
  if (name === "CLS") return raw;
  return raw / 1000;
}

// Best-effort current-route extraction. window.location.pathname is
// the right answer in the Pages Router; in the App Router it's still
// authoritative because the rewrites happen server-side and the
// browser sees the post-rewrite path. The API re-sanitises so we
// don't bother stripping query/hash here.
function currentRoute(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname || "";
}

function enqueue(metric: Metric) {
  if (drained) return;
  buffer.push({
    name: metric.name,
    value: toServerValue(metric.name, metric.value),
    // The API re-derives rating from the value — we send the
    // client's own assessment for completeness but the server-side
    // value is what lands on the histogram label. See deriveRating
    // in internal/rum/rum.go.
    rating: metric.rating || "good",
    route: currentRoute(),
    ts: Date.now(),
  });
}

// Flush the buffer. Called on `pagehide` / `visibilitychange→hidden`
// — the two events that reliably fire as a tab is going away
// (`beforeunload` is unreliable on mobile Safari).
function flush() {
  if (drained) return;
  if (buffer.length === 0) return;
  // Snapshot + clear before send so a re-entrant flush (the rare
  // case where `pagehide` and `visibilitychange` both fire on the
  // same tick) doesn't double-post.
  const samples = buffer.splice(0, buffer.length);
  drained = true;

  const url = `${API_URL}/v1/rum`;
  const body = JSON.stringify({ samples });

  // sendBeacon is fire-and-forget: returns false only if the
  // browser refused to queue (size cap or quota), in which case we
  // fall back to a keepalive fetch so the request still survives
  // the unload.
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon(url, blob)) return;
  }

  // Fallback: keepalive lets the browser finish the request after
  // the page is gone. catch+swallow because there's nobody left to
  // surface the error to.
  try {
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // ignored — we tried
  }
}

// Public entry point. Called from a top-level <RUM /> client component
// in app/layout.tsx so it runs once per tab as soon as the React tree
// hydrates. SSR-safe: bails when window is undefined.
export function startRUM() {
  if (started) return;
  if (typeof window === "undefined") return;
  started = true;

  // Subscribe. web-vitals fires the callback once for the final
  // value of each metric per page (LCP/INP) and on each layout
  // shift / cumulative update (CLS). We just enqueue; flush happens
  // on unload.
  onLCP(enqueue);
  onINP(enqueue);
  onCLS(enqueue);
  onFCP(enqueue);
  onTTFB(enqueue);

  // pagehide is the most reliable cross-browser unload signal.
  // visibilitychange→hidden catches the case where the user
  // switches tabs and then closes the window without coming back
  // (pagehide may not fire on bfcache restore-and-discard paths).
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}
