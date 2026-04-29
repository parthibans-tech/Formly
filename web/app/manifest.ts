import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Drive360 — Document automation",
    short_name: "Drive360",
    description:
      "Design, fill, sign, and share PDF & HTML documents at scale.",
    start_url: "/",
    display: "standalone",
    background_color: "#0b1020",
    theme_color: "#0fb99b",
    icons: [
      { src: "/icon", sizes: "256x256", type: "image/png" },
      { src: "/icon", sizes: "512x512", type: "image/png" },
    ],
  };
}
