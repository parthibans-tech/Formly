import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  const now = new Date();
  return [
    { url: `${base}/`,        lastModified: now, changeFrequency: "weekly",  priority: 1.0 },
    { url: `${base}/login`,   lastModified: now, changeFrequency: "yearly",  priority: 0.4 },
    { url: `${base}/signup`,  lastModified: now, changeFrequency: "yearly",  priority: 0.6 },
  ];
}
