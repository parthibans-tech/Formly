// Package profiling exposes the standard `net/http/pprof` handlers
// under the same access-gate as the /metrics endpoint, so Pyroscope
// (or any pprof-aware tool) can pull CPU / heap / goroutine /
// allocations profiles from the running API + worker without
// pulling in the Pyroscope SDK as a compile-time dep.
//
// Design choice: pull, not push.
//
//   - `runtime/pprof` is in the standard library; mounting the
//     handlers adds zero new module deps to the binary.
//   - Pyroscope's scraper already speaks pprof natively (same as
//     `go tool pprof`), so pointing it at /debug/pprof/* on each
//     scrape interval gives us the same continuous-profile UX
//     without an in-process agent loop or SetCPUProfileRate
//     fiddling.
//   - The metrics package's AccessGuard already implements the
//     "basic auth when configured, loopback-only fallback" policy
//     we want for a profile endpoint; sharing it keeps one
//     definition of "who can scrape internals" instead of two.
//
// Cardinality note: pprof endpoints don't add Prometheus series.
// They produce one HTTP response per scrape, gated by the same
// auth as /metrics. The CPU profile in particular runs the runtime
// profiler for `?seconds=N` of the scrape window — keep N below
// the scrape_timeout you configure on the Pyroscope side, and
// don't enable goroutine-blocking profilers (block, mutex) in
// production unless you're actively investigating something:
// they have measurable overhead when always-on.
package profiling

import (
	"net/http"
	"net/http/pprof"

	"github.com/go-chi/chi/v5"
)

// Mount registers /debug/pprof/* on the given chi router under the
// supplied access guard. Pass the same `metricsUser` / `metricsPass`
// the /metrics endpoint uses so the access policy stays uniform.
//
// Endpoints exposed (matching the Go runtime's defaults):
//
//	/debug/pprof/                 — index (HTML listing)
//	/debug/pprof/cmdline          — process cmdline
//	/debug/pprof/profile          — CPU profile (?seconds=N)
//	/debug/pprof/symbol           — symbol resolution
//	/debug/pprof/trace            — execution trace (?seconds=N)
//	/debug/pprof/{name}           — heap, goroutine, allocs, block, mutex, threadcreate
//
// `guard` wraps each handler before it's registered. Pass
// `metrics.AccessGuard(user, pass, h)` from the call site so the
// gate logic stays in one package — we don't re-declare it here.
func Mount(r chi.Router, guard func(http.Handler) http.Handler) {
	if guard == nil {
		guard = func(h http.Handler) http.Handler { return h }
	}

	// Register one route per endpoint instead of a wildcard mount —
	// chi's Mount() composes oddly with net/http/pprof's expectations
	// around the request URL path, and being explicit makes the
	// surface easy to audit. The set matches what the runtime exposes
	// when you `import _ "net/http/pprof"`.
	r.Method("GET", "/debug/pprof/", guard(http.HandlerFunc(pprof.Index)))
	r.Method("GET", "/debug/pprof/cmdline", guard(http.HandlerFunc(pprof.Cmdline)))
	r.Method("GET", "/debug/pprof/profile", guard(http.HandlerFunc(pprof.Profile)))
	r.Method("GET", "/debug/pprof/symbol", guard(http.HandlerFunc(pprof.Symbol)))
	r.Method("POST", "/debug/pprof/symbol", guard(http.HandlerFunc(pprof.Symbol)))
	r.Method("GET", "/debug/pprof/trace", guard(http.HandlerFunc(pprof.Trace)))

	// Named profiles — runtime.Profile names: heap, goroutine,
	// allocs, block, mutex, threadcreate. pprof.Handler returns a
	// chi-compatible http.Handler for each, looked up by name from
	// the URL.
	for _, name := range []string{
		"allocs", "block", "goroutine", "heap", "mutex", "threadcreate",
	} {
		// Capture loop var pre-Go-1.22-style for clarity (the file
		// builds on 1.25 too, but the explicit local makes the
		// closure intent obvious to a reader).
		profileName := name
		r.Method("GET", "/debug/pprof/"+profileName,
			guard(pprof.Handler(profileName)))
	}
}
