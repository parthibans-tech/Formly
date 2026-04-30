// Package promquery is the Prometheus query seam for the super-admin
// observability UI.
//
// What lives here
// ---------------
// A minimal HTTP client that speaks the Prometheus HTTP API
// (`/api/v1/query` and `/api/v1/query_range`) plus a handler bundle
// that exposes a curated read-only surface to the web app:
//
//   - GET /v1/admin/observability/snapshot — one round-trip that
//     fans out to a small fixed set of instant queries and returns
//     the numbers the dashboard cards want (RPS, error ratio, p95,
//     pool utilization, queue throughput, AI provider error rate,
//     per-tier error budget burn, auth failure rate). Every query
//     is hardcoded — the browser does not get to send PromQL.
//
//   - GET /v1/admin/observability/series?metric=...&minutes=... —
//     a small whitelist of (metric → PromQL) shortcuts that return
//     a time series the UI can sparkline. The whitelist is the
//     access-control story: even a compromised super-admin session
//     can't pull out series we haven't pre-approved.
//
// Why a curated surface, not a generic /query proxy
// -------------------------------------------------
// Two reasons. First, exposing arbitrary PromQL to the web app
// means the auth boundary stops at "is this user a super-admin"
// — anyone who steals the JWT can issue
// `count by (org_id) (rate(...))` with any per-row label they like.
// We've spent two tiers stamping out high-cardinality labels; we're
// not going to undo that with a query proxy.
//
// Second, browsers shouldn't talk to Prometheus directly. Prometheus
// is auth-gated with basic-auth credentials that live on the API
// process, not on the operator's laptop. A backend proxy keeps the
// credentials server-side and gives us a place to enforce the
// super-admin gate in one spot.
//
// Configuration
// -------------
// Reads three env vars:
//
//   - PROMETHEUS_URL — the base URL (e.g. http://prom.internal:9090).
//     When unset the handler returns 503 prom_unconfigured rather
//     than wiring up a half-broken endpoint, so a fresh dev checkout
//     keeps working without a Prometheus server.
//   - PROMETHEUS_USER + PROMETHEUS_PASSWORD — optional basic auth.
//     Same gate the API's own /metrics endpoint uses.
//
// Failure mode is fail-soft: a query error returns nil + an error
// string in the snapshot's `errors` field rather than blowing up
// the whole response. Different cards on the dashboard fail
// independently — a single broken metric shouldn't black out the
// rest of the page.
package promquery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Client is the thin HTTP wrapper. Safe for concurrent use.
type Client struct {
	base string
	user string
	pass string
	hc   *http.Client
}

// New builds a Client from the supplied base URL + credentials.
// Returns nil when base is empty so callers can branch without
// nil-checking everywhere — handlers see "Prometheus disabled"
// and 503 cleanly.
func New(base, user, pass string) *Client {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		return nil
	}
	return &Client{
		base: base,
		user: user,
		pass: pass,
		hc: &http.Client{
			// 10s is generous for an instant query; the snapshot
			// handler runs ~10 of these in parallel and a hung
			// Prometheus shouldn't be allowed to wedge the whole
			// dashboard for a minute.
			Timeout: 10 * time.Second,
		},
	}
}

// BaseURL returns the configured Prometheus base URL — empty for
// a nil client. Used by the dashboard's infra-strip endpoint to
// echo the URL it's hitting; not for issuing PromQL.
func (c *Client) BaseURL() string {
	if c == nil {
		return ""
	}
	return c.base
}

// Sample is a single (timestamp, value) pair from a Prometheus
// scalar/instant result. We keep it shape-agnostic to the browser:
// the float arrives as float64, and NaN/Inf get stripped (the
// frontend's chart layer does not handle either gracefully).
type Sample struct {
	T float64 `json:"t"` // unix seconds
	V float64 `json:"v"`
}

// Series is one named time series — a label fingerprint plus the
// dense (t, v) samples for it. The Metric map is whatever
// Prometheus echoed back in `metric:` minus the synthetic
// `__name__` key (which only confuses the UI).
type Series struct {
	Metric map[string]string `json:"metric"`
	Values []Sample          `json:"values"`
}

