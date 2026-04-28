/** @type {import('next').NextConfig} */

// Default Content-Security-Policy applied to every response.
//
// Why every response: a missing-CSP route is a free pass for a
// reflected-XSS or clickjack — the SPA is largely auth-gated, but
// /form/<token>, /share/<token> and /review/<token> are intentionally
// public, so even one un-headered route is a real exposure.
//
// Why these directives:
//
//   default-src 'self'           — nothing loads from a third party by
//                                  default; everything below is a
//                                  deliberate carve-out.
//   script-src 'self' 'unsafe-inline' 'unsafe-eval'
//                                — Next.js inlines a hydration script
//                                  per route and we ship TinyMCE which
//                                  uses eval at runtime. Both are
//                                  hard to remove without a nonce
//                                  pipeline; tracked separately.
//   style-src 'self' 'unsafe-inline'
//                                — Tailwind + emotion-style libraries
//                                  inject inline <style> blocks.
//   img-src 'self' data: blob: https: <storage>
//                                — branded logos, generated previews
//                                  (data:), object URLs from the
//                                  upload preview path (blob:), HTTPS
//                                  assets in general, and the storage
//                                  origin (which may be HTTP in dev /
//                                  MinIO).
//   connect-src 'self' <api> <storage>
//                                — fetch/XHR target the API origin
//                                  (NEXT_PUBLIC_API_URL) and the
//                                  storage origin (NEXT_PUBLIC_STORAGE_URL).
//                                  The storage origin is critical:
//                                  presigned uploads POST/PUT directly
//                                  to S3 / MinIO / CloudFront, NOT
//                                  through the API. Without it every
//                                  upload gets silently CSP-blocked.
//   font-src 'self' data:        — webfonts and inline base64 fallbacks.
//   frame-src 'self' <api> <storage>
//                                — Drive iframes presigned PDF preview
//                                  URLs straight from storage; the
//                                  API serves /v1/files/:id/inline-preview
//                                  for image/text previews. Both must
//                                  be allowed or PDF/HTML preview
//                                  panes go blank.
//   media-src 'self' blob: <storage>
//                                — <video>/<audio> for any media files
//                                  the user uploaded. Same storage
//                                  origin as the rest. blob: covers
//                                  the post-capture preview stream
//                                  if we ever surface video capture.
//   worker-src 'self' blob:      — Web Workers (pdf.js, etc). 'self'
//                                  for the bundled worker; blob: for
//                                  libraries that synthesize a worker
//                                  via URL.createObjectURL.
//   frame-ancestors 'self'       — clickjack default. Per-org embed
//                                  allowlists override this on the
//                                  /form, /share, /review routes via
//                                  middleware.ts (which calls the API
//                                  to resolve the org's origins).
//   object-src 'none'            — kill <object>/<embed>/<applet>.
//   base-uri 'self'              — stop a malicious <base> from
//                                  rewriting relative URLs.
//   form-action 'self'           — POSTs only target our origin.
function buildDefaultCSP() {
  // Resolve a single origin from a URL string. Falls back to the raw
  // string so a malformed env var still produces SOMETHING in the
  // directive — the browser will reject the malformed token cleanly
  // and the developer will see it in console, instead of us silently
  // collapsing the whole connect-src to 'self'.
  const originOf = (raw) => {
    try {
      return new URL(raw).origin;
    } catch {
      return raw;
    }
  };
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";
  // Storage origin — where presigned POST/PUT uploads land. In dev
  // that's MinIO at :9000; in prod it's S3 / GCS / CloudFront. If the
  // env var isn't set, fall back to MinIO-on-localhost so `npm run
  // dev` works out of the box.
  const storageUrl =
    process.env.NEXT_PUBLIC_STORAGE_URL || "http://localhost:9000";
  // De-dupe in case API and storage share an origin (some deploys put
  // an upload-proxy in front of S3 on the same hostname).
  const connectOrigins = Array.from(
    new Set([originOf(apiUrl), originOf(storageUrl)]),
  ).join(" ");
  // Storage origin alone (de-duped). Used by directives that need
  // storage but NOT the API (img/frame/media all read presigned URLs
  // straight from S3/MinIO; the API never serves the bytes itself
  // except via /inline-preview which is the API origin).
  const storageOrigin = originOf(storageUrl);
  const apiOrigin = originOf(apiUrl);
  // ONLYOFFICE document server origin. We inject its api.js (script-src),
  // it XHRs back to itself (connect-src), and the editor renders inside
  // an iframe it owns (frame-src). All three directives must allow it.
  const onlyOfficeOrigin = process.env.NEXT_PUBLIC_ONLYOFFICE_URL
    ? originOf(process.env.NEXT_PUBLIC_ONLYOFFICE_URL)
    : "";
  // frame-src needs both: PDF previews iframe storage URLs directly,
  // image/text previews iframe the API's /inline-preview endpoint,
  // and ONLYOFFICE renders the editor in its own iframe.
  const frameOrigins = Array.from(
    new Set([apiOrigin, storageOrigin, onlyOfficeOrigin].filter(Boolean)),
  ).join(" ");
  const scriptOrigins = onlyOfficeOrigin ? ` ${onlyOfficeOrigin}` : "";
  const connectAll = Array.from(
    new Set([apiOrigin, storageOrigin, onlyOfficeOrigin].filter(Boolean)),
  ).join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval'${scriptOrigins}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https: ${storageOrigin}`,
    `connect-src 'self' ${connectAll}`,
    "font-src 'self' data:",
    `frame-src 'self' ${frameOrigins}`,
    `media-src 'self' blob: ${storageOrigin}`,
    "worker-src 'self' blob:",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

const DEFAULT_CSP = buildDefaultCSP();

module.exports = {
  reactStrictMode: true,
  // `standalone` produces a self-contained .next/standalone/ tree
  // with only the runtime files needed to `node server.js`. The
  // Docker image copies that tree + .next/static + public — no
  // node_modules in the runtime layer (saves ~500 MB on the image).
  output: "standalone",
  webpack: (config) => {
    config.resolve.alias.canvas = false;
    return config;
  },
  async headers() {
    return [
      {
        // Apply the strict default to every route. The embed routes
        // (/form, /share, /review) get their frame-ancestors rewritten
        // by middleware.ts on a per-request basis after looking up the
        // org's allowlist; the rest of the app keeps 'self'.
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: DEFAULT_CSP },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            // Permissions-Policy: narrow each capability to same-origin
            // only. Anything not listed is disabled entirely.
            //
            //   camera=(self)   — used by /drive's "Capture image" flow
            //                     (components/camera-capture-dialog.tsx).
            //                     Same-origin only, so an iframed third
            //                     party can't piggyback on the grant.
            //   microphone=()   — never used. Block in this document AND
            //                     every iframe so a compromised
            //                     dependency can't quietly open audio
            //                     capture.
            //   geolocation=(self)
            //                   — used by /login as a best-effort fraud
            //                     signal (2s timeout, login proceeds
            //                     either way). Same-origin only.
            //
            // If a future feature needs microphone, flip the entry to
            // `=(self)`; leaving it `()` would make the getUserMedia
            // call fail silently in production.
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(), geolocation=(self)",
          },
        ],
      },
    ];
  },
};
