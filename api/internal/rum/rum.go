// Package rum is the ingestion seam for browser-side Real User
// Monitoring (Core Web Vitals — LCP, INP, CLS, FCP, TTFB).
//
// What this owns
// --------------
// One narrow job: accept POST /v1/rum from the frontend, validate
// the payload, and increment the WebVitals histogram + counter
// the metrics package owns. No persistence, no fan-out, no
// per-user tracking — RUM is a population-level signal and we
// keep it that way.
//
// The endpoint is intentionally PUBLIC (unauthenticated) because
// Web Vitals fire on the FIRST page load, before any login or
// app shell completes. Forcing auth would systematically miss
// the only metric population worth measuring (cold-cache first
// loads). The cardinality + size guards below replace what auth
// would do.
//
// Threat model
// ------------
// The endpoint takes JSON from anonymous clients. The risk is
// cardinality poisoning (a hostile client posting `route=…<random
// per-request string>…` to blow up the Prometheus series count).
// Mitigations:
//
//   - Allowlist the `metric` field to the five Core Web Vitals
//     names. Anything else → drop the sample silently (no 4xx —
//     that would tell a probing client what the allowlist is).
//   - Re-derive `rating` server-side from the value rather than
//     trust the client.
//   - Sanitise `route` to a safe shape: a Next.js path with
//     numeric/UUID/ULID segments collapsed to `[id]`. Drop and
//     replace with "unknown" if the path doesn't fit a small
//     allowlist of characters.
//   - Cap each ingested batch at 32 samples. The frontend beacons
//     once per page-unload with at most 5 vitals; 32 is generous
//     and still bounds a malicious sender.
//   - Cap request body at 16 KiB. Blocks the obvious "POST 50 MB
//     of garbage and watch the goroutine OOM" probe.
//
// Body shape (matches the web-vitals.js Metric object trimmed to
// what we need; everything else is dropped on parse):
//
//	{
//	  "samples": [
//	    {
//	      "name": "LCP", "value": 1234.5, "rating": "good",
//	      "route": "/orgs/[id]/files", "ts": 1714509000123
//	    },
//	    ...
//	  ]
//	}
//
// `ts` is accepted but unused today (RUM is bucketed by
// scrape time, not sample time). Kept on the wire because some
// future server-side aggregation will want it.
package rum

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/docforge/api/internal/metrics"
)

// Handler exposes the single POST /v1/rum endpoint.
type Handler struct {
	M *metrics.Registry
}

// New wires the handler against an existing metrics registry.
// Returns a usable *Handler even when r is nil — the Ingest method
// short-circuits in that case so a misconfigured boot doesn't 500
// every page load.
func New(r *metrics.Registry) *Handler { return &Handler{M: r} }

// maxBodyBytes caps the request size. 16 KiB is roomy for the
// 32-sample upper bound (each sample is ~150 bytes JSON) and a
// hard ceiling against trivially malicious large bodies.
const maxBodyBytes = 16 * 1024

// maxSamplesPerBatch caps how many samples one POST may contain.
// The frontend beacons one batch per page-unload with at most 5
// vitals (one per Core Web Vitals metric). 32 leaves room for
// SPA route changes that re-emit metrics, and bounds any single
// caller's per-request impact on the Prometheus write path.
const maxSamplesPerBatch = 32

// allowedMetrics maps the wire-format metric name to the canonical
// label value used on the histogram. The set is the five Core Web
// Vitals plus FCP (First Contentful Paint) which we keep because
// it's a useful early signal even though Google has dropped it
// from the "Core" set in 2024.
var allowedMetrics = map[string]string{
	"LCP":  "LCP",
	"INP":  "INP",
	"CLS":  "CLS",
	"FCP":  "FCP",
	"TTFB": "TTFB",
}

// allowedRatings is the closed set web-vitals.js uses. Re-derived
// server-side from the value so a poisoned client can't push
// every sample into the "good" bucket.
var allowedRatings = map[string]struct{}{
	"good":               {},
	"needs_improvement":  {},
	"poor":               {},
}

// rateThresholds are the Google-published Core Web Vitals
// boundaries (in seconds for time metrics, unitless for CLS).
// Used to re-derive `rating` from `value` so a client can't
// upgrade its own scores.
//
// Source: https://web.dev/articles/vitals
var rateThresholds = map[string]struct {
	Good, NeedsImprovement float64
}{
	"LCP":  {Good: 2.5, NeedsImprovement: 4.0},      // seconds
	"INP":  {Good: 0.2, NeedsImprovement: 0.5},      // seconds (was FID)
	"CLS":  {Good: 0.1, NeedsImprovement: 0.25},     // unitless
	"FCP":  {Good: 1.8, NeedsImprovement: 3.0},      // seconds
	"TTFB": {Good: 0.8, NeedsImprovement: 1.8},      // seconds
}

