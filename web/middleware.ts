// Per-request override of `Content-Security-Policy: frame-ancestors`
// for the public embed routes — `/form/<token>`, `/share/<token>` and
// `/review/<token>`.
//
// Why a middleware:
//
//   The default CSP set in next.config.js is `frame-ancestors 'self'`
//   on every route. That's the right default — we don't want a random
//   site iframing the dashboard to phish session cookies. But the
//   embed routes are a deliberate exception: a customer using the
//   document-generation API may want to drop our /form or /share page
//   into their own marketing site. To allow that without weakening the
//   global default, we look up the org's `embed_allowed_origins`
//   per-request and rewrite the CSP for just that response.
//
//   Doing this in middleware (rather than in the page handler) is a
//   correctness requirement: Next.js merges next.config.js headers and
//   route-handler headers at the edge, and overriding `Content-
//   Security-Policy` from a server component is awkward. Middleware
//   gets a clean shot at the response headers before the body streams.
//
// What this does NOT do:
//
//   - Doesn't fetch the page contents. The token resolution is a
//     side call to the API; the page itself renders normally.
//   - Doesn't authenticate the user. The endpoint is
//     unauthenticated by design — see api/internal/embed/embed.go.
//
// Failure mode: if the API call fails (network, 5xx) or the token
// doesn't resolve (404), we leave the default `frame-ancestors 'self'`
// in place — the customer's iframe will be blocked, but the page
// itself still renders so the form is reachable directly. That's the
// safe default; we'd rather fail-closed on framing than fail-open.

import { NextRequest, NextResponse } from "next/server";

// Extracts the (kind, token) pair from the request path. Returns null
// for any non-embed route so the caller can short-circuit.
function parseEmbedTarget(pathname: string): { kind: string; token: string } | null {
  // /form/<token> | /share/<token> | /review/<token>
  // We split deliberately rather than use a regex with a capture group
  // so additional path segments (e.g. /form/<token>/preview) keep the
  // same token resolution.
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const kind = parts[0];
  const token = parts[1];
  if (!token) return null;
  if (kind !== "form" && kind !== "share" && kind !== "review") return null;
  return { kind, token };
}

// Builds the CSP for this response by replacing the frame-ancestors
// directive in the inherited default with the per-org allowlist. We
// preserve every other directive verbatim so changes to next.config.js
// don't have to be mirrored here.
function rewriteFrameAncestors(originalCSP: string, origins: string[]): string {
  const allow = ["'self'", ...origins.map((o) => o.trim()).filter(Boolean)].join(" ");
  const replacement = `frame-ancestors ${allow}`;
  if (!originalCSP) return replacement;
  // Directive-by-directive replace so we don't accidentally rewrite a
  // host that happens to contain the substring "frame-ancestors".
  const out = originalCSP
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => (d.startsWith("frame-ancestors") ? replacement : d));
  if (!out.some((d) => d.startsWith("frame-ancestors"))) {
    out.push(replacement);
  }
  return out.join("; ");
}

// API base — same env var the rest of the app uses. We resolve at
// request time (not module load) so the middleware picks up runtime
// env from the platform.
function apiBase(): string {
  return process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";
}

// Resolves the org's allowlist for a (kind, token). Returns an empty
// array on any failure — the caller falls back to 'self'.
async function resolveOrigins(kind: string, token: string): Promise<string[]> {
  try {
    const url = `${apiBase()}/v1/public/embed-policy?kind=${encodeURIComponent(
      kind,
    )}&token=${encodeURIComponent(token)}`;
    // No-store: the policy can change at any time when an admin edits
    // the org config; a stale CDN copy would leave a revoked origin
    // able to embed. The API response itself is cached for 30s.
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return [];
    const body = (await res.json()) as { origins?: string[] };
    return Array.isArray(body.origins) ? body.origins : [];
  } catch {
    return [];
  }
}

export async function middleware(req: NextRequest) {
  const target = parseEmbedTarget(req.nextUrl.pathname);
  if (!target) return NextResponse.next();

  const origins = await resolveOrigins(target.kind, target.token);

  const res = NextResponse.next();
  // The next.config.js default is already on the response by the time
  // middleware runs — we mutate it in place rather than replace it so
  // every other directive (script-src, connect-src, etc.) survives.
  const existing = res.headers.get("content-security-policy") || "";
  const updated = rewriteFrameAncestors(existing, origins);
  res.headers.set("content-security-policy", updated);
  // X-Frame-Options is a coarser, older mechanism that some browsers
  // honour in preference to CSP frame-ancestors. Remove it on the
  // embed surface so the wider allowlist actually takes effect.
  res.headers.delete("x-frame-options");
  return res;
}

// Limit middleware to the embed routes — every other URL pays zero
// overhead. The matcher is statically analysed by Next.js at build
// time so the page never even hits the function for a non-match.
export const config = {
  matcher: ["/form/:path*", "/share/:path*", "/review/:path*"],
};
