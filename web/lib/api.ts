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
//
// `.message` is intentionally a *user-friendly* string — the raw
// server message lives on `.raw.error.message` for callers that need
// it (e.g. surfacing field-level validation hints). This way a
// `toast.show("error", e.message)` never leaks "pq: connection
// refused" or stack traces to end users.
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  // Present on 422 validation_failed responses — one entry per failed
  // field with `field` (PDF field name), `dataKey`, and `message`.
  readonly fields?: Array<{ field: string; dataKey: string; message: string }>;
  readonly raw: any;
  // The unmassaged server-side message (or fetch error string), kept
  // separate from the polished `.message` shown to users.
  readonly rawMessage: string;

  constructor(
    status: number,
    code: string,
    message: string,
    raw: any,
    fields?: ApiError["fields"]
  ) {
    super(friendlyMessage(status, code, message));
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.raw = raw;
    this.fields = fields;
    this.rawMessage = message;
  }
}

// Map low-level / internal errors to language a user can act on.
// Anything 5xx or network-level becomes a generic "service trouble"
// line; auth and rate-limit errors get specific guidance; for the
// 4xx tier we trust the server message *unless* it looks like a
// stack trace / database driver string.
function friendlyMessage(status: number, code: string, raw: string): string {
  if (status === 0) {
    return "Can't reach the server. Check your connection and try again.";
  }
  if (status >= 500) {
    return "The service is having trouble right now. Please try again in a moment.";
  }
  if (status === 401) {
    // 401 has multiple distinct meanings on this surface:
    //   - `invalid_credentials` from /login when the user typed the
    //     wrong email/password — a fresh failure, NOT a session issue.
    //   - `invalid_mfa` when the supplied MFA code didn't verify.
    //   - everything else (`unauthorized`, expired token, missing
    //     bearer header) — the user had a session and it's gone.
    // Branching on `code` keeps the login form from telling someone
    // who's never signed in that their "session has expired".
    if (code === "invalid_credentials") {
      return "That email and password didn't match. Please try again.";
    }
    if (code === "invalid_mfa") {
      return "That verification code isn't valid. Please try again.";
    }
    return "Your session has expired. Please sign in again.";
  }
  if (status === 408 || status === 504) {
    return "That request took too long. Please try again.";
  }
  if (status === 429) {
    return "Too many requests. Please slow down and try again shortly.";
  }
  // 4xx: server messages are usually meaningful (validation, conflict,
  // permission). Pass them through unless they look like leaked
  // internals — driver / connection / panic / SQL strings.
  if (raw && !looksInternal(raw)) return raw;
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return "We couldn't find what you're looking for.";
  if (status === 409) return "That conflicts with an existing item.";
  if (status === 413) return "That file is too large.";
  if (status === 415) return "That file type isn't supported.";
  if (status === 423) return "This item is locked.";
  return "Something went wrong. Please try again.";
}

function looksInternal(s: string): boolean {
  const t = s.toLowerCase();
  return (
    t.includes("pq:") ||
    t.includes("pgx:") ||
    t.includes("dial tcp") ||
    t.includes("connection refused") ||
    t.includes("eof") ||
    t.includes("panic:") ||
    t.includes("goroutine") ||
    t.includes("runtime error") ||
    t.includes("sql:") ||
    t.includes("driver:") ||
    t.includes("fatal:") ||
    t.startsWith("error 0x")
  );
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
  let res: Response;
  try {
    res = await doFetch(path, init);
  } catch (e: any) {
    // fetch() throws on DNS failures, offline, CORS, aborts, etc. We
    // surface a synthetic ApiError(status=0) so callers always see the
    // same shape and the user sees a "can't reach server" line instead
    // of "TypeError: Failed to fetch".
    throw new ApiError(0, "network_error", e?.message || "network error", null);
  }
  // 423 = folder vault locked. Pop the re-auth modal and retry once.
  // The retry is single-shot: if the modal closes without unlocking
  // (or unlock fails), we fall through to the normal error path.
  if (res.status === 423 && vaultUnlocker) {
    const unlocked = await vaultUnlocker();
    if (unlocked) {
      try {
        res = await doFetch(path, init);
      } catch (e: any) {
        throw new ApiError(0, "network_error", e?.message || "network error", null);
      }
    }
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
    const err = body.error ?? {};
    const code = err.code ?? "request_failed";
    // Auto-logout on session-expiry style 401s. Without this the UI
    // keeps the dead token in localStorage, every subsequent request
    // 401s the same way, and the user sees a "session expired" toast
    // on every click instead of being kicked back to the login page.
    //
    // We carve out `invalid_credentials` (wrong password on /login)
    // and `invalid_mfa` (wrong TOTP code) — those are 401s for a user
    // who's actively trying to sign in, not a stale-session signal.
    // Already on /login? Skip the redirect to avoid a self-loop.
    if (
      res.status === 401 &&
      code !== "invalid_credentials" &&
      code !== "invalid_mfa" &&
      typeof window !== "undefined"
    ) {
      clearSession();
      const here = window.location.pathname + window.location.search;
      if (!window.location.pathname.startsWith("/login")) {
        // `next=` lets the login page bounce the user back to the page
        // they were on. encodeURIComponent because pathnames can carry
        // query string + hash characters that would otherwise corrupt
        // the redirect URL.
        const next = encodeURIComponent(here);
        window.location.replace(`/login?next=${next}`);
      }
    }
    throw new ApiError(
      res.status,
      code,
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
