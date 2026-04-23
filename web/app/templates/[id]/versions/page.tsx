"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api, getToken } from "@/lib/api";
import { useToast } from "@/components/toast";

type Version = {
  version: number;
  authorId?: string;
  createdAt: string;
  config: any;
};

type Template = { id: string; name: string; mode: string; version: number };

export default function VersionsPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const toast = useToast();
  const [tpl, setTpl] = useState<Template | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [selectedA, setSelectedA] = useState<number | null>(null);
  const [selectedB, setSelectedB] = useState<number | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    load();
  }, [params.id, router]);

  async function load() {
    try {
      const [t, v] = await Promise.all([
        api<Template>(`/v1/templates/${params.id}`),
        api<{ versions: Version[] }>(`/v1/templates/${params.id}/versions`),
      ]);
      setTpl(t);
      setVersions(v.versions);
      if (v.versions.length >= 2) {
        setSelectedA(v.versions[1].version);
        setSelectedB(v.versions[0].version);
      } else if (v.versions.length === 1) {
        setSelectedB(v.versions[0].version);
      }
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function restore(v: number) {
    if (!confirm(`Restore v${v}? This creates a new current version.`)) return;
    try {
      const res = await api<{ version: number }>(`/v1/templates/${params.id}/versions/${v}/restore`, {
        method: "POST",
      });
      toast.show("success", `Restored — now at v${res.version}`);
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  const a = versions.find((v) => v.version === selectedA) || null;
  const b = versions.find((v) => v.version === selectedB) || null;

  if (!tpl) return <div className="min-h-screen grid place-items-center text-gray-500">Loading…</div>;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href={`/templates/${tpl.id}/designer`} className="text-blue-600 hover:underline text-sm">
            ← Designer
          </Link>
          <h1 className="font-semibold">{tpl.name}</h1>
          <span className="text-xs uppercase tracking-wide bg-gray-100 px-2 py-0.5 rounded">versions</span>
          <span className="text-xs text-gray-500">current v{tpl.version}</span>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <aside className="w-64 border-r bg-white overflow-y-auto">
          {versions.length === 0 ? (
            <div className="p-4 text-sm text-gray-500">No saved versions yet.</div>
          ) : (
            <div className="divide-y">
              {versions.map((v) => (
                <div key={v.version} className="p-3 flex items-center gap-2 text-sm">
                  <button
                    onClick={() => setSelectedB(v.version)}
                    className={
                      "flex-1 text-left " + (selectedB === v.version ? "font-semibold text-blue-600" : "")
                    }
                  >
                    v{v.version}
                    <span className="block text-xs text-gray-500">
                      {new Date(v.createdAt).toLocaleString()}
                    </span>
                  </button>
                  <button onClick={() => setSelectedA(v.version)} title="Compare as base"
                    className={"text-xs px-2 py-1 rounded border " + (selectedA === v.version ? "bg-blue-50 border-blue-500" : "")}>
                    A
                  </button>
                  <button onClick={() => restore(v.version)} className="text-xs text-red-600 hover:underline">
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </aside>

        <section className="flex-1 grid grid-cols-2 gap-0 min-h-0">
          <Pane title={`v${a?.version ?? "—"} (base)`} config={a?.config} />
          <Pane title={`v${b?.version ?? "—"}`} config={b?.config} />
        </section>
      </div>
    </div>
  );
}

function Pane({ title, config }: { title: string; config: any }) {
  return (
    <div className="flex flex-col border-r bg-gray-50 min-h-0">
      <div className="px-4 py-2 border-b bg-white text-sm font-medium">{title}</div>
      <pre className="flex-1 overflow-auto p-4 text-xs font-mono bg-white">
        {config ? JSON.stringify(config, null, 2) : "—"}
      </pre>
    </div>
  );
}
