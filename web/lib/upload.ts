// Universal presigned-upload helper.
//
// The backend's POST /v1/files/upload-url returns a polymorphic descriptor
// — either the new POST policy shape (with `upload.url` + `upload.fields`,
// content-length-range enforced at the storage edge) or the legacy PUT
// URL (`uploadUrl`, no edge enforcement). This helper handles both so
// every callsite can stay agnostic to which one the server emitted.
//
// Why we keep the legacy PUT path working: existing API integrators (and
// a handful of small designer-side uploads) still use it. The server
// re-checks size in the Complete handler, so even on the PUT path the
// per-org max-upload limit is enforced — POST just enforces it earlier
// (at write time, saving bandwidth on rejected payloads).

export type PresignedPostUpload = {
  url: string;
  fields: Record<string, string>;
};

export type UploadDescriptor = {
  /** Either the new POST descriptor … */
  upload?: PresignedPostUpload;
  /** … or the legacy PUT URL. At least one must be set. */
  uploadUrl?: string;
  /** Resolved policy ceiling (bytes). Used for client-side pre-check. */
  maxBytes?: number;
};

export class UploadTooLargeError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(
      `File exceeds the ${formatBytes(limit)} upload limit configured for this workspace.`
    );
    this.limit = limit;
    this.name = "UploadTooLargeError";
  }
}

/**
 * Upload a File via either the POST or PUT presign — whichever shape the
 * server returned. Reports progress through `onProgress` (0–100 integer).
 *
 * Throws UploadTooLargeError if `maxBytes` is set and `file.size`
 * exceeds it (cheap client-side guard so the user sees a friendly error
 * before we burn an HTTP round trip).
 */
export async function uploadToPresign(
  desc: UploadDescriptor,
  file: File | Blob,
  onProgress?: (pct: number) => void
): Promise<void> {
  if (desc.maxBytes && file.size > desc.maxBytes) {
    throw new UploadTooLargeError(desc.maxBytes);
  }
  if (desc.upload) {
    return postUpload(desc.upload, file, onProgress);
  }
  if (desc.uploadUrl) {
    return putUpload(desc.uploadUrl, file, onProgress);
  }
  throw new Error("upload descriptor has neither `upload` nor `uploadUrl`");
}

function postUpload(
  upload: PresignedPostUpload,
  file: File | Blob,
  onProgress?: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    // S3-style POST policy: every signed field, in order, then a final
    // `file` part. Order matters for some signature variants, so iterate
    // over `fields` exactly as the server returned them.
    for (const [k, v] of Object.entries(upload.fields)) {
      fd.append(k, v);
    }
    fd.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", upload.url);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
    }
    xhr.onload = () => {
      // S3 returns 204 on success; MinIO 204 too (or 200 with body).
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(parseXhrError(xhr) ?? `Upload failed: ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(fd);
  });
}

function putUpload(
  url: string,
  file: File | Blob,
  onProgress?: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    const mime =
      (file as File).type || "application/octet-stream";
    xhr.setRequestHeader("Content-Type", mime);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
    }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed: ${xhr.status}`));
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(file);
  });
}

// S3/MinIO returns an XML error body. We pull out <Message> if we can,
// otherwise fall back to the status. Keeps the toast actionable instead
// of "Upload failed: 403".
function parseXhrError(xhr: XMLHttpRequest): string | null {
  const body = xhr.responseText || "";
  const match = body.match(/<Message>([^<]+)<\/Message>/i);
  if (match) return match[1];
  // EntityTooLarge is the canonical S3 code for content-length-range
  // violations — rewrite it into a friendlier message.
  if (body.includes("EntityTooLarge")) {
    return "This file exceeds the upload size limit for your workspace.";
  }
  return null;
}

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let val = b / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(val >= 10 ? 0 : 1)} ${units[i]}`;
}
