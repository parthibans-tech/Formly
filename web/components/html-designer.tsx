"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api, pollJob } from "@/lib/api";
import { useToast } from "@/components/toast";

type Template = {
  id: string;
  name: string;
  mode: string;
  version: number;
  config: { placeholders?: string[] };
};

type Props = { tpl: Template };

export default function HtmlDesigner({ tpl: initialTpl }: Props) {
  const toast = useToast();
  const [tpl, setTpl] = useState(initialTpl);
  const [source, setSource] = useState("");
  const [sampleJSON, setSampleJSON] = useState("{}");
  const [saving, setSaving] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [genAsync, setGenAsync] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genProgress, setGenProgress] = useState<string | null>(null);
  const [genData, setGenData] = useState("{}");

  useEffect(() => {
    (async () => {
      try {
        const r = await api<{ source: string }>(`/v1/templates/${tpl.id}/source`);
        setSource(r.source);
        setSampleJSON(JSON.stringify(skeleton(tpl.config.placeholders || []), null, 2));
      } catch (e: any) {
        toast.show("error", e.message);
      }
    })();
  }, [tpl.id]);

  // Debounced client-side preview — replaces placeholders in the HTML with sample values.
  const previewSrcDoc = useMemo(() => {
    let data: any = {};
    try {
      data = JSON.parse(sampleJSON);
    } catch {
      /* keep last valid */
    }
    return renderPlaceholders(source, data);
  }, [source, sampleJSON]);

  async function save() {
    setSaving(true);
    try {
      const r = await api<{ version: number; placeholders: string[] }>(
        `/v1/templates/${tpl.id}/source`,
        { method: "PUT", body: JSON.stringify({ source }) }
      );
      setTpl({ ...tpl, version: r.version, config: { ...tpl.config, placeholders: r.placeholders } });
      toast.show("success", `Saved v${r.version}`);
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setSaving(false);
    }
  }

  function openGenerate() {
    setGenData(JSON.stringify(skeleton(tpl.config.placeholders || []), null, 2));
    setGenOpen(true);
  }

  async function runGenerate() {
    setGenBusy(true);
    setGenProgress(null);
    try {
      const data = JSON.parse(genData);
      const res = await api<{ downloadUrl?: string; jobId?: string; outputFileId?: string }>(
        `/v1/templates/${tpl.id}/generate`,
        { method: "POST", body: JSON.stringify({ data, async: genAsync }) }
      );
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
      toast.show("error", e.message);
    } finally {
      setGenBusy(false);
      setGenProgress(null);
    }
  }

  const placeholders = tpl.config.placeholders || [];

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/drive" className="text-blue-600 hover:underline text-sm">← Drive</Link>
          <h1 className="font-semibold">{tpl.name}</h1>
          <span className="text-xs uppercase tracking-wide bg-gray-100 px-2 py-0.5 rounded">html</span>
          <span className="text-xs text-gray-500">v{tpl.version}</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href={`/templates/${tpl.id}/versions`} className="text-sm text-blue-600 hover:underline">Versions</Link>
          <Link href={`/templates/${tpl.id}/playground`} className="text-sm text-blue-600 hover:underline">Playground</Link>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-sm border rounded hover:bg-gray-50 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save source"}
          </button>
          <button onClick={openGenerate} className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">
            Generate
          </button>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* Placeholders panel */}
        <aside className="w-60 bg-gray-50 border-r p-3 overflow-y-auto">
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">Placeholders</div>
          {placeholders.length === 0 ? (
            <div className="text-xs text-gray-500">
              No placeholders detected yet. Add <code>{"{{name}}"}</code> to your HTML and save.
            </div>
          ) : (
            <ul className="space-y-1">
              {placeholders.map((p) => (
                <li key={p} className="text-sm font-mono bg-white border rounded px-2 py-1">{"{{" + p + "}}"}</li>
              ))}
            </ul>
          )}
          <div className="pt-4 text-xs uppercase tracking-wide text-gray-500 mb-2">Sample data</div>
          <textarea
            className="w-full h-40 font-mono text-xs border rounded p-2"
            value={sampleJSON}
            onChange={(e) => setSampleJSON(e.target.value)}
          />
          <div className="text-[10px] text-gray-500 mt-1">
            Used for the live preview. Click Generate to render via Chromium.
          </div>
        </aside>

        {/* Editor */}
        <section className="flex-1 flex flex-col min-h-0 border-r">
          <div className="px-4 py-2 border-b bg-white text-xs text-gray-500">HTML source</div>
          <textarea
            value={source}
            onChange={(e) => setSource(e.target.value)}
            spellCheck={false}
            className="flex-1 font-mono text-xs p-4 outline-none resize-none"
            placeholder="<!doctype html><html>...</html>"
          />
        </section>

        {/* Preview */}
        <section className="flex-1 min-h-0 bg-gray-100">
          <div className="px-4 py-2 border-b bg-white text-xs text-gray-500">Live preview (client-side)</div>
          <iframe
            srcDoc={previewSrcDoc}
            className="w-full h-[calc(100%-33px)] bg-white"
            sandbox="allow-same-origin"
            title="Preview"
          />
        </section>
      </div>

      {genOpen && (
        <GenerateModal
          data={genData}
          setData={setGenData}
          async_={genAsync}
          setAsync={setGenAsync}
          busy={genBusy}
          progress={genProgress}
          onCancel={() => !genBusy && setGenOpen(false)}
          onRun={runGenerate}
        />
      )}
    </div>
  );
}

function GenerateModal(props: {
  data: string;
  setData: (v: string) => void;
  async_: boolean;
  setAsync: (v: boolean) => void;
  busy: boolean;
  progress: string | null;
  onCancel: () => void;
  onRun: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/40 grid place-items-center z-50" onClick={props.onCancel}>
      <div
        className="bg-white rounded-lg shadow-xl w-[560px] max-w-[90vw] flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b flex items-center justify-between">
          <h3 className="font-semibold">Generate filled PDF</h3>
          <button onClick={props.onCancel} className="text-gray-500 hover:text-gray-900">✕</button>
        </div>
        <div className="p-5 space-y-3 overflow-y-auto">
          <textarea
            className="w-full font-mono text-xs border rounded p-3 h-64"
            value={props.data}
            onChange={(e) => props.setData(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={props.async_} onChange={(e) => props.setAsync(e.target.checked)} />
            Run asynchronously (via worker queue)
          </label>
          {props.progress && <div className="text-sm text-gray-600">Job: {props.progress}</div>}
        </div>
        <div className="px-5 py-3 border-t flex items-center justify-end gap-2">
          <button onClick={props.onCancel} disabled={props.busy} className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">
            Cancel
          </button>
          <button
            onClick={props.onRun}
            disabled={props.busy}
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {props.busy ? "Generating…" : "Generate & download"}
          </button>
        </div>
      </div>
    </div>
  );
}

function skeleton(placeholders: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const p of placeholders) setDeep(out, p, "");
  return out;
}

function setDeep(obj: Record<string, any>, path: string, value: any) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

// Client-side placeholder substitution for the live preview.
// Intentionally simple: only handles {{name}} / {{a.b}}, no conditionals/loops.
function renderPlaceholders(src: string, data: any): string {
  return src.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g, (match, path) => {
    const v = pathGet(data, path);
    if (v === undefined || v === null) return "";
    return escapeHtml(String(v));
  });
}

function pathGet(obj: any, path: string): any {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
}
