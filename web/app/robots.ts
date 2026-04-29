import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/"],
        // Token-gated public routes (form/share/review) are deliberately
        // unguessable URLs — never index them, never follow into them.
        // App-shell routes are auth-gated; listing them here saves crawler
        // budget rather than letting bots bounce off /login.
        disallow: [
          "/drive",
          "/drive/",
          "/editor/",
          "/templates/",
          "/code/",
          "/inbox/",
          "/integrations",
          "/merge-recipes/",
          "/settings",
          "/settings/",
          "/form/",
          "/share/",
          "/review/",
          "/api/",
        ],
      },
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
    host: siteUrl(),
  };
}
