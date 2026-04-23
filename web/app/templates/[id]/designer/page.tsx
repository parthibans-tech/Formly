"use client";
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api, getToken, pollJob } from "@/lib/api";
import { useToast } from "@/components/toast";
import StaticDesigner from "@/components/static-designer";
import HtmlDesigner from "@/components/html-designer";

type Field = { name: string; type: string; page: number; options?: string[] };
type Mapping = {
  dataKey: string;
  default?: string;
  required?: boolean;
  transform?: string;
};
type Widget = {
  id: string;
  type: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  dataKey: string;
  zIndex: number;
  props: Record<string, any>;
};

type Template = {
  id: string;
  fileId: string;
  mode: string;
  name: string;
  version: number;
  config: { mappings?: Record<string, Mapping> };
  fields: Field[];
  widgets: Widget[];
};

const TRANSFORMS = ["", "uppercase", "lowercase", "date", "currency"];

export default function DesignerPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const toast = useToast();
  const [tpl, setTpl] = useState<Template | null>(null);
  const [mappings, setMappings] = useState<Record<string, Mapping>>({});
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [genOpen, setGenOpen] = useState(false);
  const [genJSON, setGenJSON] = useState("");
  const [genFlatten, setGenFlatten] = useState(false);
  const [genAsync, setGenAsync] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genProgress, setGenProgress] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState<string | null>(null);
  const [genErr, setGenErr] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    (async () => {
      try {
        const [t, p] = await Promise.all([
          api<Template>(`/v1/templates/${params.id}`),
          api<{ url: string }>(`/v1/templates/${params.id}/preview-url`),
        ]);
        setTpl(t);
        setMappings(t.config?.mappings || defaultMappings(t.fields));
        setPreviewUrl(p.url);
      } catch (e: any) {
        setErr(e.message);
      }
    })();
  }, [params.id, router]);

  function updateMapping(fieldName: string, patch: Partial<Mapping>) {
    setMappings((prev) => ({
      ...prev,
      [fieldName]: { ...(prev[fieldName] || { dataKey: fieldName }), ...patch },
    }));
  }

  function openGenerate() {
    if (!tpl) return;
    const skeleton: Record<string, string> = {};
    for (const f of tpl.fields) {
      const key = mappings[f.name]?.dataKey || f.name;
      skeleton[key] = "";
    }
    setGenJSON(JSON.stringify(skeleton, null, 2));
    setGenErr(null);
    setGenOpen(true);
  }

  async function runGenerate() {
    if (!tpl) return;
    setGenBusy(true);
    setGenErr(null);
    setGenProgress(null);
    try {
      let parsed: any;
      try {
        parsed = JSON.parse(genJSON);
      } catch {
        throw new Error("Invalid JSON");
      }
      const res = await api<{
        downloadUrl?: string;
        outputFileId?: string;
        jobId?: string;
        status?: string;
      }>(`/v1/templates/${tpl.id}/generate`, {
        method: "POST",
        body: JSON.stringify({ data: parsed, flatten: genFlatten, async: genAsync }),
      });

      if (res.jobId) {
        setGenProgress("queued…");
        const done = await pollJob(res.jobId, (j) => setGenProgress(`${j.status}…`));
        if (done.status === "failed") throw new Error(done.error || "job failed");
        if (done.outputFileId) {
          const dl = await api<{ downloadUrl: string }>(`/v1/files/${done.outputFileId}/download`);
          window.open(dl.downloadUrl, "_blank");
        }
      } else if (res.downloadUrl) {
        window.open(res.downloadUrl, "_blank");
      }
      setGenOpen(false);
    } catch (e: any) {
      setGenErr(e.message);
    } finally {
      setGenBusy(false);
      setGenProgress(null);
    }
  }

  async function runBatch(csv: File) {
    if (!tpl) return;
    setBatchBusy(`uploading ${csv.name}…`);
    try {
      const fd = new FormData();
      fd.append("csv", csv);
      const res = await api<{ jobId: string }>(`/v1/templates/${tpl.id}/batch`, {
        method: "POST",
        body: fd,
      });
      setBatchBusy("queued…");
      const done = await pollJob(res.jobId, (j) => {
        setBatchBusy(
          j.status === "running" && j.total > 0
            ? `rendering ${j.done}/${j.total}…`
            : `${j.status}…`
        );
      });
      if (done.status === "failed") throw new Error(done.error || "batch failed");
      if (done.outputFileId) {
        const dl = await api<{ downloadUrl: string }>(`/v1/files/${done.outputFileId}/download`);
        toast.show("success", `Batch rendered ${done.total} rows`);
        window.open(dl.downloadUrl, "_blank");
      }
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setBatchBusy(null);
    }
  }

  async function save() {
    if (!tpl) return;
    setSaving(true);
    setErr(null);
    setSavedMsg(null);
    try {
      const res = await api<{ version: number }>(`/v1/templates/${tpl.id}/config`, {
        method: "PUT",
        body: JSON.stringify({ config: { mappings } }),
      });
      setSavedMsg(`Saved v${res.version}`);
      toast.show("success", `Saved v${res.version}`);
      setTimeout(() => setSavedMsg(null), 2000);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (!tpl) {
    return (
      <div className="min-h-screen grid place-items-center text-gray-500">
        {err ? <span className="text-red-600">{err}</span> : "Loading…"}
      </div>
    );
  }

  if (tpl.mode === "static" && previewUrl) {
    return <StaticDesigner tpl={{ id: tpl.id, name: tpl.name, mode: tpl.mode, version: tpl.version, widgets: tpl.widgets || [] }} previewUrl={previewUrl} />;
  }

  if (tpl.mode === "html") {
    return (
      <HtmlDesigner
        tpl={{
          id: tpl.id,
          name: tpl.name,
          mode: tpl.mode,
          version: tpl.version,
          config: tpl.config || {},
        }}
      />
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/drive" className="text-blue-600 hover:underline text-sm">← Drive</Link>
          <h1 className="font-semibold">{tpl.name}</h1>
          <span className="text-xs uppercase tracking-wide bg-gray-100 px-2 py-0.5 rounded">{tpl.mode}</span>
          <span className="text-xs text-gray-500">v{tpl.version}</span>
        </div>
        <div className="flex items-center gap-3">
          {savedMsg && <span className="text-sm text-green-600">{savedMsg}</span>}
          {err && <span className="text-sm text-red-600">{err}</span>}
          <Link
            href={`/templates/${tpl.id}/versions`}
            className="text-sm text-blue-600 hover:underline"
          >
            Versions
          </Link>
          <Link
            href={`/templates/${tpl.id}/playground`}
            className="text-sm text-blue-600 hover:underline"
          >
            Playground
          </Link>
          <BatchButton busy={batchBusy} onFile={runBatch} />
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-sm border rounded hover:bg-gray-50 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save config"}
          </button>
          <button
            onClick={openGenerate}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Generate
          </button>
        </div>
      </header>

      {genOpen && (
        <div className="fixed inset-0 bg-black/40 grid place-items-center z-50" onClick={() => !genBusy && setGenOpen(false)}>
          <div className="bg-white rounded-lg shadow-xl w-[560px] max-w-[90vw] flex flex-col max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3 border-b flex items-center justify-between">
              <h3 className="font-semibold">Generate filled PDF</h3>
              <button onClick={() => !genBusy && setGenOpen(false)} className="text-gray-500 hover:text-gray-900">✕</button>
            </div>
            <div className="p-5 space-y-3 overflow-y-auto">
              <p className="text-sm text-gray-600">
                Paste a JSON payload. Keys should match the <strong>data key</strong> column.
              </p>
              <textarea
                className="w-full font-mono text-xs border rounded p-3 h-64"
                value={genJSON}
                onChange={(e) => setGenJSON(e.target.value)}
              />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={genFlatten} onChange={(e) => setGenFlatten(e.target.checked)} />
                Flatten (non-editable output)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={genAsync} onChange={(e) => setGenAsync(e.target.checked)} />
                Run asynchronously (via worker queue)
              </label>
              {genProgress && <div className="text-sm text-gray-600">Job: {genProgress}</div>}
              {genErr && <div className="text-sm text-red-600">{genErr}</div>}
            </div>
            <div className="px-5 py-3 border-t flex items-center justify-end gap-2">
              <button onClick={() => setGenOpen(false)} disabled={genBusy} className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">
                Cancel
              </button>
              <button
                onClick={runGenerate}
                disabled={genBusy}
                className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {genBusy ? "Generating…" : "Generate & download"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        <section className="flex-1 bg-gray-100 border-r min-h-0">
          {previewUrl ? (
            <iframe src={previewUrl} className="w-full h-full" title="PDF preview" />
          ) : (
            <div className="h-full grid place-items-center text-gray-500">No preview</div>
          )}
        </section>

        <aside className="w-[480px] bg-white overflow-y-auto">
          <div className="p-4 border-b">
            <h2 className="font-semibold">Field mapping</h2>
            <p className="text-xs text-gray-500 mt-1">
              {tpl.fields.length} field{tpl.fields.length === 1 ? "" : "s"} detected. Edit the data key
              used in the JSON payload when generating.
            </p>
          </div>

          {tpl.fields.length === 0 ? (
            <div className="p-6 text-sm text-gray-500">
              No AcroForm fields detected on this PDF.
            </div>
          ) : (
            <div className="divide-y">
              {tpl.fields.map((f) => {
                const m = mappings[f.name] || { dataKey: f.name };
                return (
                  <div key={f.name} className="p-4 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-mono text-sm">{f.name}</div>
                        <div className="text-xs text-gray-500">
                          {f.type}{f.page ? ` • page ${f.page}` : ""}
                        </div>
                      </div>
                      <label className="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          checked={!!m.required}
                          onChange={(e) => updateMapping(f.name, { required: e.target.checked })}
                        />
                        required
                      </label>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <input
                        className="border rounded px-2 py-1 text-sm font-mono"
                        placeholder="data key"
                        value={m.dataKey}
                        onChange={(e) => updateMapping(f.name, { dataKey: e.target.value })}
                      />
                      <input
                        className="border rounded px-2 py-1 text-sm"
                        placeholder="default value"
                        value={m.default || ""}
                        onChange={(e) => updateMapping(f.name, { default: e.target.value })}
                      />
                    </div>

                    <select
                      className="w-full border rounded px-2 py-1 text-sm"
                      value={m.transform || ""}
                      onChange={(e) => updateMapping(f.name, { transform: e.target.value || undefined })}
                    >
                      {TRANSFORMS.map((t) => (
                        <option key={t} value={t}>
                          {t ? `transform: ${t}` : "no transform"}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function defaultMappings(fields: Field[]): Record<string, Mapping> {
  const out: Record<string, Mapping> = {};
  for (const f of fields) out[f.name] = { dataKey: f.name };
  return out;
}

function BatchButton({
  busy,
  onFile,
}: {
  busy: string | null;
  onFile: (f: File) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        onClick={() => ref.current?.click()}
        disabled={!!busy}
        className="px-3 py-2 text-sm border rounded hover:bg-gray-50 disabled:opacity-50"
        title="Upload a CSV to generate one PDF per row"
      >
        {busy ?? "Batch CSV"}
      </button>
      <input
        ref={ref}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </>
  );
}
