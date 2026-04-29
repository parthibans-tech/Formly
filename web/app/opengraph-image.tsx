import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Drive360 — Document automation for modern teams";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OG() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          background:
            "radial-gradient(at 20% 10%, rgba(16,185,129,0.35), transparent 50%), radial-gradient(at 90% 90%, rgba(99,102,241,0.35), transparent 50%), #0b1020",
          color: "#f8fafc",
          padding: "72px 80px",
          justifyContent: "space-between",
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background:
                "linear-gradient(135deg, #10b981 0%, #06b6d4 60%, #6366f1 100%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 32,
              fontWeight: 800,
            }}
          >
            D
          </div>
          <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: -0.5 }}>
            Drive360
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div
            style={{
              fontSize: 78,
              fontWeight: 800,
              lineHeight: 1.05,
              letterSpacing: -1.5,
              maxWidth: 980,
            }}
          >
            Turn paperwork into a pipeline.
          </div>
          <div style={{ fontSize: 28, color: "#cbd5e1", maxWidth: 920 }}>
            Design, fill, sign, and share PDF & HTML documents at scale. Bulk
            generate, embed forms, automate the rest.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            color: "#94a3b8",
            fontSize: 22,
          }}
        >
          <span>Document automation for modern teams</span>
          <span style={{ color: "#10b981", fontWeight: 700 }}>drive360.app</span>
        </div>
      </div>
    ),
    { ...size }
  );
}
