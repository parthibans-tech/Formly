"use client";

// AcroFormDesigner — Tier A visual mapping experience for /FT fields.
// Replaces the iframe + flat list with:
//   • react-pdf preview + click-to-map field overlays (left)
//   • sectioned, bulk-editable, live-preview mapping rows (right)
//   • auto-map dialog, schema export, field inspector

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileSpreadsheet,
  Layers,
  PlayCircle,
  Save,
  ScanSearch,
  Sparkles,
  Wand2,
} from "lucide-react";
import { api, pollJob } from "@/lib/api";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BatchDialog } from "@/components/batch-dialog";
import { PdfPreview } from "./pdf-preview";
import { FieldOverlay } from "./field-overlay";
import { MappingRow } from "./mapping-row";
import { FieldInspector } from "./field-inspector";
import { AutoMapDialog } from "./auto-map-dialog";
import { SchemaExportDialog } from "./schema-export";
import { BulkToolbar } from "./bulk-toolbar";
import type { AcroFormField, AcroMapping, MappingMap } from "./types";

type Tpl = {
  id: string;
  name: string;
  mode: string;
  version: number;
  fields: AcroFormField[];
  config: { mappings?: MappingMap };
};

type Props = {
  tpl: Tpl;
  previewUrl: string;
};

export function AcroFormDesigner({ tpl, previewUrl }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [mappings, setMappings] = useState<MappingMap>(
    tpl.config?.mappings || defaultMappings(tpl.fields)
  );
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set());
  const [sampleData, setSampleData] = useState<Record<string, any>>({});
  const [inspectorField, setInspectorField] = useState<AcroFormField | null>(null);
  const [autoMapOpen, setAutoMapOpen] = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [genJSON, setGenJSON] = useState("");
  const [genFlatten, setGenFlatten] = useState(false);
  const [genAsync, setGenAsync] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genErr, setGenErr] = useState<string | null>(null);
  const [genProgress, setGenProgress] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  // Load sample data from localStorage on mount.
  useEffect(() => {
    const key = `acroform-sample-${tpl.id}`;
    const stored = localStorage.getItem(key);
    if (stored) {
      try {
        setSampleData(JSON.parse(stored));
      } catch {
        // ignore corrupted entry
      }
    }
  }, [tpl.id]);

  // Persist sample data on change.
  useEffect(() => {
    if (Object.keys(sampleData).length === 0) return;
    localStorage.setItem(
      `acroform-sample-${tpl.id}`,
      JSON.stringify(sampleData)
    );
  }, [sampleData, tpl.id]);

  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const allDataKeys = useMemo(
    () => Object.values(mappings).map((m) => m.dataKey).filter(Boolean),
    [mappings]
  );

  // Group fields by section.
  const grouped = useMemo(() => {
    const m = new Map<string, AcroFormField[]>();
    for (const f of tpl.fields) {
      const section = mappings[f.name]?.section || "";
      if (!m.has(section)) m.set(section, []);
      m.get(section)!.push(f);
    }
    return m;
  }, [tpl.fields, mappings]);

  function updateMapping(fieldName: string, patch: Partial<AcroMapping>) {
    setMappings((prev) => ({
      ...prev,
      [fieldName]: {
        ...(prev[fieldName] || { dataKey: fieldName }),
        ...patch,
      },
    }));
  }

  function bulkPatch(names: string[], patch: Partial<AcroMapping>) {
    setMappings((prev) => {
      const next = { ...prev };
      for (const n of names) {
        next[n] = { ...(next[n] || { dataKey: n }), ...patch };
      }
      return next;
    });
  }

  function bulkRename(names: string[], pattern: string, replacement: string) {
    if (!pattern) return;
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      toast.show("error", "Invalid regex");
      return;
    }
    setMappings((prev) => {
      const next = { ...prev };
      for (const n of names) {
        const cur = next[n]?.dataKey ?? n;
        const updated = cur.replace(re, replacement);
        next[n] = { ...(next[n] || { dataKey: n }), dataKey: updated };
      }
      return next;
    });
  }

  function bulkAutoKey(names: string[], style: "snake" | "camel" | "kebab") {
    setMappings((prev) => {
      const next = { ...prev };
      for (const n of names) {
        const parts = n
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .split(/[^a-zA-Z0-9]+/)
          .filter(Boolean);
        let key: string;
        if (style === "snake") key = parts.map((p) => p.toLowerCase()).join("_");
        else if (style === "kebab") key = parts.map((p) => p.toLowerCase()).join("-");
        else
          key =
            parts
              .map((p, i) =>
                i === 0
                  ? p.toLowerCase()
                  : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()
              )
              .join("") || n;
        next[n] = { ...(next[n] || { dataKey: n }), dataKey: key };
      }
      return next;
    });
  }

  function toggleMultiSelect(name: string) {
    setMultiSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function selectField(name: string) {
    setSelectedField(name);
    const el = rowRefs.current[name];
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function applyAutoMap(matches: Record<string, string>, sample: Record<string, any>) {
    setMappings((prev) => {
      const next = { ...prev };
      for (const [fieldName, dataKey] of Object.entries(matches)) {
        next[fieldName] = { ...(next[fieldName] || { dataKey }), dataKey };
      }
      return next;
    });
    setSampleData(sample);
    toast.show(
      "success",
      `Mapped ${Object.keys(matches).length} field${Object.keys(matches).length === 1 ? "" : "s"}`
    );
  }

  function toggleSection(name: string) {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function openGenerate() {
    const skeleton: Record<string, any> = {};
    for (const f of tpl.fields) {
      const dk = mappings[f.name]?.dataKey;
      if (dk) skeleton[dk] = sampleData[dk] ?? "";
    }
    setGenJSON(JSON.stringify(skeleton, null, 2));
    setGenErr(null);
    setGenOpen(true);
  }

  async function runGenerate() {
    setGenBusy(true);
    setGenErr(null);
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
      }>(`/v1/templates/${tpl.id}/generate`, {
        method: "POST",
        body: JSON.stringify({ data: parsed, flatten: genFlatten, async: genAsync }),
      });

      if (res.jobId) {
        setGenProgress("queued…");
        const done = await pollJob(res.jobId, (j) => setGenProgress(`${j.status}…`));
        if (done.status === "failed") throw new Error(done.error || "job failed");
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

  async function save() {
    setSaving(true);
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
      toast.show("error", e.message);
    } finally {
      setSaving(false);
    }
  }

  const selectedArray = Array.from(multiSelected);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/80 px-4 py-3 backdrop-blur md:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/drive">
                <ArrowLeft className="h-4 w-4" /> Drive
              </Link>
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <div>
              <h1 className="text-sm font-semibold">{tpl.name}</h1>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px] uppercase">
                  {tpl.mode}
                </Badge>
                <span className="text-xs text-muted-foreground">v{tpl.version}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {savedMsg && (
              <span className="hidden items-center gap-1 text-xs text-emerald-600 md:inline-flex">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {savedMsg}
              </span>
            )}
            <Button variant="ghost" size="sm" onClick={() => setAutoMapOpen(true)}>
              <Wand2 className="h-4 w-4" /> Auto-map
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSchemaOpen(true)}>
              <ScanSearch className="h-4 w-4" /> Export schema
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/templates/${tpl.id}/versions`}>
                <Layers className="h-4 w-4" /> Versions
              </Link>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/templates/${tpl.id}/playground`}>
                <Sparkles className="h-4 w-4" /> Playground
              </Link>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setBatchOpen(true)}>
              <FileSpreadsheet className="h-4 w-4" /> Batch
            </Button>
            <Button variant="outline" size="sm" onClick={save} loading={saving}>
              <Save className="h-4 w-4" /> Save
            </Button>
            <Button size="sm" onClick={openGenerate}>
              <PlayCircle className="h-4 w-4" /> Generate
            </Button>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <section className="flex-1 border-r">
          <PdfPreview
            url={previewUrl}
            overlayForPage={(rp) => (
              <FieldOverlay
                page={rp}
                fields={tpl.fields}
                mappings={mappings}
                selectedField={selectedField}
                sampleData={sampleData}
                onSelect={selectField}
              />
            )}
          />
        </section>

        <aside className="w-[480px] shrink-0 overflow-y-auto bg-background">
          <BulkToolbar
            selectedNames={selectedArray}
            onClear={() => setMultiSelected(new Set())}
            onApplyPatch={bulkPatch}
            onRename={bulkRename}
            onAutoKey={bulkAutoKey}
          />

          <div className="border-b p-4">
            <h2 className="text-sm font-semibold">Field mapping</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {tpl.fields.length} field{tpl.fields.length === 1 ? "" : "s"}.
              Click a field in the PDF to jump here; click the checkbox to
              multi-select for bulk actions.
            </p>
          </div>

          {tpl.fields.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              No AcroForm fields detected on this PDF.
            </div>
          ) : (
            <div>
              {Array.from(grouped.entries()).map(([section, fields]) => {
                const collapsed = collapsedSections.has(section);
                const title = section || "Ungrouped";
                return (
                  <div key={section}>
                    <button
                      type="button"
                      onClick={() => toggleSection(section)}
                      className="flex w-full items-center justify-between border-b bg-muted/30 px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted/60"
                    >
                      <span className="flex items-center gap-1.5">
                        {collapsed ? (
                          <ChevronRight className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" />
                        )}
                        {title}
                      </span>
                      <span className="text-[10px]">{fields.length}</span>
                    </button>
                    {!collapsed && (
                      <div className="divide-y">
                        {fields.map((f) => {
                          const m = mappings[f.name] || { dataKey: f.name };
                          return (
                            <MappingRow
                              key={f.name}
                              ref={(el) => {
                                rowRefs.current[f.name] = el;
                              }}
                              field={f}
                              mapping={m}
                              selected={selectedField === f.name}
                              multiSelected={multiSelected.has(f.name)}
                              onToggleMultiSelect={() => toggleMultiSelect(f.name)}
                              allFieldDataKeys={allDataKeys}
                              sampleData={sampleData}
                              onSelect={() => setSelectedField(f.name)}
                              onChange={(patch) => updateMapping(f.name, patch)}
                              onOpenInspector={() => setInspectorField(f)}
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </aside>
      </div>

      <FieldInspector
        field={inspectorField}
        open={!!inspectorField}
        onOpenChange={(o) => !o && setInspectorField(null)}
      />

      <AutoMapDialog
        open={autoMapOpen}
        fields={tpl.fields}
        onOpenChange={setAutoMapOpen}
        onApply={applyAutoMap}
      />

      <SchemaExportDialog
        open={schemaOpen}
        onOpenChange={setSchemaOpen}
        fields={tpl.fields}
        mappings={mappings}
      />

      <Dialog open={genOpen} onOpenChange={(o) => !genBusy && setGenOpen(o)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Generate filled PDF</DialogTitle>
            <DialogDescription>
              Keys should match the <strong>data key</strong> column.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <textarea
              className="h-64 w-full rounded-md border bg-background p-3 font-mono text-xs"
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
            <Button variant="outline" onClick={() => setGenOpen(false)} disabled={genBusy}>
              Cancel
            </Button>
            <Button onClick={runGenerate} loading={genBusy}>
              <PlayCircle className="h-4 w-4" /> Generate &amp; download
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

function defaultMappings(fields: AcroFormField[]): MappingMap {
  const out: MappingMap = {};
  for (const f of fields) out[f.name] = { dataKey: f.name };
  return out;
}
