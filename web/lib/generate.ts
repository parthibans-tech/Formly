/**
 * Shared client helper for the template → PDF generate flow.
 *
 * Historically each designer (html / doc / markdown / acroform / static)
 * hand-rolled the same three-step sequence:
 *
 *   1. POST /v1/templates/:id/generate                → { jobId? | downloadUrl?, outputFileId? }
 *   2. if jobId:  pollJob(jobId)                      → { status, outputFileId? }
 *      and then GET /v1/files/:outputFileId/download  → { downloadUrl }
 *   3. window.open(downloadUrl)
 *
 * That sprawl made it impossible to change what "done" means without
 * touching five designers. This helper centralises the plumbing so
 * callers get a single promise back that resolves to the final shape —
 * `{ outputFileId?, downloadUrl, filename? }` — regardless of whether
 * the server chose the sync or async path. Callers then decide what to
 * do with the result (preview, download, share); they no longer pop a
 * new tab on their own.
 *
 * The `onProgress` callback is invoked once the request lands in the
 * queue and then again on every job poll tick, so the designer UI can
 * surface "queued…", "running…" etc. without each one reinventing the
 * wheel.
 */
import { api, pollJob, type JobStatus } from "@/lib/api";

/**
 * Per-call PDF security overrides. Mirrors the server's
 * `generate.SecurityOverride` shape — keep field names in sync.
 *
 * Pass an empty `{}` (or omit entirely) to use the template's
 * config_json.security policy. Pass with `userPassword` and/or
 * `ownerPassword` set to encrypt this single render even when the
 * template is normally unprotected. Pass with both passwords empty to
 * explicitly render unprotected for one call.
 */
export interface GenerateSecurity {
  ownerPassword?: string;
  userPassword?: string;
  /** "AES-128" | "AES-256". Defaults to AES-256 server-side when omitted. */
  encryption?: "AES-128" | "AES-256";
  /** Boolean per capability. Missing keys = denied. */
  permissions?: {
    print?: boolean;
    copy?: boolean;
    modify?: boolean;
    annotate?: boolean;
    /** Convenience grant — "all" overrides the individual flags. */
    all?: boolean;
  };
}

export interface GenerateOptions {
  /** Data payload — the template's computed placeholder values. */
  data: unknown;
  /** AcroForm-only: flatten form fields into static content. */
  flatten?: boolean;
  /** Force the async path (queue + poll). Defaults to `false`. */
  async?: boolean;
  /**
   * Per-call filename override. Supports {{key}} placeholders resolved
   * against `data`. When omitted, the template's
   * `config.output.filenameTemplate` is used (or the legacy fallback).
   */
  outputName?: string;
  /**
   * Per-call folder path override (logical sub-folder under the org's
   * outputs/ prefix). Supports {{key}} placeholders. When omitted, the
   * template's `config.output.folderPath` is used.
   */
  outputPath?: string;
  /**
   * When `false`, skip persistence to Drive entirely — the response
   * carries only an ephemeral presigned download URL (no
   * `outputFileId`). Defaults to `true` for legacy parity; the designer
   * sends `false` for ad-hoc test renders so authors can iterate
   * without polluting their file list.
   */
  saveToDrive?: boolean;
  /** Per-call PDF security override. Omit to use the template's policy. */
  security?: GenerateSecurity;
  /** Progress ticks: first `"queued"` on enqueue, then status updates. */
  onProgress?: (label: string) => void;
}

export interface GenerateResult {
  /** Presigned URL to the finished PDF (valid ~10 minutes). */
  downloadUrl: string;
  /** File ID of the generated PDF in Drive. Present in almost all paths
   *  (sync + async); absent only if the server chose to return a
   *  download-only URL without persisting — which the current backend
   *  doesn't do, but the field stays optional for forward-compat. */
  outputFileId?: string;
  /** Server-reported byte size, when available. */
  bytes?: number;
}

interface GenerateResponse {
  downloadUrl?: string;
  outputFileId?: string;
  jobId?: string;
  bytes?: number;
  status?: string;
}

export async function runGenerate(
  templateId: string,
  opts: GenerateOptions,
): Promise<GenerateResult> {
  const body: Record<string, unknown> = {
    data: opts.data,
    async: opts.async ?? false,
  };
  if (opts.flatten) body.flatten = true;
  if (opts.outputName) body.outputName = opts.outputName;
  if (opts.outputPath) body.outputPath = opts.outputPath;
  // Only send saveToDrive when the caller explicitly chose — undefined
  // means "use server default" (which is true for legacy parity). The
  // wire field is a *bool on the server, so omitting → nil → default.
  if (typeof opts.saveToDrive === "boolean") body.saveToDrive = opts.saveToDrive;
  if (opts.security) body.security = opts.security;

  const res = await api<GenerateResponse>(
    `/v1/templates/${templateId}/generate`,
    { method: "POST", body: JSON.stringify(body) },
  );

  // Sync path: backend ran the job inline and returned a presigned URL
  // plus (usually) an outputFileId that points to the persisted copy
  // in Drive. Nothing more to poll.
  if (res.downloadUrl) {
    return {
      downloadUrl: res.downloadUrl,
      outputFileId: res.outputFileId,
      bytes: res.bytes,
    };
  }

  // Async path: queue up, poll, then resolve the file id to a
  // presigned download URL. pollJob throws on timeout; the caller's
  // try/catch surfaces it as a toast.
  if (!res.jobId) {
    throw new Error("Generate returned no downloadUrl and no jobId");
  }
  opts.onProgress?.("queued…");
  const done: JobStatus = await pollJob(res.jobId, (j) =>
    opts.onProgress?.(`${j.status}…`),
  );
  if (done.status === "failed") {
    throw new Error(done.error || "Generate job failed");
  }
  if (!done.outputFileId) {
    throw new Error("Generate job finished without an output file");
  }
  const dl = await api<{ downloadUrl: string }>(
    `/v1/files/${done.outputFileId}/download`,
  );
  return {
    downloadUrl: dl.downloadUrl,
    outputFileId: done.outputFileId,
  };
}

/**
 * Re-fetch a presigned URL for a file. Presigned URLs expire (~10 min),
 * so if the user lingers on a preview dialog they may need a fresh one
 * before downloading.
 */
export async function refreshDownloadUrl(fileId: string): Promise<string> {
  const r = await api<{ downloadUrl: string }>(
    `/v1/files/${fileId}/download`,
  );
  return r.downloadUrl;
}
