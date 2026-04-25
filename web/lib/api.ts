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

// Merges patch into the cached user blob so UI components reading getUser()
// see the new value on their next render. Token is left untouched.
export function updateUser(patch: Record<string, any>) {
  const u = getUser() || {};
  localStorage.setItem("df_user", JSON.stringify({ ...u, ...patch }));
}

// ApiError preserves the server's structured error envelope so callers
// can branch on `code` / inspect `fields` (used by the AcroForm 422
// validation response) instead of trying to parse a concatenated
// message string. Legacy `catch (e) { e.message }` callers still work
// because ApiError extends Error.
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  // Present on 422 validation_failed responses — one entry per failed
  // field with `field` (PDF field name), `dataKey`, and `message`.
  readonly fields?: Array<{ field: string; dataKey: string; message: string }>;
  readonly raw: any;

  constructor(
    status: number,
    code: string,
    message: string,
    raw: any,
    fields?: ApiError["fields"]
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.raw = raw;
    this.fields = fields;
  }
}

// vaultUnlocker is set by the <VaultUnlockProvider> at the app root.
// When the API returns 423 vault_locked, api() pauses, calls this hook
// to pop the re-auth modal, and — if the user successfully unlocks —
// transparently retries the original request once. If no provider is
// mounted (e.g. on the public form pages), 423 just throws.
let vaultUnlocker: (() => Promise<boolean>) | null = null;
export function setVaultUnlocker(fn: (() => Promise<boolean>) | null) {
  vaultUnlocker = fn;
}

async function doFetch(path: string, init: RequestInit) {
  const token = getToken();
  const isFormData = init.body instanceof FormData;
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await doFetch(path, init);
  // 423 = folder vault locked. Pop the re-auth modal and retry once.
  // The retry is single-shot: if the modal closes without unlocking
  // (or unlock fails), we fall through to the normal error path.
  if (res.status === 423 && vaultUnlocker) {
    const unlocked = await vaultUnlocker();
    if (unlocked) {
      res = await doFetch(path, init);
    }
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
    const err = body.error ?? {};
    throw new ApiError(
      res.status,
      err.code ?? "request_failed",
      err.message ?? "request failed",
      body,
      Array.isArray(err.fields) ? err.fields : undefined
    );
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
