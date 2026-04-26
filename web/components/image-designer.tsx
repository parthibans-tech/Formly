"use client";

// Image designer — the editing surface for mode=image templates.
//
// This is a single-component editor (no third-party crop lib) wired to
// the server-side pipeline at POST /v1/templates/:id/images/transform.
// The server is the source of truth for pixel ops; the client only
// stages a list of operations, sends them to /transform for preview
// bytes, and lets the user commit via Save.
//
// Design choices worth keeping:
//
//   • Server-side pipeline: all ops (crop / rotate / flip / resize /
//     quality / upscale / filters) run in Go via github.com/disintegration/
//     imaging. The client stays thin — one fetch per preview, one per
//     save. No canvas math duplicated between Go and TS.
//
//   • Draggable crop overlay with 8 handles, implemented via native
//     pointer events over a positioned <div>. We translate between
//     display pixels (the on-screen image element) and source pixels
//     (what the server will crop) using a single ratio derived from
//     the image's naturalWidth/Height.
//
//   • Staged ops list: every slider / button mutates an in-memory
//     `ops` array. Preview is debounced; save ships the same array.
//     This keeps the undo story simple: we can pop the last op.
//
//   • Non-destructive by default: Save creates a sibling
//     "(edited).png" file. "Overwrite" is opt-in via the checkbox.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Crop,
  Download,
  FlipHorizontal,
  FlipVertical,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  RotateCcw,
  RotateCw,
  Save,
  Sparkles,
  Undo2,
  WandSparkles,
} from "lucide-react";
import { API_URL, api, getToken } from "@/lib/api";
import { useToast } from "@/components/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ApiGuideSheet } from "@/components/api-guide-trigger";
import { DocAITools } from "@/components/doc-ai-tools";

type ImageTpl = {
  id: string;
  name: string;
  mode: string;
  version: number;
  config?: { sourceMime?: string; sourceStorageKey?: string };
};

// Matches api/internal/images.Op — keep in sync. Unknown fields are
// ignored server-side so adding new ones is safe.
type Op =
  | { kind: "crop"; x: number; y: number; w: number; h: number }
  | { kind: "rotate"; preset?: "90cw" | "90ccw" | "180"; angle?: number; bgHex?: string }
  | { kind: "flip"; axis: "h" | "v" }
  | { kind: "resize"; w?: number; h?: number; scale?: number; fit?: "contain" | "stretch" }
  | { kind: "upscale"; factor: "2x" | "3x" | "4x" }
  | { kind: "filter"; name: "grayscale" | "invert" | "sepia" | "blur" | "sharpen"; sigma?: number }
  | { kind: "brightness" | "contrast" | "saturation"; amount: number };

type Rect = { x: number; y: number; w: number; h: number };

