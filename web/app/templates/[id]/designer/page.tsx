"use client";
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  FileSpreadsheet,
  Layers,
  PlayCircle,
  Save,
  Sparkles,
} from "lucide-react";
import { api, getToken, pollJob } from "@/lib/api";
import { useToast } from "@/components/toast";
import StaticDesigner from "@/components/static-designer";
import HtmlDesigner from "@/components/html-designer";
import MarkdownDesigner from "@/components/markdown-designer";
import { AcroFormDesigner } from "@/components/acroform/acroform-designer";
import DocDesigner, {
  type DocDesignerTemplate,
} from "@/components/doc-designer/designer";
import ImageDesigner from "@/components/image-designer";
import { TemplateViewer } from "@/components/template-viewer";
import { BatchDialog } from "@/components/batch-dialog";
import { ApiGuideSheet } from "@/components/api-guide-trigger";
import { DocAITools } from "@/components/doc-ai-tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
  config: { mappings?: Record<string, Mapping>; placeholders?: string[]; pageLayout?: any };
  fields: Field[];
  widgets: Widget[];
  // Server-computed edit permission. When false the UI drops into
  // read-only mode (banner + disabled Save/Rename) so viewers don't
  // edit locally and then hit a 403 on save.
  canEdit: boolean;
};

const TRANSFORMS = [
  { value: "none", label: "No transform" },
  { value: "uppercase", label: "Uppercase" },
  { value: "lowercase", label: "Lowercase" },
  { value: "date", label: "Date" },
  { value: "currency", label: "Currency" },
];

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
  const [batchOpen, setBatchOpen] = useState(false);
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
        body: JSON.stringify({
          data: parsed,
          flatten: genFlatten,
          async: genAsync,
        }),
      });

      if (res.jobId) {
        setGenProgress("queued…");
        const done = await pollJob(res.jobId, (j) =>
          setGenProgress(`${j.status}…`)
        );
        if (done.status === "failed")
          throw new Error(done.error || "job failed");
        if (done.outputFileId) {
          const dl = await api<{ downloadUrl: string }>(
            `/v1/files/${done.outputFileId}/download`
          );
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
    setBatchBusy(`Uploading ${csv.name}…`);
    try {
      const fd = new FormData();
      fd.append("csv", csv);
      const res = await api<{ jobId: string }>(
        `/v1/templates/${tpl.id}/batch`,
        {
          method: "POST",
          body: fd,
        }
      );
      setBatchBusy("Queued…");
      const done = await pollJob(res.jobId, (j) => {
        setBatchBusy(
          j.status === "running" && j.total > 0
            ? `Rendering ${j.done}/${j.total}…`
            : `${j.status}…`
        );
      });
      if (done.status === "failed")
        throw new Error(done.error || "batch failed");
      if (done.outputFileId) {
        const dl = await api<{ downloadUrl: string }>(
          `/v1/files/${done.outputFileId}/download`
        );
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
      const res = await api<{ version: number }>(
        `/v1/templates/${tpl.id}/config`,
        {
          method: "PUT",
          body: JSON.stringify({ config: { mappings } }),
        }
      );
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
      <div className="min-h-screen">
        <div className="mx-auto max-w-7xl px-6 py-10">
          {err ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
              {err}
            </div>
          ) : (
            <div className="space-y-4">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-4 w-96" />
              <Skeleton className="h-96 w-full" />
            </div>
          )}
        </div>
      </div>
    );
  }

  // Viewer-scoped shares (resource_shares role=viewer) land on the same
  // URL as editors but must NOT see the designer — no edit sidebars, no
  // widget palettes, no save buttons, period. We route them to a
  // dedicated read-only viewer component *before* any mode-specific
  // designer mounts. The `readOnly` prop threaded into child designers
  // below stays as defense-in-depth in case canEdit ever lies.
  if (!tpl.canEdit) {
    return (
      <TemplateViewer
        tpl={{
          id: tpl.id,
          fileId: tpl.fileId,
          name: tpl.name,
          mode: tpl.mode,
          version: tpl.version,
          fields: tpl.fields,
          config: tpl.config,
        }}
        previewUrl={previewUrl}
      />
    );
  }

  if (tpl.mode === "static" && previewUrl) {
    return (
      <StaticDesigner
        tpl={{
          id: tpl.id,
          name: tpl.name,
          mode: tpl.mode,
          version: tpl.version,
          widgets: tpl.widgets || [],
          config: tpl.config || {},
        }}
        previewUrl={previewUrl}
        fileId={tpl.fileId}
      />
    );
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
        fileId={tpl.fileId}
      />
    );
  }

  if (tpl.mode === "markdown") {
    return (
      <MarkdownDesigner
        tpl={{
          id: tpl.id,
          name: tpl.name,
          mode: tpl.mode,
          version: tpl.version,
          config: tpl.config || {},
        }}
        fileId={tpl.fileId}
      />
    );
  }

  if (tpl.mode === "doc") {
    return (
      <DocDesigner
        tpl={{
          id: tpl.id,
          name: tpl.name,
          mode: tpl.mode,
          version: tpl.version,
          fileId: tpl.fileId,
          config: (tpl.config as DocDesignerTemplate["config"]) || {},
        }}
        fileId={tpl.fileId}
      />
    );
  }

  if (tpl.mode === "image" && previewUrl) {
    // Raster-image editor — crop / rotate / flip / resize / HD-upscale /
    // brightness-contrast-saturation / filters / quality + format swap.
    // Same canvas-based designer surface as the others, but the
    // "ops pipeline" runs server-side via /v1/templates/:id/images/transform
    // so we don't duplicate pixel math between Go and TS.
    return (
      <ImageDesigner
        tpl={{
          id: tpl.id,
          name: tpl.name,
          mode: tpl.mode,
          version: tpl.version,
          config: (tpl.config as any) || {},
        }}
        previewUrl={previewUrl}
        fileId={tpl.fileId}
      />
    );
  }

  if (tpl.mode === "acroform" && previewUrl) {
    return (
      <AcroFormDesigner
        tpl={{
          id: tpl.id,
          name: tpl.name,
          mode: tpl.mode,
          version: tpl.version,
          fields: (tpl.fields as any) || [],
          config: (tpl.config as any) || {},
        }}
        previewUrl={previewUrl}
        fileId={tpl.fileId}
      />
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
                  {tpl.mode}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  v{tpl.version}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {savedMsg && (
              <span className="hidden items-center gap-1 text-xs text-success md:inline-flex">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {savedMsg}
              </span>
            )}
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/templates/${tpl.id}/versions`}>
                <Layers className="h-4 w-4" />
                Versions
              </Link>
            </Button>
            {/* API guide opens inline as a right-side drawer so the
                user never loses their place in the designer. The
                guide's field table, snippets, and JSON Schema are all
                derived from the template's current config, so viewing
                "what will integrators see when I add/rename this
                field?" is one click away. A standalone route at
                /templates/:id/api mirrors this content for shareable
                URLs. */}
            <ApiGuideSheet templateId={tpl.id} templateName={tpl.name} />
            {/* OCR + AI for the source PDF — same drawer pair the
                other designer modes expose. Useful here because the
                fallback acroform editor tends to need cross-reference
                between AcroForm field metadata and prose in the PDF. */}
            {tpl.fileId ? (
              <DocAITools fileId={tpl.fileId} fileName={tpl.name} />
            ) : null}
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/templates/${tpl.id}/playground`}>
                <Sparkles className="h-4 w-4" />
                Playground
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setBatchOpen(true)}
            >
              <FileSpreadsheet className="h-4 w-4" />
              Batch
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={save}
              loading={saving}
            >
              <Save className="h-4 w-4" />
              Save
            </Button>
            <Button size="sm" onClick={openGenerate}>
              <PlayCircle className="h-4 w-4" />
              Generate
            </Button>
          </div>
        </div>
        {err && (
          <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {err}
          </div>
        )}
      </header>

      <div className="flex flex-1 min-h-0">
        <section className="flex-1 border-r bg-muted/40">
          {previewUrl ? (
            <iframe
              src={previewUrl}
              className="h-full w-full"
              title="PDF preview"
            />
          ) : (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">
              No preview available
            </div>
          )}
        </section>

        <aside className="w-[480px] shrink-0 overflow-y-auto bg-background">
          <div className="border-b p-5">
            <h2 className="font-semibold">Field mapping</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {tpl.fields.length} field{tpl.fields.length === 1 ? "" : "s"}{" "}
              detected. Edit the data key used in the JSON payload when
              generating.
            </p>
          </div>

          {tpl.fields.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              No AcroForm fields detected on this PDF.
            </div>
          ) : (
            <div className="divide-y">
              {tpl.fields.map((f) => {
                const m = mappings[f.name] || { dataKey: f.name };
                return (
                  <div key={f.name} className="space-y-3 p-5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-mono text-sm">
                          {f.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {f.type}
                          {f.page ? ` • page ${f.page}` : ""}
                        </div>
                      </div>
                      <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-primary"
                          checked={!!m.required}
                          onChange={(e) =>
                            updateMapping(f.name, { required: e.target.checked })
                          }
                        />
                        Required
                      </label>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-xs">Data key</Label>
                        <Input
                          className="font-mono text-xs h-8"
                          placeholder="data key"
                          value={m.dataKey}
                          onChange={(e) =>
                            updateMapping(f.name, { dataKey: e.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Default</Label>
                        <Input
                          className="text-xs h-8"
                          placeholder="(none)"
                          value={m.default || ""}
                          onChange={(e) =>
                            updateMapping(f.name, { default: e.target.value })
                          }
                        />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-xs">Transform</Label>
                      <Select
                        value={m.transform || "none"}
                        onValueChange={(v) =>
                          updateMapping(f.name, {
                            transform: v === "none" ? undefined : v,
                          })
                        }
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TRANSFORMS.map((t) => (
                            <SelectItem key={t.value} value={t.value}>
                              {t.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </aside>
      </div>

      <Dialog open={genOpen} onOpenChange={(o) => !genBusy && setGenOpen(o)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Generate filled PDF</DialogTitle>
            <DialogDescription>
              Paste a JSON payload. Keys should match the{" "}
              <strong>data key</strong> column.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <textarea
              className="h-64 w-full rounded-md border bg-background p-3 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={genJSON}
              onChange={(e) => setGenJSON(e.target.value)}
            />
            <div className="flex flex-col gap-2 text-sm">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={genFlatten}
                  onChange={(e) => setGenFlatten(e.target.checked)}
                />
                Flatten (non-editable output)
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={genAsync}
                  onChange={(e) => setGenAsync(e.target.checked)}
                />
                Run asynchronously (via worker queue)
              </label>
            </div>
            {genProgress && (
              <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                Job: {genProgress}
              </div>
            )}
            {genErr && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {genErr}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setGenOpen(false)}
              disabled={genBusy}
            >
              Cancel
            </Button>
            <Button onClick={runGenerate} loading={genBusy}>
              <PlayCircle className="h-4 w-4" />
              Generate &amp; download
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BatchDialog
        open={batchOpen}
        onOpenChange={setBatchOpen}
        templateId={tpl.id}
      />
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
      <Button
        size="sm"
        variant="ghost"
        onClick={() => ref.current?.click()}
        disabled={!!busy}
        title="Upload a CSV to generate one PDF per row"
      >
        <FileSpreadsheet className="h-4 w-4" />
        {busy ?? "Batch CSV"}
      </Button>
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
