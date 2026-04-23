export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

export function getToken() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("df_token");
}

export function setSession(token: string, user: any) {
  localStorage.setItem("df_token", token);
  localStorage.setItem("df_user", JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem("df_token");
  localStorage.removeItem("df_user");
}

export function getUser() {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem("df_user");
  return raw ? JSON.parse(raw) : null;
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const isFormData = init.body instanceof FormData;
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(err.error?.message || "request failed");
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json();
}

export type JobStatus = {
  id: string;
  kind: "single" | "batch";
  status: "queued" | "running" | "completed" | "failed";
  total: number;
  done: number;
  outputFileId?: string;
  error?: string;
};

// Poll a job until it reaches a terminal state. Calls onTick on every update.
export async function pollJob(
  jobId: string,
  onTick?: (j: JobStatus) => void,
  intervalMs = 800,
  timeoutMs = 5 * 60_000
): Promise<JobStatus> {
  const started = Date.now();
  while (true) {
    const j = await api<JobStatus>(`/v1/jobs/${jobId}`);
    onTick?.(j);
    if (j.status === "completed" || j.status === "failed") return j;
    if (Date.now() - started > timeoutMs) throw new Error("Job timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
