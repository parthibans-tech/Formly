# FormlyWebVitalsIngestStalled

## TL;DR

`rate(formly_rum_samples_total[1h]) == 0` for an hour. Real
users are loading pages but no Web Vitals samples are landing in
Prometheus. The signal is gone — but no live user impact.

Ticket, not page.

## Verify

1. Open the [RUM dashboard](http://localhost:3001/d/formly-rum)
   → "Samples ingested / sec" panel. Should be flatlined at 0.
2. Open a browser dev-tools network tab on
   `https://app.formly.com/` (or your local dev URL). Look for
   `POST /v1/rum` to fire on tab close. Right-click the tab →
   "Close tab" while the network tab is recording — sendBeacon
   requests show up under "Other" or with the `text/plain` MIME
   shorthand.
3. If the request is firing client-side but Prometheus shows
   zero samples, the API is rejecting / dropping silently.

## Diagnose

### Client-side: no /v1/rum requests at all

1. **Collector not deployed.** `web/components/rum-collector.tsx`
   should be mounted in `web/app/layout.tsx`. Check the deployed
   bundle: `view-source:` and grep for `web-vitals` or `startRUM`.
2. **`web-vitals` package missing.** A recent `npm install`
   without lockfile commit may have dropped the dependency.
   Check `web/package.json` and the deployed `node_modules`.
3. **Bundle error.** The collector throws at startup, so
   `startRUM()` never registers the listeners. Check the
   browser console for a stack trace.

### Client-side: requests fire, server doesn't count them

1. **CORS rejection.** The frontend is on a different origin
   than the API. Check `CORS_ALLOWED_ORIGINS` in the API's
   environment includes the frontend origin. Browser console
   will show a CORS preflight failure.
2. **Body too large.** A bug in the collector is sending more
   than 16 KiB per beacon. The API returns 400; the beacon is
   silently dropped. `grep "body too large" api.log`.
3. **JSON parse error.** Unlikely (we serialize via
   JSON.stringify) but possible if a downstream proxy is
   mangling the body. `grep "invalid json" api.log`.
4. **Allowlist drop.** Every metric name is being dropped at
   the allowlist. The handler logs nothing in this case (by
   design — silent drop), so check that the frontend hasn't
   started sending metric names outside `LCP|INP|CLS|FCP|TTFB`.

### Server-side: API can't see the metric registry

1. **`metricsReg` is nil at handler construction.** The
   handler short-circuits on `h.M == nil` and returns 204
   without observing. Check the `rum.New(metricsReg)` call in
   `api/cmd/api/main.go` — the registry must be constructed
   before the handler.

## Mitigate

This isn't a live user-impacting outage. Don't rush a hot-fix;
roll back the offending change in normal hours.

If you need to silence the alert during a known migration (e.g.
reshipping the frontend bundle on a fresh CDN that takes a few
hours to warm), use the silence button in the Slack message.

## Confirm

Once samples start flowing, the `rate(formly_rum_samples_total[1h])`
takes ~5 minutes to climb above zero (one full scrape interval +
a real page-unload). The alert's `for: 1h` window has to elapse
again with healthy samples before it resolves.

## Related

- [RUM dashboard](http://localhost:3001/d/formly-rum)
- [Web Vitals poor](rum-poor-vitals.md)
- `internal/rum/rum.go` — API handler + cardinality guards
- `web/lib/rum.ts` — browser collector
- `web/components/rum-collector.tsx` — layout mount point
