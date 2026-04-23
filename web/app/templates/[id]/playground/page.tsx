"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api, getToken } from "@/lib/api";
import { useToast } from "@/components/toast";

type Field = { name: string; type: string; page: number };
type Mapping = { dataKey: string; default?: string; required?: boolean; transform?: string };
type Template = {
  id: string;
  name: string;
  mode: string;
  fields: Field[];
  config: { mappings?: Record<string, Mapping> };
};
type MockSet = { id: string; name: string; data: any; updatedAt: string };

export default function PlaygroundPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const toast = useToast();

  const [tpl, setTpl] = useState<Template | null>(null);
  const [sets, setSets] = useState<MockSet[]>([]);
  const [selectedSet, setSelectedSet] = useState<string>("");
  const [jsonText, setJsonText] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    (async () => {
      try {
        const [t, s] = await Promise.all([
          api<Template>(`/v1/templates/${params.id}`),
          api<{ sets: MockSet[] }>(`/v1/templates/${params.id}/mock-data`),
        ]);
        setTpl(t);
        setSets(s.sets);
        setJsonText(JSON.stringify(skeleton(t), null, 2));
      } catch (e: any) {
        toast.show("error", e.message);
      }
    })();
  }, [params.id, router]);

  function dataKeys(t: Template) {
    return t.fields.map((f) => t.config?.mappings?.[f.name]?.dataKey || f.name);
  }

  function skeleton(t: Template) {
    const out: Record<string, string> = {};
    for (const k of dataKeys(t)) out[k] = "";
    return out;
  }

  function fakeFor(t: Template) {
    const keys = dataKeys(t);
    const out: Record<string, any> = {};
    for (const k of keys) out[k] = fakeValue(k);
    return out;
  }

  async function run() {
    if (!tpl) return;
    setRunning(true);
    try {
      const data = JSON.parse(jsonText);
      const res = await api<{ downloadUrl: string }>(`/v1/templates/${tpl.id}/generate`, {
        method: "POST",
        body: JSON.stringify({ data }),
      });
      setPreviewUrl(res.downloadUrl);
      toast.show("success", "Rendered");
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setRunning(false);
    }
  }

  function loadPreset(id: string) {
    setSelectedSet(id);
    const s = sets.find((x) => x.id === id);
    if (s) setJsonText(JSON.stringify(s.data, null, 2));
  }

  async function savePreset() {
    if (!tpl) return;
    const name = prompt("Preset name", "Sample 1");
    if (!name) return;
    try {
      const data = JSON.parse(jsonText);
      await api(`/v1/templates/${tpl.id}/mock-data`, {
        method: "POST",
        body: JSON.stringify({ name, data }),
      });
      const s = await api<{ sets: MockSet[] }>(`/v1/templates/${tpl.id}/mock-data`);
      setSets(s.sets);
      toast.show("success", `Saved "${name}"`);
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function deletePreset() {
    if (!tpl || !selectedSet) return;
    if (!confirm("Delete this preset?")) return;
    try {
      await api(`/v1/templates/${tpl.id}/mock-data/${selectedSet}`, { method: "DELETE" });
      setSets(sets.filter((s) => s.id !== selectedSet));
      setSelectedSet("");
      toast.show("success", "Preset deleted");
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  function fillFake() {
    if (!tpl) return;
    setJsonText(JSON.stringify(fakeFor(tpl), null, 2));
  }

  if (!tpl) return <div className="min-h-screen grid place-items-center text-gray-500">Loading…</div>;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/drive" className="text-blue-600 hover:underline text-sm">← Drive</Link>
          <h1 className="font-semibold">{tpl.name}</h1>
          <span className="text-xs uppercase tracking-wide bg-gray-100 px-2 py-0.5 rounded">Playground</span>
        </div>
        <Link href={`/templates/${tpl.id}/designer`} className="text-sm text-blue-600 hover:underline">
          Open designer
        </Link>
      </header>

      <div className="flex-1 flex min-h-0">
        <section className="w-1/2 flex flex-col border-r bg-white min-h-0">
          <div className="px-4 py-2 border-b flex items-center gap-2 text-sm">
            <select
              value={selectedSet}
              onChange={(e) => loadPreset(e.target.value)}
              className="border rounded px-2 py-1 text-sm"
            >
              <option value="">Load preset…</option>
              {sets.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <button onClick={savePreset} className="px-2 py-1 border rounded hover:bg-gray-50">Save as…</button>
            {selectedSet && (
              <button onClick={deletePreset} className="px-2 py-1 text-red-600 border rounded hover:bg-red-50">
                Delete
              </button>
            )}
            <button onClick={fillFake} className="px-2 py-1 border rounded hover:bg-gray-50">
              Fill with fake data
            </button>
            <div className="flex-1" />
            <button
              onClick={run}
              disabled={running}
              className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {running ? "Rendering…" : "Run ▶"}
            </button>
          </div>
          <textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            spellCheck={false}
            className="flex-1 font-mono text-xs p-4 resize-none outline-none"
            placeholder='{"field": "value"}'
          />
        </section>

        <section className="w-1/2 bg-gray-100 min-h-0">
          {previewUrl ? (
            <iframe src={previewUrl} className="w-full h-full bg-white" title="Preview" />
          ) : (
            <div className="h-full grid place-items-center text-sm text-gray-500">
              Press <kbd className="mx-1 px-1.5 py-0.5 bg-white rounded border">Run ▶</kbd> to render preview
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function fakeValue(key: string): any {
  const k = key.toLowerCase();
  if (/name/.test(k)) return "Alice Johnson";
  if (/email/.test(k)) return "alice@example.com";
  if (/phone/.test(k)) return "+1 (555) 123-4567";
  if (/addr|street/.test(k)) return "123 Main Street";
  if (/city/.test(k)) return "Portland";
  if (/state/.test(k)) return "OR";
  if (/zip|postal/.test(k)) return "97201";
  if (/country/.test(k)) return "USA";
  if (/date/.test(k)) return new Date().toISOString().slice(0, 10);
  if (/amount|total|price|cost/.test(k)) return "1,250.00";
  if (/id|number|no$/.test(k)) return "INV-0042";
  if (/company|org/.test(k)) return "Acme Corp";
  return "Sample value";
}