export default function ImageDesigner({
  tpl,
  previewUrl,
  fileId,
}: {
  tpl: ImageTpl;
  previewUrl: string;
  // Source file ID. When present, renders Extract text + Summarize /
  // Ask in the toolbar so the user can OCR the image directly from
  // the editor rather than bouncing back to Drive.
  fileId?: string;
}) {
  const router = useRouter();
  const toast = useToast();

  // Display / source bookkeeping. `source` is the URL the <img> tag
  // points at — initially the MinIO presigned URL, but replaced by a
  // blob: URL after a live preview so the user sees the rendered
  // result without losing their ops (ops are kept on the list so
  // Save ships them to the server).
  const [source, setSource] = useState<string>(previewUrl);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [ops, setOps] = useState<Op[]>([]);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Crop state — the rectangle drag is fully local; only when the
  // user clicks "Apply crop" does it enter the ops list. Coordinates
  // are in *display pixels* (relative to the rendered image) until
  // we apply, then converted to source pixels.
  const [cropMode, setCropMode] = useState(false);
  const [cropRect, setCropRect] = useState<Rect | null>(null);

  // Format + quality — applied only on save / preview. Defaults are
  // chosen to preserve the original: same format, 90% JPEG quality.
  const [format, setFormat] = useState<string>(
    guessFormat(tpl.config?.sourceMime),
  );
  const [quality, setQuality] = useState(90);

  // Adjustment sliders — these live as "pending" values that are
  // only pushed into the ops list on pointer-up, because dragging
  // a slider should feel smooth and we don't want to spam the
  // server. A cheap debounce would also work.
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(0);
  const [saturation, setSaturation] = useState(0);

  // "Overwrite original" defaults to false. That way the first-time
  // user clicking Save without reading any copy ends up with both a
  // pristine original and an edited copy — the safer outcome.
  const [overwrite, setOverwrite] = useState(false);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  // Cleanup blob URLs — we allocate one per preview render and leak
  // them otherwise.
  const blobUrlRef = useRef<string | null>(null);
  useEffect(() => () => {
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
  }, []);

  // ---------------------------------------------------------------
  // Pipeline assembly.
  //
  // We materialise the final ops array lazily from the staged `ops`
  // plus the three live sliders — that way dragging a slider doesn't
  // mutate history; we only commit the adjustment when the user
  // clicks "Apply adjustments" (or Save, which applies implicitly).
  // ---------------------------------------------------------------
  const stagedOps = useMemo<Op[]>(() => {
    const out: Op[] = [...ops];
    if (brightness !== 0) out.push({ kind: "brightness", amount: brightness });
    if (contrast !== 0) out.push({ kind: "contrast", amount: contrast });
    if (saturation !== 0) out.push({ kind: "saturation", amount: saturation });
    return out;
  }, [ops, brightness, contrast, saturation]);

  async function postTransform(mode: "preview" | "save") {
    const token = getToken();
    const body = {
      mode,
      format,
      quality,
      ops: stagedOps,
      replace: mode === "save" && overwrite,
    };
    const res = await fetch(
      `${API_URL}/v1/templates/${tpl.id}/images/transform`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const j = await res.json().catch(() => ({ error: { message: res.statusText } }));
      throw new Error(j?.error?.message || "transform failed");
    }
    return res;
  }

  async function runPreview() {
    if (stagedOps.length === 0) {
      // Reset to source
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      setSource(previewUrl);
      return;
    }
    setPreviewBusy(true);
    setErr(null);
    try {
      const res = await postTransform("preview");
      const blob = await res.blob();
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;
      setSource(url);
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setPreviewBusy(false);
    }
  }

  async function save() {
    setSaveBusy(true);
    setErr(null);
    try {
      const res = await postTransform("save");
      const data = await res.json();
      if (overwrite) {
        toast.show("success", `Overwrote ${tpl.name} (${formatBytes(data.bytes)})`);
        // Reset local state so the page reflects the new on-disk image.
        setOps([]);
        setBrightness(0);
        setContrast(0);
        setSaturation(0);
        setSource(data.downloadUrl || previewUrl);
      } else {
        toast.show(
          "success",
          `Saved ${data.name} (${formatBytes(data.bytes)}) — open from Drive`,
        );
        // Offer a jump to the new file
        router.refresh();
      }
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setSaveBusy(false);
    }
  }

  // ---------------------------------------------------------------
  // Op helpers — every toolbar button funnels through one of these.
  // They only mutate state; Preview / Save are explicit user gestures.
  // ---------------------------------------------------------------
  function pushOp(op: Op) {
    setOps((prev) => [...prev, op]);
  }

  function undo() {
    setOps((prev) => prev.slice(0, -1));
  }

  function resetAll() {
    setOps([]);
    setBrightness(0);
    setContrast(0);
    setSaturation(0);
    setCropRect(null);
    setCropMode(false);
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    blobUrlRef.current = null;
    setSource(previewUrl);
  }

  function applyCrop() {
    if (!cropRect || !imgRef.current || !natural) return;
    // Display pixels → source pixels. The image element is styled to
    // object-fit: contain inside the stage, so we compute the real
    // rendered box and a single scale factor.
    const rect = imgRef.current.getBoundingClientRect();
    const scale = natural.w / rect.width;
    pushOp({
      kind: "crop",
      x: Math.round(cropRect.x * scale),
      y: Math.round(cropRect.y * scale),
      w: Math.round(cropRect.w * scale),
      h: Math.round(cropRect.h * scale),
    });
    setCropRect(null);
    setCropMode(false);
  }

  function applyAdjustments() {
    const pending: Op[] = [];
    if (brightness !== 0) pending.push({ kind: "brightness", amount: brightness });
    if (contrast !== 0) pending.push({ kind: "contrast", amount: contrast });
    if (saturation !== 0) pending.push({ kind: "saturation", amount: saturation });
    if (pending.length === 0) return;
    setOps((prev) => [...prev, ...pending]);
    setBrightness(0);
    setContrast(0);
    setSaturation(0);
  }

  // Fire a preview after the user meaningfully changes the op list.
  // Debounce the slider-driven re-renders so dragging feels fluid.
  useEffect(() => {
    const id = setTimeout(() => {
      runPreview().catch(() => {});
    }, 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ops, brightness, contrast, saturation, format, quality]);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/80 px-4 md:px-6 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
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
                {natural && (
                  <span className="text-xs text-muted-foreground">
                    {natural.w}×{natural.h}
                  </span>
                )}
                {ops.length > 0 && (
                  <Badge variant="secondary" className="text-[10px]">
                    {ops.length} op{ops.length === 1 ? "" : "s"}
                  </Badge>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {/* OCR + AI for the source image. Compact mode keeps the
                editor's already-busy toolbar from wrapping. */}
            {fileId ? (
              <DocAITools fileId={fileId} fileName={tpl.name} compact />
            ) : null}
            <ApiGuideSheet templateId={tpl.id} templateName={tpl.name} />
            <Button
              variant="ghost"
              size="sm"
              onClick={undo}
              disabled={ops.length === 0}
            >
              <Undo2 className="h-4 w-4" />
              Undo
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={resetAll}
              disabled={ops.length === 0 && brightness === 0 && contrast === 0 && saturation === 0}
            >
              Reset
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={source} download={tpl.name}>
                <Download className="h-4 w-4" />
                Download
              </a>
            </Button>
            <label className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-primary"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
              />
              Overwrite
            </label>
            <Button size="sm" onClick={save} loading={saveBusy} disabled={stagedOps.length === 0}>
              <Save className="h-4 w-4" />
              Save
            </Button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Stage — the image + crop overlay. */}
        <section className="flex flex-1 items-center justify-center overflow-auto bg-muted/40 p-6">
          <div
            ref={stageRef}
            className="relative inline-block max-h-full max-w-full"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={source}
              alt={tpl.name}
              crossOrigin="anonymous"
              className={cn(
                "max-h-[80vh] max-w-full select-none rounded-md border bg-background",
                previewBusy && "opacity-80",
              )}
              onLoad={(e) => {
                const t = e.currentTarget;
                setNatural({ w: t.naturalWidth, h: t.naturalHeight });
              }}
              draggable={false}
            />
            {previewBusy && (
              <div className="absolute right-3 top-3 flex items-center gap-2 rounded-md bg-background/90 px-2 py-1 text-xs shadow">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Rendering…
              </div>
            )}
            {cropMode && imgRef.current && (
              <CropOverlay
                imgEl={imgRef.current}
                rect={cropRect}
                onChange={setCropRect}
              />
            )}
          </div>
        </section>

        {/* Right rail — op toolbox, slider grouping, save options. */}
        <aside className="w-[320px] shrink-0 overflow-y-auto border-l bg-background p-5 space-y-6">
          {err && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {err}
            </div>
          )}

          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Crop className="h-3.5 w-3.5" />
              Crop
            </h3>
            <div className="flex gap-2">
              <Button
                variant={cropMode ? "default" : "outline"}
                size="sm"
                className="flex-1"
                onClick={() => {
                  if (cropMode) {
                    applyCrop();
                  } else {
                    setCropMode(true);
                    // Default to a centered 60% rect on enter so the
                    // user sees something to grab immediately.
                    if (imgRef.current) {
                      const r = imgRef.current.getBoundingClientRect();
                      setCropRect({
                        x: r.width * 0.2,
                        y: r.height * 0.2,
                        w: r.width * 0.6,
                        h: r.height * 0.6,
                      });
                    }
                  }
                }}
              >
                {cropMode ? "Apply crop" : "Start crop"}
              </Button>
              {cropMode && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setCropMode(false);
                    setCropRect(null);
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <RotateCw className="h-3.5 w-3.5" />
              Rotate & flip
            </h3>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => pushOp({ kind: "rotate", preset: "90ccw" })}
              >
                <RotateCcw className="h-4 w-4" />
                90° CCW
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => pushOp({ kind: "rotate", preset: "90cw" })}
              >
                <RotateCw className="h-4 w-4" />
                90° CW
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => pushOp({ kind: "rotate", preset: "180" })}
              >
                180°
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => pushOp({ kind: "flip", axis: "h" })}
              >
                <FlipHorizontal className="h-4 w-4" />
                Flip H
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => pushOp({ kind: "flip", axis: "v" })}
              >
                <FlipVertical className="h-4 w-4" />
                Flip V
              </Button>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <ImagePlus className="h-3.5 w-3.5" />
              HD upscale
            </h3>
            <p className="text-[11px] text-muted-foreground">
              Lanczos resampling — sharper at 2×/4×, no extra deps.
            </p>
            <div className="grid grid-cols-3 gap-2">
              <Button variant="outline" size="sm" onClick={() => pushOp({ kind: "upscale", factor: "2x" })}>
                2×
              </Button>
              <Button variant="outline" size="sm" onClick={() => pushOp({ kind: "upscale", factor: "3x" })}>
                3×
              </Button>
              <Button variant="outline" size="sm" onClick={() => pushOp({ kind: "upscale", factor: "4x" })}>
                4×
              </Button>
            </div>
          </section>

          <ResizeBox natural={natural} onResize={(op) => pushOp(op)} />

          <section className="space-y-3">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <WandSparkles className="h-3.5 w-3.5" />
              Adjustments
            </h3>
            <SliderRow label="Brightness" value={brightness} onChange={setBrightness} />
            <SliderRow label="Contrast" value={contrast} onChange={setContrast} />
            <SliderRow label="Saturation" value={saturation} onChange={setSaturation} />
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              disabled={brightness === 0 && contrast === 0 && saturation === 0}
              onClick={applyAdjustments}
            >
              Commit adjustments
            </Button>
          </section>

          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5" />
              Filters
            </h3>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" onClick={() => pushOp({ kind: "filter", name: "grayscale" })}>
                Grayscale
              </Button>
              <Button variant="outline" size="sm" onClick={() => pushOp({ kind: "filter", name: "invert" })}>
                Invert
              </Button>
              <Button variant="outline" size="sm" onClick={() => pushOp({ kind: "filter", name: "sepia" })}>
                Sepia
              </Button>
              <Button variant="outline" size="sm" onClick={() => pushOp({ kind: "filter", name: "blur", sigma: 2 })}>
                Blur
              </Button>
              <Button variant="outline" size="sm" onClick={() => pushOp({ kind: "filter", name: "sharpen", sigma: 1 })}>
                Sharpen
              </Button>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <ImageIcon className="h-3.5 w-3.5" />
              Output format
            </h3>
            <Select value={format} onValueChange={setFormat}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="png">PNG (lossless + alpha)</SelectItem>
                <SelectItem value="jpeg">JPEG (smaller, no alpha)</SelectItem>
                <SelectItem value="gif">GIF</SelectItem>
              </SelectContent>
            </Select>
            {format === "jpeg" && (
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">
                  Quality — {quality}
                </Label>
                <input
                  type="range"
                  min={1}
                  max={100}
                  step={1}
                  value={quality}
                  onChange={(e) => setQuality(parseInt(e.target.value, 10))}
                  className="w-full accent-primary"
                />
              </div>
            )}
          </section>

          {stagedOps.length > 0 && (
            <section className="space-y-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Pipeline ({stagedOps.length})
              </h3>
              <ol className="space-y-1 text-[11px] text-muted-foreground">
                {stagedOps.map((op, i) => (
                  <li key={i} className="truncate font-mono">
                    {i + 1}. {describeOp(op)}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

// --- Sub-components ----------------------------------------------------

function SliderRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono">{value > 0 ? "+" : ""}{value}</span>
      </div>
      <input
        type="range"
        min={-100}
        max={100}
        step={1}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="w-full accent-primary"
      />
    </div>
  );
}

function ResizeBox({
  natural,
  onResize,
}: {
  natural: { w: number; h: number } | null;
  onResize: (op: Op) => void;
}) {
  const [width, setWidth] = useState<string>("");
  const [height, setHeight] = useState<string>("");
  const [lockAspect, setLockAspect] = useState(true);

  useEffect(() => {
    if (natural && width === "" && height === "") {
      setWidth(String(natural.w));
      setHeight(String(natural.h));
    }
  }, [natural, width, height]);

  function onW(v: string) {
    setWidth(v);
    if (lockAspect && natural) {
      const n = parseInt(v, 10);
      if (!isNaN(n)) setHeight(String(Math.round((n * natural.h) / natural.w)));
    }
  }
  function onH(v: string) {
    setHeight(v);
    if (lockAspect && natural) {
      const n = parseInt(v, 10);
      if (!isNaN(n)) setWidth(String(Math.round((n * natural.w) / natural.h)));
    }
  }

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Resize
      </h3>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-[11px] text-muted-foreground">Width</Label>
          <Input
            className="h-8 text-xs"
            value={width}
            onChange={(e) => onW(e.target.value)}
            type="number"
          />
        </div>
        <div>
          <Label className="text-[11px] text-muted-foreground">Height</Label>
          <Input
            className="h-8 text-xs"
            value={height}
            onChange={(e) => onH(e.target.value)}
            type="number"
          />
        </div>
      </div>
      <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
        <input
          type="checkbox"
          className="h-3 w-3 accent-primary"
          checked={lockAspect}
          onChange={(e) => setLockAspect(e.target.checked)}
        />
        Lock aspect ratio
      </label>
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => {
          const w = parseInt(width, 10);
          const h = parseInt(height, 10);
          if (!isNaN(w) && !isNaN(h)) {
            onResize({ kind: "resize", w, h, fit: lockAspect ? "contain" : "stretch" });
          }
        }}
      >
        Apply resize
      </Button>
    </section>
  );
}

// CropOverlay renders a drag-and-resize rectangle on top of the image.
// Implementation notes:
//   - Pointer events (not mouse/touch) so pens + touch "just work".
//   - Handles are 10×10 squares at the 4 corners + 4 midpoints.
//   - The body of the rect is also draggable (move).
//   - We clamp to the image's displayed bounding box so the user
//     can't drag off-screen, which would otherwise produce a
//     negative-width rect the server would bail on.
function CropOverlay({
  imgEl,
  rect,
  onChange,
}: {
  imgEl: HTMLImageElement;
  rect: Rect | null;
  onChange: (r: Rect) => void;
}) {
  const [bounds, setBounds] = useState<DOMRect | null>(null);

  useEffect(() => {
    const update = () => setBounds(imgEl.getBoundingClientRect());
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [imgEl]);

  if (!bounds || !rect) return null;

  const r = rect;

  function startDrag(e: React.PointerEvent<HTMLDivElement>, kind: string) {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = { ...r };
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const max = bounds!;
      const clampX = (x: number) => Math.min(Math.max(0, x), max.width);
      const clampY = (y: number) => Math.min(Math.max(0, y), max.height);
      let nx = orig.x;
      let ny = orig.y;
      let nw = orig.w;
      let nh = orig.h;
      switch (kind) {
        case "move":
          nx = clampX(orig.x + dx);
          ny = clampY(orig.y + dy);
          if (nx + nw > max.width) nx = max.width - nw;
          if (ny + nh > max.height) ny = max.height - nh;
          break;
        case "nw":
          nx = clampX(orig.x + dx);
          ny = clampY(orig.y + dy);
          nw = orig.w - (nx - orig.x);
          nh = orig.h - (ny - orig.y);
          break;
        case "ne":
          ny = clampY(orig.y + dy);
          nw = clampX(orig.x + orig.w + dx) - orig.x;
          nh = orig.h - (ny - orig.y);
          break;
        case "sw":
          nx = clampX(orig.x + dx);
          nw = orig.w - (nx - orig.x);
          nh = clampY(orig.y + orig.h + dy) - orig.y;
          break;
        case "se":
          nw = clampX(orig.x + orig.w + dx) - orig.x;
          nh = clampY(orig.y + orig.h + dy) - orig.y;
          break;
        case "n":
          ny = clampY(orig.y + dy);
          nh = orig.h - (ny - orig.y);
          break;
        case "s":
          nh = clampY(orig.y + orig.h + dy) - orig.y;
          break;
        case "w":
          nx = clampX(orig.x + dx);
          nw = orig.w - (nx - orig.x);
          break;
        case "e":
          nw = clampX(orig.x + orig.w + dx) - orig.x;
          break;
      }
      if (nw < 10) nw = 10;
      if (nh < 10) nh = 10;
      onChange({ x: nx, y: ny, w: nw, h: nh });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const handleStyle =
    "absolute h-2.5 w-2.5 bg-background border border-foreground/70 rounded-sm";

  return (
    <>
      {/* Dim outside — 4 rectangles around the crop to darken everything
          that isn't selected, so the user's eye goes straight to the
          crop. */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute bg-black/40" style={{ left: 0, top: 0, right: 0, height: r.y }} />
        <div className="absolute bg-black/40" style={{ left: 0, top: r.y + r.h, right: 0, bottom: 0 }} />
        <div className="absolute bg-black/40" style={{ left: 0, top: r.y, width: r.x, height: r.h }} />
        <div className="absolute bg-black/40" style={{ left: r.x + r.w, top: r.y, right: 0, height: r.h }} />
      </div>
      <div
        className="absolute border-2 border-primary bg-primary/10 cursor-move"
        style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
        onPointerDown={(e) => startDrag(e, "move")}
      >
        {/* Rule-of-thirds guide lines */}
        <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="border border-white/30" />
          ))}
        </div>
        {/* 8 resize handles */}
        {(["nw", "n", "ne", "w", "e", "sw", "s", "se"] as const).map((h) => (
          <div
            key={h}
            className={handleStyle}
            style={handlePosition(h)}
            onPointerDown={(e) => startDrag(e, h)}
          />
        ))}
      </div>
    </>
  );
}

function handlePosition(kind: string): React.CSSProperties {
  const base: Record<string, React.CSSProperties> = {
    nw: { left: -5, top: -5, cursor: "nwse-resize" },
    n: { left: "50%", top: -5, transform: "translateX(-50%)", cursor: "ns-resize" },
    ne: { right: -5, top: -5, cursor: "nesw-resize" },
    w: { left: -5, top: "50%", transform: "translateY(-50%)", cursor: "ew-resize" },
    e: { right: -5, top: "50%", transform: "translateY(-50%)", cursor: "ew-resize" },
    sw: { left: -5, bottom: -5, cursor: "nesw-resize" },
    s: { left: "50%", bottom: -5, transform: "translateX(-50%)", cursor: "ns-resize" },
    se: { right: -5, bottom: -5, cursor: "nwse-resize" },
  };
  return base[kind];
}

// --- Helpers -----------------------------------------------------------

function guessFormat(mime?: string): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpeg";
  if (m.includes("gif")) return "gif";
  return "png";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function describeOp(op: Op): string {
  switch (op.kind) {
    case "crop":
      return `crop ${op.w}×${op.h} @ (${op.x},${op.y})`;
    case "rotate":
      return op.preset ? `rotate ${op.preset}` : `rotate ${op.angle}°`;
    case "flip":
      return `flip ${op.axis}`;
    case "resize":
      return op.scale ? `resize ×${op.scale}` : `resize ${op.w}×${op.h}`;
    case "upscale":
      return `upscale ${op.factor}`;
    case "filter":
      return `filter ${op.name}`;
    case "brightness":
    case "contrast":
    case "saturation":
      return `${op.kind} ${op.amount > 0 ? "+" : ""}${op.amount}`;
  }
}