// QueryInstant runs a single instant query against the Prometheus
// HTTP API and reduces the result to the sum of its samples — most
// of our snapshot queries are already aggregated to a scalar by the
// PromQL itself, but we tolerate vector-of-one results so a stray
// `sum by (...)` still works.
//
// Returns (value, true, nil) on success, (0, false, nil) when the
// query returned no samples (e.g. nothing has been scraped for the
// metric yet — this is normal on a freshly-booted process), and
// (0, false, err) on any transport / decode / Prometheus-level
// error. The boolean lets the UI distinguish "no data yet" from
// "the dashboard is broken."
func (c *Client) QueryInstant(ctx context.Context, q string) (float64, bool, error) {
	if c == nil {
		return 0, false, ErrUnconfigured
	}
	v := url.Values{}
	v.Set("query", q)
	body, err := c.doGet(ctx, "/api/v1/query", v)
	if err != nil {
		return 0, false, err
	}
	var resp struct {
		Status    string `json:"status"`
		ErrorType string `json:"errorType"`
		Error     string `json:"error"`
		Data      struct {
			ResultType string            `json:"resultType"`
			Result     json.RawMessage   `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return 0, false, fmt.Errorf("decode prometheus response: %w", err)
	}
	if resp.Status != "success" {
		return 0, false, fmt.Errorf("prometheus error: %s: %s", resp.ErrorType, resp.Error)
	}
	switch resp.Data.ResultType {
	case "scalar":
		// scalar shape: [<unix>, "<float-as-string>"]
		var raw []json.RawMessage
		if err := json.Unmarshal(resp.Data.Result, &raw); err != nil || len(raw) < 2 {
			return 0, false, fmt.Errorf("malformed scalar result")
		}
		var s string
		if err := json.Unmarshal(raw[1], &s); err != nil {
			return 0, false, fmt.Errorf("scalar value not a string: %w", err)
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return 0, false, fmt.Errorf("scalar value not numeric: %w", err)
		}
		return f, true, nil
	case "vector":
		// vector shape: [{ "metric": {...}, "value": [<unix>, "<float>"] }, ...]
		var rows []struct {
			Value [2]json.RawMessage `json:"value"`
		}
		if err := json.Unmarshal(resp.Data.Result, &rows); err != nil {
			return 0, false, fmt.Errorf("decode vector: %w", err)
		}
		if len(rows) == 0 {
			return 0, false, nil
		}
		// Sum the vector to a single number — the snapshot endpoint
		// only ever calls QueryInstant with already-aggregated
		// queries, so this is a defensive collapse for the case
		// where a query came back with two label sets that should
		// have been one.
		var total float64
		for _, r := range rows {
			var s string
			if err := json.Unmarshal(r.Value[1], &s); err != nil {
				continue
			}
			f, err := strconv.ParseFloat(s, 64)
			if err != nil {
				continue
			}
			total += f
		}
		return total, true, nil
	default:
		return 0, false, fmt.Errorf("unsupported result type: %s", resp.Data.ResultType)
	}
}

// QueryInstantVector runs an instant query and returns the per-label
// breakdown (rather than collapsing to a scalar). The dashboard uses
// this for "show me the error budget burn for every tier" where the
// dimension count is small (~6) and the frontend wants one number
// per label.
func (c *Client) QueryInstantVector(ctx context.Context, q string) ([]Series, error) {
	if c == nil {
		return nil, ErrUnconfigured
	}
	v := url.Values{}
	v.Set("query", q)
	body, err := c.doGet(ctx, "/api/v1/query", v)
	if err != nil {
		return nil, err
	}
	var resp struct {
		Status string `json:"status"`
		Error  string `json:"error"`
		Data   struct {
			ResultType string `json:"resultType"`
			Result     []struct {
				Metric map[string]string  `json:"metric"`
				Value  [2]json.RawMessage `json:"value"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("decode prometheus response: %w", err)
	}
	if resp.Status != "success" {
		return nil, fmt.Errorf("prometheus error: %s", resp.Error)
	}
	out := make([]Series, 0, len(resp.Data.Result))
	for _, r := range resp.Data.Result {
		// strip the synthetic name label so it doesn't pollute the
		// UI's label selector — the metric name is what we asked
		// for; we don't need to echo it back.
		labels := make(map[string]string, len(r.Metric))
		for k, v := range r.Metric {
			if k == "__name__" {
				continue
			}
			labels[k] = v
		}
		var t float64
		_ = json.Unmarshal(r.Value[0], &t)
		var s string
		_ = json.Unmarshal(r.Value[1], &s)
		f, _ := strconv.ParseFloat(s, 64)
		out = append(out, Series{
			Metric: labels,
			Values: []Sample{{T: t, V: f}},
		})
	}
	return out, nil
}

// QueryRange runs a Prometheus range query and returns one Series
// per result row. The UI sparklines call this once per metric on
// page load (and on any explicit refresh). Step is computed from
// the requested duration so a "last 1h" view ends up with ~60
// points (good resolution; cheap to render).
func (c *Client) QueryRange(ctx context.Context, q string, dur time.Duration) ([]Series, error) {
	if c == nil {
		return nil, ErrUnconfigured
	}
	now := time.Now()
	step := dur / 60
	// Floor the step so a 5m window doesn't round to 5s — Prometheus
	// chokes on sub-second steps for histogram_quantile() over a
	// rate(), and it doesn't help the chart anyway.
	if step < 15*time.Second {
		step = 15 * time.Second
	}
	v := url.Values{}
	v.Set("query", q)
	v.Set("start", strconv.FormatInt(now.Add(-dur).Unix(), 10))
	v.Set("end", strconv.FormatInt(now.Unix(), 10))
	v.Set("step", strconv.Itoa(int(step.Seconds())))

	body, err := c.doGet(ctx, "/api/v1/query_range", v)
	if err != nil {
		return nil, err
	}
	var resp struct {
		Status string `json:"status"`
		Error  string `json:"error"`
		Data   struct {
			ResultType string `json:"resultType"`
			Result     []struct {
				Metric map[string]string    `json:"metric"`
				Values [][2]json.RawMessage `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("decode prometheus response: %w", err)
	}
	if resp.Status != "success" {
		return nil, fmt.Errorf("prometheus error: %s", resp.Error)
	}
	out := make([]Series, 0, len(resp.Data.Result))
	for _, r := range resp.Data.Result {
		labels := make(map[string]string, len(r.Metric))
		for k, v := range r.Metric {
			if k == "__name__" {
				continue
			}
			labels[k] = v
		}
		samples := make([]Sample, 0, len(r.Values))
		for _, pair := range r.Values {
			var ts float64
			_ = json.Unmarshal(pair[0], &ts)
			var sv string
			_ = json.Unmarshal(pair[1], &sv)
			f, err := strconv.ParseFloat(sv, 64)
			if err != nil {
				continue
			}
			// NaN/Inf land here when a rate() denominator is zero
			// for the whole step — drop them rather than poisoning
			// the chart's domain calculation.
			if isFiniteFloat(f) {
				samples = append(samples, Sample{T: ts, V: f})
			}
		}
		out = append(out, Series{Metric: labels, Values: samples})
	}
	return out, nil
}

// ErrUnconfigured is returned by a nil Client (no PROMETHEUS_URL
// set). Handlers translate it into a 503 with a clear message so
// the UI can show "configure Prometheus to enable live data" rather
// than a generic 500.
var ErrUnconfigured = errors.New("prometheus is not configured")

// Target is one scrape target as Prometheus reports it on
// /api/v1/targets. We only surface the fields the dashboard needs;
// keep the wire format narrow so the frontend doesn't drift on
// undocumented Prometheus internals.
type Target struct {
	Job        string            `json:"job"`
	Endpoint   string            `json:"endpoint"`
	Health     string            `json:"health"` // up / down / unknown
	LastError  string            `json:"lastError,omitempty"`
	LastScrape time.Time         `json:"lastScrape"`
	Labels     map[string]string `json:"labels,omitempty"`
}

// Targets returns the list of active scrape targets. Used by the
// dashboard's connectivity strip — when "down" pops up here it's
// almost always why the live numbers don't render: API/worker
// process can't be reached from the Prometheus container.
func (c *Client) Targets(ctx context.Context) ([]Target, error) {
	if c == nil {
		return nil, ErrUnconfigured
	}
	body, err := c.doGet(ctx, "/api/v1/targets", url.Values{"state": []string{"active"}})
	if err != nil {
		return nil, err
	}
	var resp struct {
		Status string `json:"status"`
		Error  string `json:"error"`
		Data   struct {
			ActiveTargets []struct {
				DiscoveredLabels map[string]string `json:"discoveredLabels"`
				Labels           map[string]string `json:"labels"`
				ScrapeURL        string            `json:"scrapeUrl"`
				Health           string            `json:"health"`
				LastError        string            `json:"lastError"`
				LastScrape       time.Time         `json:"lastScrape"`
			} `json:"activeTargets"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("decode targets: %w", err)
	}
	if resp.Status != "success" {
		return nil, fmt.Errorf("prometheus error: %s", resp.Error)
	}
	out := make([]Target, 0, len(resp.Data.ActiveTargets))
	for _, t := range resp.Data.ActiveTargets {
		out = append(out, Target{
			Job:        t.Labels["job"],
			Endpoint:   t.ScrapeURL,
			Health:     t.Health,
			LastError:  t.LastError,
			LastScrape: t.LastScrape,
			Labels:     t.Labels,
		})
	}
	return out, nil
}

// Alert is one currently firing or pending alert. Mirrors the shape
// of /api/v1/alerts but with only the fields the dashboard renders
// — alertname, severity, summary, value, since, and labels for the
// "what's burning" tooltip.
type Alert struct {
	Name        string            `json:"name"`
	State       string            `json:"state"` // firing | pending | inactive
	Severity    string            `json:"severity,omitempty"`
	Summary     string            `json:"summary,omitempty"`
	Description string            `json:"description,omitempty"`
	Runbook     string            `json:"runbook,omitempty"`
	Value       string            `json:"value,omitempty"`
	ActiveAt    time.Time         `json:"activeAt"`
	Labels      map[string]string `json:"labels,omitempty"`
}

// Alerts returns the current active alert set. We sort firing before
// pending and severity page before ticket so the UI's first row is
// the most-urgent thing on fire right now.
func (c *Client) Alerts(ctx context.Context) ([]Alert, error) {
	if c == nil {
		return nil, ErrUnconfigured
	}
	body, err := c.doGet(ctx, "/api/v1/alerts", nil)
	if err != nil {
		return nil, err
	}
	var resp struct {
		Status string `json:"status"`
		Error  string `json:"error"`
		Data   struct {
			Alerts []struct {
				Labels      map[string]string `json:"labels"`
				Annotations map[string]string `json:"annotations"`
				State       string            `json:"state"`
				ActiveAt    time.Time         `json:"activeAt"`
				Value       string            `json:"value"`
			} `json:"alerts"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("decode alerts: %w", err)
	}
	if resp.Status != "success" {
		return nil, fmt.Errorf("prometheus error: %s", resp.Error)
	}
	out := make([]Alert, 0, len(resp.Data.Alerts))
	for _, a := range resp.Data.Alerts {
		out = append(out, Alert{
			Name:        a.Labels["alertname"],
			State:       a.State,
			Severity:    a.Labels["severity"],
			Summary:     a.Annotations["summary"],
			Description: a.Annotations["description"],
			Runbook:     a.Annotations["runbook_url"],
			Value:       a.Value,
			ActiveAt:    a.ActiveAt,
			Labels:      a.Labels,
		})
	}
	return out, nil
}

func (c *Client) doGet(ctx context.Context, path string, v url.Values) ([]byte, error) {
	full := c.base + path
	if len(v) > 0 {
		full += "?" + v.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, full, nil)
	if err != nil {
		return nil, err
	}
	if c.user != "" || c.pass != "" {
		req.SetBasicAuth(c.user, c.pass)
	}
	res, err := c.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 4<<20)) // 4 MiB cap
	if err != nil {
		return nil, err
	}
	if res.StatusCode/100 != 2 {
		return nil, fmt.Errorf("prometheus %s: %d %s",
			path, res.StatusCode, http.StatusText(res.StatusCode))
	}
	return body, nil
}

// isFiniteFloat returns false for NaN and ±Inf. Both arrive routinely
// from Prometheus when a rate() denominator is zero or a bucket
// hasn't been populated yet — the UI's chart layer maps neither
// gracefully, so we drop them at the wire boundary.
func isFiniteFloat(f float64) bool {
	return !math.IsNaN(f) && !math.IsInf(f, 0)
}
