// Resolve the canonical site origin. Order:
//   1. NEXT_PUBLIC_SITE_URL  — explicit override (preferred in prod)
//   2. NEXT_PUBLIC_WEB_URL   — alternative name some deploys use
//   3. http://localhost:3000 — dev fallback
//
// Used by sitemap/robots/metadata so a single env var rotates everywhere.
export function siteUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_WEB_URL ||
    "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}
