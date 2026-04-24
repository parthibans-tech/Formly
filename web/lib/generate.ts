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

export interface GenerateOptions {
  /** Data payload — the template's computed placeholder values. */
  data: unknown;
  /** AcroForm-only: flatten form fields into static content. */
  flatten?: boolean;
  /** Force the async path (queue + poll). Defaults to `false`. */
  async?: boolean;
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
