"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/esm/Page/AnnotationLayer.css";
import "react-pdf/dist/esm/Page/TextLayer.css";
import { api, pollJob } from "@/lib/api";
import { useToast } from "@/components/toast";
import { browserToPdf, pdfToBrowser, PageInfo } from "@/lib/pdf-coords";

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.js`;

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
  name: string;
  mode: string;
  version: number;
  widgets: Widget[];
};

type Props = {
  tpl: Template;
  previewUrl: string;
};

const PALETTE: { type: Widget["type"]; label: string; defaultW: number; defaultH: number }[] = [
  { type: "text", label: "Text", defaultW: 160, defaultH: 18 },
  { type: "multiline", label: "Multiline", defaultW: 200, defaultH: 60 },
  { type: "date", label: "Date", defaultW: 110, defaultH: 18 },
  { type: "number", label: "Number", defaultW: 90, defaultH: 18 },
  { type: "currency", label: "Currency", defaultW: 120, defaultH: 18 },
  { type: "checkbox", label: "Checkbox", defaultW: 16, defaultH: 16 },
];

const SCALE = 1.5;

export default function StaticDesigner({ tpl, previewUrl }: Props) {
  const toast = useToast();
  const [widgets, setWidgets] = useState<Widget[]>(tpl.widgets);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageDims, setPageDims] = useState<Record<number, { w: number; h: number }>>({});
  const [saving, setSaving] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [genJSON, setGenJSON] = useState("{}");
  const [genAsync, setGenAsync] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genProgress, setGenProgress] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState<string | null>(null);

  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const selected = widgets.find((w) => w.id === selectedId) || null;

  const pageInfo = useCallback(
    (page: number): PageInfo | null => {
      const d = pageDims[page];
      if (!d) return null;
      return { widthPts: d.w, heightPts: d.h, scale: SCALE };
    },
    [pageDims]
  );

  // DRAG FROM PALETTE -----------------------------------------------------
  function onPaletteDragStart(e: React.DragEvent, type: string) {
    e.dataTransfer.setData("application/x-df-widget", type);
    e.dataTransfer.effectAllowed = "copy";
  }

  function onPageDragOver(e: React.DragEvent) {
    if (e.dataTransfer.types.includes("application/x-df-widget")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }

  function onPageDrop(e: React.DragEvent, page: number) {
    const type = e.dataTransfer.getData("application/x-df-widget");
    if (!type) return;
    e.preventDefault();
    const spec = PALETTE.find((p) => p.type === type);
    if (!spec) return;

    const rect = pageRefs.current[page]?.getBoundingClientRect();
    const info = pageInfo(page);
    if (!rect || !info) return;

    const bx = e.clientX - rect.left;
    const by = e.clientY - rect.top;
    const pdf = browserToPdf(
      { x: bx, y: by, w: spec.defaultW, h: spec.defaultH },
      info
    );

    const id = `w_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;
    const nextKey = `field_${widgets.length + 1}`;

    setWidgets((prev) => [
      ...prev,
      {
        id,
        type,
        page,
        x: pdf.x,
        y: pdf.y,
        w: pdf.w,
        h: pdf.h,
        dataKey: nextKey,
        zIndex: prev.length,
        props: defaultProps(type),
      },
    ]);
    setSelectedId(id);
  }

  // MOVE / RESIZE ---------------------------------------------------------
  type DragState =
    | { kind: "move"; id: string; startX: number; startY: number; orig: Widget }
    | { kind: "resize"; id: string; startX: number; startY: number; orig: Widget };

  const drag = useRef<DragState | null>(null);

  function beginMove(e: React.MouseEvent, w: Widget) {
    e.stopPropagation();
    setSelectedId(w.id);
    drag.current = { kind: "move", id: w.id, startX: e.clientX, startY: e.clientY, orig: w };
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", endDrag);
  }

  function beginResize(e: React.MouseEvent, w: Widget) {
    e.stopPropagation();
    setSelectedId(w.id);
    drag.current = { kind: "resize", id: w.id, startX: e.clientX, startY: e.clientY, orig: w };
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", endDrag);
  }

  const onDragMove = useCallback((e: MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    const dxPts = (e.clientX - d.startX) / SCALE;
    const dyPts = (e.clientY - d.startY) / SCALE;

    setWidgets((prev) =>
      prev.map((w) => {
        if (w.id !== d.id) return w;
        if (d.kind === "move") {
          // Browser Y grows down -> PDF Y grows up, so subtract dyPts.
          return { ...w, x: d.orig.x + dxPts, y: d.orig.y - dyPts };
        }
        // resize: grow/shrink from bottom-right in browser space → grow width and shrink PDF y.
        const newW = Math.max(8, d.orig.w + dxPts);
        const newH = Math.max(8, d.orig.h + dyPts);
        const dH = newH - d.orig.h;
        return { ...w, w: newW, h: newH, y: d.orig.y - dH };
      })
    );
  }, []);

  function endDrag() {
    drag.current = null;
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", endDrag);
  }

  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", onDragMove);
      window.removeEventListener("mouseup", endDrag);
    };
  }, [onDragMove]);

  // DELETE KEY ------------------------------------------------------------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
        setWidgets((w) => w.filter((x) => x.id !== selectedId));
        setSelectedId(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  // SAVE / GENERATE -------------------------------------------------------
  async function save() {
    setSaving(true);
    try {
      const payload = widgets.map((w) => ({
        type: w.type,
        page: w.page,
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
        dataKey: w.dataKey,
        zIndex: w.zIndex,
        props: w.props || {},
      }));
      await api(`/v1/templates/${tpl.id}/widgets`, {
        method: "PUT",
        body: JSON.stringify({ widgets: payload }),
      });
      toast.show("success", `Saved ${payload.length} widget${payload.length === 1 ? "" : "s"}`);
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setSaving(false);
    }
  }

  function openGenerate() {
    const skel: Record<string, string> = {};
    for (const w of widgets) skel[w.dataKey] = "";
    setGenJSON(JSON.stringify(skel, null, 2));
    setGenOpen(true);
  }

  async function runGenerate() {
    setGenBusy(true);
    setGenProgress(null);
    try {
      const data = JSON.parse(genJSON);
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

  async function runBatch(csv: File) {
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

  // UPDATES ---------------------------------------------------------------
  function updateSelected(patch: Partial<Widget>) {
    if (!selected) return;
    setWidgets((prev) => prev.map((w) => (w.id === selected.id ? { ...w, ...patch } : w)));
  }

  function updateSelectedProp(key: string, value: any) {
    if (!selected) return;
    updateSelected({ props: { ...selected.props, [key]: value } });
  }

  const paletteEls = useMemo(
    () =>
      PALETTE.map((p) => (
        <div
          key={p.type}
          draggable
          onDragStart={(e) => onPaletteDragStart(e, p.type)}
          className="px-3 py-2 border rounded bg-white cursor-grab hover:border-blue-500 text-sm select-none"
        >
          {p.label}
        </div>
      )),
    []
  );

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/drive" className="text-blue-600 hover:underline text-sm">← Drive</Link>
          <h1 className="font-semibold">{tpl.name}</h1>
          <span className="text-xs uppercase tracking-wide bg-gray-100 px-2 py-0.5 rounded">static</span>
          <span className="text-xs text-gray-500">v{tpl.version}</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href={`/templates/${tpl.id}/versions`} className="text-sm text-blue-600 hover:underline">
            Versions
          </Link>
          <Link href={`/templates/${tpl.id}/playground`} className="text-sm text-blue-600 hover:underline">
            Playground
          </Link>
          <StaticBatchButton busy={batchBusy} onFile={runBatch} />
          <button onClick={save} disabled={saving} className="px-4 py-2 text-sm border rounded hover:bg-gray-50 disabled:opacity-50">
            {saving ? "Saving…" : "Save layout"}
          </button>
          <button onClick={openGenerate} className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">
            Generate
          </button>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* Palette */}
        <aside className="w-48 bg-gray-50 border-r p-3 space-y-2">
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">Widgets</div>
          {paletteEls}
          <div className="text-xs text-gray-500 pt-4">Drag onto page. Click widget to edit. Press Del to remove.</div>
        </aside>

        {/* Canvas */}
        <section className="flex-1 overflow-auto bg-gray-200 p-6 min-h-0" onClick={() => setSelectedId(null)}>
          <Document
            file={previewUrl}
            onLoadSuccess={({ numPages }) => setNumPages(numPages)}
            loading={<div className="text-gray-500">Loading PDF…</div>}
            error={<div className="text-red-600">Failed to load PDF</div>}
          >
            {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
              <div
                key={pageNum}
                ref={(el) => (pageRefs.current[pageNum] = el)}
                onDragOver={onPageDragOver}
                onDrop={(e) => onPageDrop(e, pageNum)}
                className="relative mx-auto mb-6 shadow-lg"
                style={{ width: "fit-content" }}
              >
                <Page
                  pageNumber={pageNum}
                  scale={SCALE}
                  renderAnnotationLayer={false}
                  renderTextLayer={false}
                  onLoadSuccess={(p) => {
                    setPageDims((prev) => ({
                      ...prev,
                      [pageNum]: { w: p.originalWidth, h: p.originalHeight },
                    }));
                  }}
                />
                {/* Widget overlay */}
                <div className="absolute inset-0">
                  {widgets
                    .filter((w) => w.page === pageNum)
                    .map((w) => {
                      const info = pageInfo(pageNum);
                      if (!info) return null;
                      const b = pdfToBrowser(w, info);
                      const isSel = w.id === selectedId;
                      return (
                        <div
                          key={w.id}
                          onMouseDown={(e) => beginMove(e, w)}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedId(w.id);
                          }}
                          className={
                            "absolute border text-xs bg-blue-100/40 cursor-move overflow-hidden " +
                            (isSel ? "border-blue-600 ring-2 ring-blue-300" : "border-blue-400")
                          }
                          style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
                        >
                          <span className="pointer-events-none px-1 font-mono text-[10px] text-blue-900 truncate block">
                            {w.dataKey}
                          </span>
                          {isSel && (
                            <div
                              onMouseDown={(e) => beginResize(e, w)}
                              className="absolute bottom-0 right-0 w-3 h-3 bg-blue-600 cursor-se-resize"
                              style={{ transform: "translate(50%, 50%)" }}
                            />
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            ))}
          </Document>
        </section>

        {/* Properties */}
        <aside className="w-80 bg-white border-l overflow-y-auto">
          <div className="p-4 border-b">
            <h2 className="font-semibold">Properties</h2>
            <p className="text-xs text-gray-500 mt-1">
              {selected ? `Widget: ${selected.type}` : "Nothing selected"}
            </p>
          </div>
          {selected ? (
            <div className="p-4 space-y-3 text-sm">
              <Field label="Data key">
                <input
                  className="w-full border rounded px-2 py-1 font-mono text-sm"
                  value={selected.dataKey}
                  onChange={(e) => updateSelected({ dataKey: e.target.value })}
                />
              </Field>

              <div className="grid grid-cols-2 gap-2">
                <Field label="X (pt)">
                  <NumInput value={selected.x} onChange={(v) => updateSelected({ x: v })} />
                </Field>
                <Field label="Y (pt)">
                  <NumInput value={selected.y} onChange={(v) => updateSelected({ y: v })} />
                </Field>
                <Field label="W (pt)">
                  <NumInput value={selected.w} onChange={(v) => updateSelected({ w: v })} />
                </Field>
                <Field label="H (pt)">
                  <NumInput value={selected.h} onChange={(v) => updateSelected({ h: v })} />
                </Field>
              </div>

              {selected.type !== "checkbox" && (
                <>
                  <Field label="Font size">
                    <NumInput
                      value={selected.props?.fontSize ?? 12}
                      onChange={(v) => updateSelectedProp("fontSize", v)}
                    />
                  </Field>
                  <Field label="Color">
                    <input
                      type="color"
                      className="w-full h-8 border rounded"
                      value={selected.props?.color || "#111827"}
                      onChange={(e) => updateSelectedProp("color", e.target.value)}
                    />
                  </Field>
                  <Field label="Alignment">
                    <select
                      className="w-full border rounded px-2 py-1 text-sm"
                      value={selected.props?.align || "L"}
                      onChange={(e) => updateSelectedProp("align", e.target.value)}
                    >
                      <option value="L">Left</option>
                      <option value="C">Center</option>
                      <option value="R">Right</option>
                    </select>
                  </Field>
                </>
              )}

              <button
                onClick={() => {
                  setWidgets((w) => w.filter((x) => x.id !== selected.id));
                  setSelectedId(null);
                }}
                className="w-full mt-3 text-sm px-3 py-2 border border-red-300 text-red-600 rounded hover:bg-red-50"
              >
                Delete widget
              </button>
            </div>
          ) : (
            <div className="p-4 text-xs text-gray-500">
              Drag a widget from the palette onto the page, or click an existing widget to edit.
            </div>
          )}
        </aside>
      </div>

      {/* Generate modal */}
      {genOpen && (
        <div
          className="fixed inset-0 bg-black/40 grid place-items-center z-50"
          onClick={() => !genBusy && setGenOpen(false)}
        >
          <div
            className="bg-white rounded-lg shadow-xl w-[560px] max-w-[90vw] flex flex-col max-h-[85vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b flex items-center justify-between">
              <h3 className="font-semibold">Generate filled PDF</h3>
              <button onClick={() => !genBusy && setGenOpen(false)} className="text-gray-500 hover:text-gray-900">✕</button>
            </div>
            <div className="p-5 space-y-3 overflow-y-auto">
              <textarea
                className="w-full font-mono text-xs border rounded p-3 h-64"
                value={genJSON}
                onChange={(e) => setGenJSON(e.target.value)}
              />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={genAsync} onChange={(e) => setGenAsync(e.target.checked)} />
                Run asynchronously (via worker queue)
              </label>
              {genProgress && <div className="text-sm text-gray-600">Job: {genProgress}</div>}
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
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      {children}
    </label>
  );
}

function NumInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      step="0.1"
      className="w-full border rounded px-2 py-1 text-sm"
      value={Number(value.toFixed(2))}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        if (!Number.isNaN(v)) onChange(v);
      }}
    />
  );
}

function defaultProps(type: string): Record<string, any> {
  switch (type) {
    case "checkbox":
      return { color: "#111827" };
    case "multiline":
      return { fontSize: 11, fontFamily: "Helvetica", color: "#111827", align: "L" };
    default:
      return { fontSize: 12, fontFamily: "Helvetica", color: "#111827", align: "L" };
  }
}

function StaticBatchButton({ busy, onFile }: { busy: string | null; onFile: (f: File) => void }) {
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
