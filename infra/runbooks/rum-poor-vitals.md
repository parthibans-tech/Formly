# FormlyWebVitalsPoor{LCP,INP,CLS}

## TL;DR

Real users' p75 Core Web Vital has crossed Google's "poor"
threshold for 30 minutes:

| Metric | Good | Poor (alert) |
|--------|------|--------------|
| LCP    | ≤ 2.5s   | > 4.0s   |
| INP    | ≤ 200ms  | > 500ms  |
| CLS    | ≤ 0.1    | > 0.25   |

This is **field data**, not lab. The numbers come from the
`web-vitals` collector mounted in `web/app/layout.tsx`, beaconed
to `POST /v1/rum`, recorded onto `formly_rum_web_vitals_seconds`,
rolled up to `metric:formly_web_vitals_seconds:p75` by the
`formly-rum` rule group, then alerted on here.

It's a **ticket**, not a page — RUM regressions are
deploy-shaped problems that need a focused next-business-day fix,
not a 3am wake-up.

## Verify

Open the [RUM dashboard](http://localhost:3001/d/formly-rum) and
look at the headline stat for the firing metric. If the headline
is already back in the green band, the alert is in its `for:`
window cool-off — wait it out and confirm it resolves.

Per-route table at the bottom of the dashboard tells you whether
*all* routes regressed (a global change — bundle, third-party
script, font) or *one* route did (a feature change on that page).

## Diagnose

### LCP > 4.0s

1. **Bundle bloat.** Recent JS bundle growth blocks the main
   thread before the hero paint. Check `web/.next/analyze` from
   the last build or `npm run build` output for chunks that
   ballooned.
2. **Image hosting.** The hero image on the affected route is
   slow to deliver. Check the storage backend latency on the
   [Infrastructure dashboard](http://localhost:3001/d/formly-infrastructure).
   Self-hosted MinIO behind a slow disk is the usual culprit.
3. **Render-blocking CSS / fonts.** A new `<link rel="stylesheet">`
   or a font that isn't `font-display: swap` will block the
   paint. `view-source:` the affected route and look for
   render-blocking resources.
4. **Server TTFB.** LCP includes TTFB. If the per-route p75 LCP
   regression matches a `route:formly_http_request_duration_seconds:p95`
   regression on the same route, the problem is server-side, not
   frontend.

### INP > 500ms

1. **Long-running JS handler.** Some click/keypress handler is
   blocking the main thread. Open Chrome DevTools → Performance,
   record an interaction on the affected route, look for the
   long task that follows the input event.
2. **Synchronous third-party.** A new analytics / chat /
   marketing snippet is doing heavy work on every interaction.
   Check the `next.config.js` `<Script>` tags and any
   recently-added `<script src=...>` in `app/layout.tsx`.
3. **Large React commit.** A state change is forcing a re-render
   of a heavy subtree. The React Profiler will show the commit
   time; suspect components that recently grew (e.g., a list
   that lost virtualization).

### CLS > 0.25

1. **Image without dimensions.** A recently-added `<img>` /
   `<video>` / `<iframe>` is missing `width` / `height`. The
   element pushes everything below it as it loads.
2. **Web font swap.** A font is loading without `size-adjust`
   so the swap from fallback → web font shifts text by several
   pixels. Most painful on hero copy.
3. **Late-injected ad / embed slot.** An ad script or embed
   (YouTube, Twitter) is rendering into an unsized container
   above the fold. Reserve space with min-height.

## Mitigate

- **Roll back the suspected commit.** RUM regressions usually
  trace to a single deploy. The cost of a rollback is far less
  than the cost of a 30-minute Web Vital regression on every
  user.
- **Take the slow third-party out of the critical path.** Move
  it behind `next/script strategy="lazyOnload"` or a deferred
  dynamic import.
- **Reserve space.** For CLS specifically, adding explicit
  width/height to the offending element is a one-line fix.

## Confirm

The recording rule runs every 30s. Once the underlying p75 drops
back below the threshold, the `for: 30m` window has to elapse
again before the alert resolves. Don't suppress; let it resolve
on its own so the Slack channel reflects reality.

## Related

- [RUM dashboard](http://localhost:3001/d/formly-rum)
- [RUM ingestion stalled](rum-ingest-stalled.md)
- `internal/rum/rum.go` — the API ingestion handler
- `web/lib/rum.ts` — the browser collector