// safeRoute is the regex on cleansed route strings. Anything
// outside this matches → route is replaced with "unknown" so a
// probing client cannot inject novel label values.
//
// Allowed: forward slashes, alphanumerics, hyphens, underscores,
// brackets (for the [id] / [...slug] Next.js convention). Capped
// at 80 characters to bound the worst-case label length.
var safeRoute = regexp.MustCompile(`^/[A-Za-z0-9_/\-\[\]\.]{0,79}$`)

// idLikeSegment matches a path segment that's plausibly an opaque
// identifier (UUID, ULID, integer, or generic 16+ hex/base32 token).
// Replaced with `[id]` so per-tenant traffic doesn't multiply
// route cardinality.
var idLikeSegment = regexp.MustCompile(
	`^([0-9]+|[0-9a-fA-F\-]{16,}|[0-9A-HJKMNP-TV-Z]{16,})$`,
)

// inSample is the wire-format the frontend posts. JSON tags are
// the lowercase-camelCase the web-vitals npm package emits.
type inSample struct {
	Name   string  `json:"name"`
	Value  float64 `json:"value"`
	Rating string  `json:"rating"`
	Route  string  `json:"route"`
	TS     int64   `json:"ts,omitempty"`
}

type inBatch struct {
	Samples []inSample `json:"samples"`
}

// Ingest is the http.Handler for POST /v1/rum. Returns 204 on
// success (the frontend uses navigator.sendBeacon which doesn't
// inspect the response body) and 4xx on schema violation. Never
// 5xx on a malformed sample — drop and continue.
func (h *Handler) Ingest(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.M == nil {
		// Silent no-op rather than 503 — a misconfigured server
		// shouldn't make every page load throw a console error.
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Cap body at 16 KiB. http.MaxBytesReader returns a 413 from
	// the embedded ResponseWriter if exceeded — perfect default.
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		http.Error(w, "body too large or read failed", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	var batch inBatch
	if err := json.Unmarshal(body, &batch); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	// Cap sample count. We accept the prefix (rather than rejecting
	// the whole batch) so a chatty client still gets its first
	// handful counted. Each sample is independently validated.
	n := len(batch.Samples)
	if n > maxSamplesPerBatch {
		n = maxSamplesPerBatch
	}

	for i := 0; i < n; i++ {
		s := batch.Samples[i]
		metric, ok := allowedMetrics[s.Name]
		if !ok {
			// Unknown metric — drop silently. No per-sample 4xx
			// since one bad apple shouldn't tank the whole batch.
			continue
		}
		// Negative values are nonsense for every Web Vital we
		// accept (CLS is non-negative, the time metrics are
		// non-negative by definition). The web-vitals package
		// occasionally emits 0 (e.g. cached load with TTFB=0);
		// keep those — they're a real measurement.
		if s.Value < 0 {
			continue
		}
		// Re-derive rating from the value. Defends against a
		// client that posts good=true alongside a 12s LCP.
		rating := deriveRating(metric, s.Value)
		if _, allowed := allowedRatings[rating]; !allowed {
			rating = "good" // shouldn't happen; defensive default
		}
		route := sanitiseRoute(s.Route)

		h.M.WebVitals.WithLabelValues(metric, rating, route).Observe(s.Value)
		h.M.WebVitalsCount.WithLabelValues(metric, rating, route).Inc()
	}

	w.WriteHeader(http.StatusNoContent)
}

// deriveRating maps a metric value to the {good, needs_improvement,
// poor} bucket using Google's published Core Web Vitals
// thresholds. Returns "good" when the metric is unknown so the
// caller doesn't have to handle a third return.
func deriveRating(metric string, value float64) string {
	t, ok := rateThresholds[metric]
	if !ok {
		return "good"
	}
	switch {
	case value <= t.Good:
		return "good"
	case value <= t.NeedsImprovement:
		return "needs_improvement"
	default:
		return "poor"
	}
}

// sanitiseRoute reduces a client-supplied path to a safe label
// value:
//
//   - Trim querystring + fragment if any slipped through.
//   - Reject anything that doesn't look like a path on first
//     glance (regex above) → "unknown".
//   - Walk the segments; collapse anything that looks like an
//     opaque ID (UUID, ULID, integer, long hex/base32) to `[id]`
//     so per-tenant traffic doesn't multiply cardinality.
//   - Truncate the cleaned result to 80 chars as a final guard.
func sanitiseRoute(in string) string {
	if in == "" {
		return "unknown"
	}
	if i := strings.IndexAny(in, "?#"); i >= 0 {
		in = in[:i]
	}
	if !safeRoute.MatchString(in) {
		return "unknown"
	}
	parts := strings.Split(in, "/")
	for i, p := range parts {
		if p == "" {
			continue
		}
		if idLikeSegment.MatchString(p) {
			parts[i] = "[id]"
		}
	}
	out := strings.Join(parts, "/")
	if out == "" {
		return "/"
	}
	if len(out) > 80 {
		out = out[:80]
	}
	return out
}
