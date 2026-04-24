"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  CloudUpload,
  FileCode,
  PencilLine,
  PlayCircle,
  Save,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import { api, getToken } from "@/lib/api";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm";
import { usePrompt } from "@/components/ui/prompt";

type Field = { name: string; type: string; page: number };
type Mapping = {
  dataKey: string;
  default?: string;
  required?: boolean;
  transform?: string;
};
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
  const confirm = useConfirm();
  const prompt = usePrompt();

  const [tpl, setTpl] = useState<Template | null>(null);
  const [sets, setSets] = useState<MockSet[]>([]);
  const [selectedSet, setSelectedSet] = useState<string>("");
  const [jsonText, setJsonText] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);

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
    return t.fields.map(
      (f) => t.config?.mappings?.[f.name]?.dataKey || f.name
    );
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
      // `preview: true` flips the server's presigned URL to inline
      // disposition so the PDF renders in the iframe below instead of
      // the browser prompting a download. Without it, Safari (and some
      // Chrome configurations) save the file as soon as the iframe src
      // updates, which defeats the whole point of the playground.
      const res = await api<{ downloadUrl: string }>(
        `/v1/templates/${tpl.id}/generate`,
        { method: "POST", body: JSON.stringify({ data, preview: true }) }
      );
      setPreviewUrl(res.downloadUrl);
      toast.show("success", "Rendered");
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setRunning(false);
    }
  }

  // saveToDrive is the opt-in "persist this render to my Drive" path —
  // distinct from Run, which intentionally previews without creating a
  // Drive row. We call generate WITHOUT `preview: true` so the server
  // takes the Runner.Run branch (inserts a files row + uploads to the
  // canonical outputs/ key) instead of RunPreview (temp blob, no row).
  // Users who just want to eyeball the output shouldn't have their
  // Drive polluted with dozens of near-identical PDFs.
  async function saveToDrive() {
    if (!tpl) return;
    setSaving(true);
    try {
      const data = JSON.parse(jsonText);
      const res = await api<{ outputFileId: string; outputName: string }>(
        `/v1/templates/${tpl.id}/generate`,
        { method: "POST", body: JSON.stringify({ data }) }
      );
      toast.show("success", `Saved "${res.outputName}" to Drive`);
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setSaving(false);
    }
  }

  function loadPreset(id: string) {
    setSelectedSet(id);
    const s = sets.find((x) => x.id === id);
    if (s) setJsonText(JSON.stringify(s.data, null, 2));
  }

  async function savePreset() {
    if (!tpl) return;
    const name = await prompt({
      title: "Save preset",
      label: "Preset name",
      placeholder: "e.g. Sample invoice",
      defaultValue: "Sample 1",
      confirmLabel: "Save",
      validate: (v) => (v.trim().length < 1 ? "Name is required" : null),
    });
    if (!name) return;
    try {
      const data = JSON.parse(jsonText);
      await api(`/v1/templates/${tpl.id}/mock-data`, {
        method: "POST",
        body: JSON.stringify({ name, data }),
      });
      const s = await api<{ sets: MockSet[] }>(
        `/v1/templates/${tpl.id}/mock-data`
      );
      setSets(s.sets);
      toast.show("success", `Saved "${name}"`);
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function deletePreset() {
    if (!tpl || !selectedSet) return;
    const ok = await confirm({
      title: "Delete this preset?",
      description: "This can't be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/templates/${tpl.id}/mock-data/${selectedSet}`, {
        method: "DELETE",
      });
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

  if (!tpl) {
    return (
      <div className="mx-auto max-w-7xl space-y-4 px-6 py-10">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/80 px-4 md:px-6 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/drive">
                <ArrowLeft className="h-4 w-4" />
                Drive
              </Link>
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold">{tpl.name}</h1>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="uppercase text-[10px]">
                  <Sparkles className="h-3 w-3" />
                  Playground
                </Badge>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/templates/${tpl.id}/api`}>
                <FileCode className="h-4 w-4" />
                API
              </Link>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/templates/${tpl.id}/designer`}>
                <PencilLine className="h-4 w-4" />
                Open designer
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        <section className="flex w-1/2 flex-col border-r bg-background min-h-0">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm">
            <Select value={selectedSet} onValueChange={loadPreset}>
              <SelectTrigger className="w-[200px] h-8">
                <SelectValue placeholder="Load preset…" />
              </SelectTrigger>
              <SelectContent>
                {sets.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    No presets saved yet
                  </div>
                ) : (
                  sets.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" onClick={savePreset}>
              <Save className="h-4 w-4" />
              Save as…
            </Button>
            {selectedSet && (
              <Button
                size="sm"
                variant="ghost"
                onClick={deletePreset}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={fillFake}>
              <Wand2 className="h-4 w-4" />
              Fake data
            </Button>
            <div className="flex-1" />
            <Button
              size="sm"
              variant="outline"
              onClick={saveToDrive}
              loading={saving}
              disabled={running}
            >
              <CloudUpload className="h-4 w-4" />
              Save to Drive
            </Button>
            <Button size="sm" onClick={run} loading={running} disabled={saving}>
              <PlayCircle className="h-4 w-4" />
              Run
            </Button>
          </div>
          <textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            spellCheck={false}
            className="flex-1 resize-none bg-background p-4 font-mono text-xs outline-none"
            placeholder='{"field": "value"}'
          />
        </section>

        <section className="w-1/2 bg-muted/40 min-h-0">
          {previewUrl ? (
            <iframe
              src={previewUrl}
              className="h-full w-full bg-background"
              title="Preview"
            />
          ) : (
            <div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">
              Press{" "}
              <kbd className="mx-1 rounded border bg-background px-1.5 py-0.5">
                Run
              </kbd>{" "}
              to render a preview
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
