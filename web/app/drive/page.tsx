"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api, clearSession, getToken, getUser } from "@/lib/api";
import { useToast } from "@/components/toast";

type FileItem = {
  id: string;
  name: string;
  mime: string;
  size: number;
  status: string;
  templateId?: string;
  folderId?: string | null;
  createdAt: string;
};

type Folder = { id: string; parentId: string | null; name: string; createdAt: string };
type Share = { id: string; token: string; role: string; expiresAt?: string; createdAt: string };

export default function DrivePage() {
  const router = useRouter();
  const toast = useToast();
  const searchParams = useSearchParams();
  const currentFolderId = searchParams.get("folder") || "";

  const [user, setUser] = useState<any>(null);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<{ name: string; pct: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [shareFor, setShareFor] = useState<FileItem | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    setUser(getUser());
    load();
  }, [router, currentFolderId]);

  async function load() {
    setLoading(true);
    try {
      const [f, d] = await Promise.all([
        api<{ files: FileItem[] }>(`/v1/files?folder=${encodeURIComponent(currentFolderId)}`),
        api<{ folders: Folder[] }>(`/v1/folders?parent=${encodeURIComponent(currentFolderId)}`),
      ]);
      setFiles(f.files);
      setFolders(d.folders);
      if (currentFolderId) {
        const b = await api<{ breadcrumbs: Folder[] }>(`/v1/folders/${currentFolderId}/breadcrumbs`);
        setBreadcrumbs(b.breadcrumbs);
      } else {
        setBreadcrumbs([]);
      }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function upload(file: File) {
    setErr(null);
    setUploading({ name: file.name, pct: 0 });
    try {
      const { fileId, uploadUrl } = await api<{ fileId: string; uploadUrl: string }>(
        "/v1/files/upload-url",
        { method: "POST", body: JSON.stringify({ name: file.name, mime: file.type }) }
      );
      await putWithProgress(uploadUrl, file, (pct) => setUploading({ name: file.name, pct }));
      const complete = await api<{ templateId?: string }>(`/v1/files/${fileId}/complete`, { method: "POST" });
      // Move file into the current folder if we are viewing a subfolder.
      if (currentFolderId) {
        await api(`/v1/files/${fileId}`, {
          method: "PATCH",
          body: JSON.stringify({ folderId: currentFolderId }),
        });
      }
      setUploading(null);
      await load();
      if (complete.templateId) {
        toast.show("success", "AcroForm detected — opening designer");
        router.push(`/templates/${complete.templateId}/designer`);
      } else {
        toast.show("success", `Uploaded ${file.name}`);
      }
    } catch (e: any) {
      setErr(e.message);
      setUploading(null);
    }
  }

  async function download(id: string) {
    try {
      const { downloadUrl } = await api<{ downloadUrl: string }>(`/v1/files/${id}/download`);
      window.open(downloadUrl, "_blank");
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function remove(id: string) {
    if (!confirm("Move this file to trash?")) return;
    try {
      await api(`/v1/files/${id}`, { method: "DELETE" });
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function newFolder() {
    const name = prompt("Folder name");
    if (!name) return;
    try {
      await api("/v1/folders", {
        method: "POST",
        body: JSON.stringify({ name, parentId: currentFolderId || null }),
      });
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function renameFolder(f: Folder) {
    const name = prompt("New folder name", f.name);
    if (!name || name === f.name) return;
    try {
      await api(`/v1/folders/${f.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function deleteFolder(f: Folder) {
    if (!confirm(`Delete folder "${f.name}"? (must be empty)`)) return;
    try {
      await api(`/v1/folders/${f.id}`, { method: "DELETE" });
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function moveFile(file: FileItem) {
    const target = prompt(
      "Move to folder ID (paste from URL, or leave blank for root):",
      file.folderId || ""
    );
    if (target === null) return;
    try {
      await api(`/v1/files/${file.id}`, {
        method: "PATCH",
        body: JSON.stringify({ folderId: target }),
      });
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  function logout() {
    clearSession();
    router.replace("/login");
  }

  if (!user) return null;

  return (
    <div className="min-h-screen">
      <header className="bg-white border-b px-6 py-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold">DocForge</h1>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-gray-600">{user.email}</span>
          <button onClick={logout} className="text-blue-600 hover:underline">Sign out</button>
        </div>
      </header>

      <main className="p-6 max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="text-2xl font-semibold flex items-center gap-2">
            <Link href="/drive" className="hover:underline">My Drive</Link>
            {breadcrumbs.map((b) => (
              <span key={b.id} className="flex items-center gap-2">
                <span className="text-gray-400">/</span>
                <Link href={`/drive?folder=${b.id}`} className="hover:underline">{b.name}</Link>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={newFolder} className="px-3 py-2 text-sm border rounded hover:bg-gray-50">
              New folder
            </button>
            <button onClick={load} className="px-3 py-2 text-sm border rounded hover:bg-gray-50">
              Refresh
            </button>
            <button
              onClick={() => inputRef.current?.click()}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Upload
            </button>
            <input
              ref={inputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload(f);
                e.target.value = "";
              }}
            />
          </div>
        </div>

        {uploading && (
          <div className="mb-4 bg-blue-50 border border-blue-200 rounded p-3 text-sm">
            Uploading <strong>{uploading.name}</strong> — {uploading.pct}%
            <div className="mt-2 h-1 bg-blue-100 rounded overflow-hidden">
              <div className="h-full bg-blue-600 transition-all" style={{ width: `${uploading.pct}%` }} />
            </div>
          </div>
        )}

        {err && <div className="mb-4 text-sm text-red-600">{err}</div>}

        <div className="bg-white border rounded-lg overflow-hidden">
          {loading ? (
            <div className="p-12 text-center text-gray-500">Loading…</div>
          ) : folders.length === 0 && files.length === 0 ? (
            <div className="p-12 text-center text-gray-500">
              Empty folder. Create a subfolder or upload a file.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-gray-600">
                <tr>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2">Size</th>
                  <th className="px-4 py-2">Modified</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {folders.map((f) => (
                  <tr key={f.id} className="border-t hover:bg-gray-50">
                    <td className="px-4 py-2">
                      <Link href={`/drive?folder=${f.id}`} className="font-medium hover:underline">
                        📁 {f.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-gray-600">Folder</td>
                    <td className="px-4 py-2 text-gray-600">—</td>
                    <td className="px-4 py-2 text-gray-600">{new Date(f.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-2 text-right">
                      <button onClick={() => renameFolder(f)} className="text-blue-600 hover:underline mr-3">
                        Rename
                      </button>
                      <button onClick={() => deleteFolder(f)} className="text-red-600 hover:underline">
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
                {files.map((file) => (
                  <tr key={file.id} className="border-t hover:bg-gray-50">
                    <td className="px-4 py-2 font-medium">{file.name}</td>
                    <td className="px-4 py-2 text-gray-600">{file.mime}</td>
                    <td className="px-4 py-2 text-gray-600">{fmtSize(file.size)}</td>
                    <td className="px-4 py-2 text-gray-600">{new Date(file.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-2 text-right">
                      {file.templateId && (
                        <Link
                          href={`/templates/${file.templateId}/designer`}
                          className="text-blue-600 hover:underline mr-3"
                        >
                          Designer
                        </Link>
                      )}
                      <button onClick={() => setShareFor(file)} className="text-blue-600 hover:underline mr-3">
                        Share
                      </button>
                      <button onClick={() => moveFile(file)} className="text-blue-600 hover:underline mr-3">
                        Move
                      </button>
                      <button onClick={() => download(file.id)} className="text-blue-600 hover:underline mr-3">
                        Download
                      </button>
                      <button onClick={() => remove(file.id)} className="text-red-600 hover:underline">
                        Trash
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>

      {shareFor && <ShareModal file={shareFor} onClose={() => setShareFor(null)} />}
    </div>
  );
}

function ShareModal({ file, onClose }: { file: FileItem; onClose: () => void }) {
  const toast = useToast();
  const [shares, setShares] = useState<Share[]>([]);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState("viewer");
  const [expiry, setExpiry] = useState("0");

  useEffect(() => {
    (async () => {
      try {
        const r = await api<{ shares: Share[] }>(`/v1/files/${file.id}/shares`);
        setShares(r.shares);
      } finally {
        setLoading(false);
      }
    })();
  }, [file.id]);

  async function create() {
    try {
      const r = await api<Share>(`/v1/files/${file.id}/share`, {
        method: "POST",
        body: JSON.stringify({ role, expiresIn: parseInt(expiry, 10) }),
      });
      setShares([r, ...shares]);
      toast.show("success", "Share link created");
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function revoke(id: string) {
    try {
      await api(`/v1/shares/${id}`, { method: "DELETE" });
      setShares(shares.filter((s) => s.id !== id));
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function copyLink(token: string) {
    const url = `${window.location.origin}/share/${token}`;
    await navigator.clipboard.writeText(url);
    toast.show("success", "Link copied");
  }

  return (
    <div className="fixed inset-0 bg-black/40 grid place-items-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-[560px] max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b flex items-center justify-between">
          <h3 className="font-semibold">Share &quot;{file.name}&quot;</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-900">✕</button>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex gap-2 items-end">
            <label className="flex-1">
              <div className="text-xs text-gray-500 mb-1">Role</div>
              <select value={role} onChange={(e) => setRole(e.target.value)} className="w-full border rounded px-2 py-1 text-sm">
                <option value="viewer">Viewer</option>
                <option value="downloader">Downloader</option>
              </select>
            </label>
            <label className="flex-1">
              <div className="text-xs text-gray-500 mb-1">Expires</div>
              <select value={expiry} onChange={(e) => setExpiry(e.target.value)} className="w-full border rounded px-2 py-1 text-sm">
                <option value="0">Never</option>
                <option value="3600">1 hour</option>
                <option value="86400">1 day</option>
                <option value="604800">7 days</option>
                <option value="2592000">30 days</option>
              </select>
            </label>
            <button onClick={create} className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">
              Create link
            </button>
          </div>

          <div className="border-t pt-4">
            <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">Active links</div>
            {loading ? (
              <div className="text-sm text-gray-500">Loading…</div>
            ) : shares.length === 0 ? (
              <div className="text-sm text-gray-500">No share links yet.</div>
            ) : (
              <div className="space-y-2">
                {shares.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 text-sm">
                    <code className="flex-1 bg-gray-100 px-2 py-1 rounded truncate text-xs">
                      /share/{s.token}
                    </code>
                    <span className="text-xs text-gray-500">{s.role}</span>
                    <button onClick={() => copyLink(s.token)} className="text-blue-600 hover:underline">Copy</button>
                    <button onClick={() => revoke(s.id)} className="text-red-600 hover:underline">Revoke</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function putWithProgress(url: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload failed: ${xhr.status}`)));
    xhr.onerror = () => reject(new Error("network error"));
    xhr.send(file);
  });
}

function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
