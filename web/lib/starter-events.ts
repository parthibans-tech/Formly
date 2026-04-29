// Typed wrappers for /v1/starters/events/ics and /v1/starters/qr.
// Both endpoints return *binary* responses (text/calendar and image/png
// respectively), so they bypass the JSON `api()` helper and use fetch
// directly. We replicate the bearer-token + ApiError envelope handling
// here so callers see the same error shape.

import { API_URL, getToken, ApiError } from "./api";

export interface ICSRequest {
  title: string;
  start: string; // RFC3339
  end?: string; // RFC3339 — defaults to start+1h on the server
  allDay?: boolean;
  location?: string;
  description?: string;
  url?: string;
  organizer?: string;
}

// downloadICS returns a Blob the caller can pipe through saveAs.
export async function downloadICS(body: ICSRequest): Promise<Blob> {
  return postBinary("/v1/starters/events/ics", body, "text/calendar");
}

export interface QRRequest {
  payload: string;
  size?: number; // 128..1024, default 512
  level?: "L" | "M" | "Q" | "H";
}

// generateQR returns a PNG Blob; useful for `URL.createObjectURL` on
// an <img> tag without a separate fetch round-trip.
export async function generateQR(body: QRRequest): Promise<Blob> {
  return postBinary("/v1/starters/qr", body, "image/png");
}

async function postBinary(
  path: string,
  body: unknown,
  contentType: string,
): Promise<Blob> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: contentType,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (e: any) {
    throw new ApiError(0, "network_error", e?.message || "network error", null);
  }
  if (!res.ok) {
    // Mirror api()'s envelope unwrap so callers can branch on .code.
    const json = await res.json().catch(() => ({
      error: { message: res.statusText },
    }));
    const err = json.error ?? {};
    throw new ApiError(
      res.status,
      err.code ?? "request_failed",
      err.message ?? "request failed",
      json,
    );
  }
  return res.blob();
}
