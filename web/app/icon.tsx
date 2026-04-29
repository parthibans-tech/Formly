import { ImageResponse } from "next/og";

export const runtime = "edge";
export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background:
            "linear-gradient(135deg, #10b981 0%, #06b6d4 60%, #6366f1 100%)",
          borderRadius: 14,
          color: "#fff",
          fontSize: 36,
          fontWeight: 700,
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
        }}
      >
        D
      </div>
    ),
    { ...size }
  );
}
