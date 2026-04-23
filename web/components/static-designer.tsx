"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/esm/Page/AnnotationLayer.css";
import "react-pdf/dist/esm/Page/TextLayer.css";
import { api, pollJob } from "@/lib/api";
import { useToast } from "@/components/toast";
import { browserToPdf, pdfToBrowser, PageInfo } from "@/lib/pdf-coords";
import { PageLayoutDialog } from "@/components/page-layout-dialog";
import { BatchDialog } from "@/components/batch-dialog";
import type { PageLayout } from "@/lib/layout";
import { useHistory } from "@/lib/use-history";
import {
  CommandPalette,
  type Command,
} from "@/components/designer/command-palette";
import {
  ShortcutHelp,
  modSymbol,
} from "@/components/designer/shortcut-help";
import {
  AlignCenter,
  AlignHorizontalJustifyCenter,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  ChevronsDown,
  ChevronsUp,
  Copy as CopyIcon,
  Database,
  Eye,
  EyeOff,
  Files,
  Grid3x3,
  Keyboard,
  LayoutGrid,
  Lock,
  LockOpen,
  Maximize2,
  Minimize2,
  Minus,
  MoreHorizontal,
  Plus,
  Redo2,
  Settings2,
  Shapes,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  boundingBox,
  clampResize,
  computeMoveSnap,
  applyResize as geomApplyResize,
  rectIntersects,
  type GuideLine,
  type ResizeHandle,
  type WRect,
} from "@/lib/designer-geom";
import { Rulers } from "@/components/designer/rulers";
import { PageThumbnails } from "@/components/designer/page-thumbnails";
import {
  WidgetContextMenu,
  type MenuItem,
} from "@/components/designer/widget-context-menu";
import { SchemaPanel } from "@/components/designer/schema-panel";
import {
  applyTransforms,
  collectPaths,
  evalShowIf,
  keyExists,
  resolvePath,
} from "@/lib/schema-utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
  // Tier-1 additions — persisted with the widget so a lock/hide survives
  // reload. The Go renderer ignores unknown top-level fields so this is
  // safe to round-trip through the API.
  locked?: boolean;
  hidden?: boolean;
};

type Template = {
  id: string;
  name: string;
  mode: string;
  version: number;
  widgets: Widget[];
  config?: { pageLayout?: PageLayout; [key: string]: any };
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
  { type: "qr", label: "QR code", defaultW: 80, defaultH: 80 },
  { type: "barcode", label: "Barcode", defaultW: 160, defaultH: 48 },
];

// Default zoom — Cmd+0 returns to this. Range is ZOOM_MIN…ZOOM_MAX.
const SCALE = 1.5;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
// Grid step in PDF points — 6pt is a natural multi-of-12pt typography grid.
const GRID_PT = 6;
// Autosave debounce after the last edit.
const AUTOSAVE_MS = 1800;

export default function StaticDesigner({ tpl, previewUrl }: Props) {
  const toast = useToast();
  // Hydrate persisted locked/hidden flags out of `props.*` so they survive
  // reload (see save() for the mirror side of this tunneling).
  const initialWidgets: Widget[] = (tpl.widgets || []).map((w) => {
    const p = (w.props || {}) as Record<string, any>;
    const { _locked, _hidden, ...rest } = p;
    return {
      ...w,
      locked: !!_locked || !!w.locked,
      hidden: !!_hidden || !!w.hidden,
      props: rest,
    };
  });
  const history = useHistory<Widget[]>(initialWidgets);
  const widgets = history.state;
  const setWidgets = history.commit;

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [numPages, setNumPages] = useState(0);
  const [pageDims, setPageDims] = useState<Record<number, { w: number; h: number }>>({});
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [genOpen, setGenOpen] = useState(false);
  const [genJSON, setGenJSON] = useState("{}");
  const [genAsync, setGenAsync] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genProgress, setGenProgress] = useState<string | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [savingLayout, setSavingLayout] = useState(false);
  const [currentConfig, setCurrentConfig] = useState(tpl.config || {});
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [showGrid, setShowGrid] = useState(false);
  const [snapToGrid, setSnapToGrid] = useState(false);
  const [clipboard, setClipboard] = useState<Widget[]>([]);
  const [autoSave, setAutoSave] = useState(true);
  // Zoom is applied on top of SCALE — effective render scale = SCALE * zoom.
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [showRulers, setShowRulers] = useState(true);
  const [showThumbs, setShowThumbs] = useState(true);
  // Left rail controls which side panel is visible. Single-panel model
  // gives the canvas more room; clicking the active icon collapses it.
  type LeftPanel = "widgets" | "pages" | "schema" | null;
  const [activePanel, setActivePanel] = useState<LeftPanel>("widgets");
  // Live preview: when on, widgets render the resolved value from the
  // sample data instead of the dataKey name — like turning on "Preview"
  // mode in Figma.
  const [livePreview, setLivePreview] = useState(false);
  // Sample JSON used by the schema panel and live preview. Initialised
  // from the template config so users can persist it later.
  const [sampleJSON, setSampleJSON] = useState<string>(() => {
    try {
      const seed =
        (tpl.config as any)?.sampleData ??
        (tpl.widgets || []).reduce((acc: Record<string, string>, w) => {
          if (w.dataKey) acc[w.dataKey] = "";
          return acc;
        }, {});
      return JSON.stringify(seed, null, 2);
    } catch {
      return "{}";
    }
  });
  const [editSampleOpen, setEditSampleOpen] = useState(false);
  const [bulkRenameOpen, setBulkRenameOpen] = useState(false);
  const [bulkFind, setBulkFind] = useState("");
  const [bulkReplace, setBulkReplace] = useState("");
  // Which page the user is "on" — drives the thumbnail highlight and
  // keyboard-insert defaults. Updated as the canvas scrolls.
  const [currentPage, setCurrentPage] = useState(1);
  // Cursor position in PDF pts for the page under the mouse (drives the
  // pink ruler indicator).
  const [cursorPt, setCursorPt] = useState<{ page: number; x: number; y: number } | null>(
    null
  );
  // Marquee rectangle in BROWSER coords relative to the page it started on.
  const [marquee, setMarquee] = useState<{
    page: number;
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  // Smart-guide lines to draw while dragging. PDF-pt coords on a specific page.
  const [guides, setGuides] = useState<{ page: number; lines: GuideLine[] }>({
    page: 0,
    lines: [],
  });
  // Right-click menu state — positioned in viewport coords.
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    widgetId?: string;
  } | null>(null);
  // Space-to-pan support. When space is held the canvas switches to an
  // open-hand cursor and mouse-drags scroll the container.
  const [spaceHeld, setSpaceHeld] = useState(false);
  const canvasRef = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const effectiveScale = SCALE * zoom;

  // Parse sample JSON once per change. Widgets use this for live preview,
  // showIf evaluation, and unknown-key warnings.
  const sample = useMemo(() => {
    try {
      return JSON.parse(sampleJSON || "{}");
    } catch {
      return {};
    }
  }, [sampleJSON]);
  const sampleKeys = useMemo(() => collectPaths(sample), [sample]);

  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const selectedId = selectedIds[0] || null;
  const selected = widgets.find((w) => w.id === selectedId) || null;
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  async function savePageLayout(next: PageLayout) {
    setSavingLayout(true);
    try {
      const merged = { ...currentConfig, pageLayout: next };
      await api(`/v1/templates/${tpl.id}/config`, {
        method: "PUT",
        body: JSON.stringify({ config: merged }),
      });
      setCurrentConfig(merged);
      toast.show("success", "Page layout saved");
      setLayoutOpen(false);
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setSavingLayout(false);
    }
  }

  const pageInfo = useCallback(
    (page: number): PageInfo | null => {
      const d = pageDims[page];
      if (!d) return null;
      return { widthPts: d.w, heightPts: d.h, scale: effectiveScale };
    },
    [pageDims, effectiveScale]
  );

  // PALETTE DRAG → new widget --------------------------------------------
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

    const created = makeWidget(type, page, pdf.x, pdf.y, pdf.w, pdf.h, widgets.length);
    setWidgets((prev) => [...prev, created]);
    setSelectedIds([created.id]);
  }

  // Quick-insert: spawn a widget at a sensible default position on page 1.
  function insertFromPalette(type: string) {
    const spec = PALETTE.find((p) => p.type === type);
    if (!spec) return;
    const page = 1;
    const info = pageInfo(page);
    if (!info) {
      toast.show("info", "Wait for the PDF to finish loading first.");
      return;
    }
    // Drop near the top-left with a small offset per existing widget to
    // avoid stacking on the same spot.
    const count = widgets.filter((w) => w.page === page).length;
    const offset = count * 12;
    const pdf = browserToPdf(
      { x: 48 + offset, y: 48 + offset, w: spec.defaultW, h: spec.defaultH },
      info
    );
    const created = makeWidget(type, page, pdf.x, pdf.y, pdf.w, pdf.h, widgets.length);
    setWidgets((prev) => [...prev, created]);
    setSelectedIds([created.id]);
  }

  // MOVE / RESIZE ---------------------------------------------------------
  // Drag state stays in a ref so the mousemove callback can read the latest
  // snapshot without React's re-render cadence getting in the way.
  type DragState =
    | {
        kind: "move";
        page: number;
        startX: number;
        startY: number;
        // Snapshot of every moving widget's initial rect, keyed by id. We
        // snap the BBox of the group, not each widget individually.
        orig: Record<string, WRect>;
        bbox: WRect;
        others: WRect[];
      }
    | {
        kind: "resize";
        id: string;
        page: number;
        handle: ResizeHandle;
        startX: number;
        startY: number;
        orig: Widget;
      };

  const drag = useRef<DragState | null>(null);

  function beginMove(e: React.MouseEvent, w: Widget) {
    if (w.locked) return;
    e.stopPropagation();
    // If the clicked widget isn't part of selection, make it the selection.
    let ids = selectedIds;
    if (!selectedSet.has(w.id)) {
      ids = e.shiftKey ? [...selectedIds, w.id] : [w.id];
      setSelectedIds(ids);
    }
    const movers = widgets.filter((x) => ids.includes(x.id) && !x.locked);
    if (movers.length === 0) return;
    const orig: Record<string, WRect> = {};
    for (const m of movers) orig[m.id] = { x: m.x, y: m.y, w: m.w, h: m.h };
    const bbox = boundingBox(movers.map((m) => ({ x: m.x, y: m.y, w: m.w, h: m.h })))!;
    const movingIds = new Set(movers.map((m) => m.id));
    const others = widgets
      .filter((x) => x.page === w.page && !movingIds.has(x.id))
      .map((x) => ({ x: x.x, y: x.y, w: x.w, h: x.h }));
    drag.current = {
      kind: "move",
      page: w.page,
      startX: e.clientX,
      startY: e.clientY,
      orig,
      bbox,
      others,
    };
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", endDrag);
  }

  function beginResize(e: React.MouseEvent, w: Widget, handle: ResizeHandle) {
    if (w.locked) return;
    e.stopPropagation();
    setSelectedIds([w.id]);
    drag.current = {
      kind: "resize",
      id: w.id,
      page: w.page,
      handle,
      startX: e.clientX,
      startY: e.clientY,
      orig: w,
    };
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", endDrag);
  }

  const onDragMove = useCallback(
    (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const dxPts = (e.clientX - d.startX) / effectiveScale;
      // Browser Y grows DOWN; PDF Y grows UP. Invert once here so the rest
      // of the math can stay in PDF-space.
      const dyBrowser = (e.clientY - d.startY) / effectiveScale;

      if (d.kind === "move") {
        const pageD = pageDims[d.page];
        // Smart-snap the group bbox against page edges + other widgets.
        // `dyBrowser > 0` means cursor moved DOWN, so PDF y decreases by
        // that amount — hence we pass `-dyBrowser` as the Y delta.
        const snap = pageD
          ? computeMoveSnap(
              d.bbox,
              d.others,
              { w: pageD.w, h: pageD.h },
              dxPts,
              -dyBrowser
            )
          : { dx: dxPts, dy: -dyBrowser, guides: [] };
        // If user holds Shift constrain to the dominant axis.
        let finalDx = snap.dx;
        let finalDy = snap.dy;
        if (e.shiftKey) {
          if (Math.abs(dxPts) > Math.abs(dyBrowser)) finalDy = 0;
          else finalDx = 0;
        }
        // If grid-snap is on, apply it to the delta itself so the group
        // stays rigid — no individual widget drifts off alignment.
        if (snapToGrid) {
          finalDx = Math.round(finalDx / GRID_PT) * GRID_PT;
          finalDy = Math.round(finalDy / GRID_PT) * GRID_PT;
        }
        setGuides({ page: d.page, lines: snap.guides });
        setWidgets(
          (prev) =>
            prev.map((w) => {
              const o = d.orig[w.id];
              if (!o) return w;
              return { ...w, x: o.x + finalDx, y: o.y + finalDy };
            }),
          { coalesce: true }
        );
        return;
      }

      // Resize
      const resized = geomApplyResize(
        { x: d.orig.x, y: d.orig.y, w: d.orig.w, h: d.orig.h },
        d.handle,
        dxPts,
        dyBrowser
      );
      let next = clampResize(resized, d.handle, 8);
      if (snapToGrid) {
        next = {
          x: Math.round(next.x / GRID_PT) * GRID_PT,
          y: Math.round(next.y / GRID_PT) * GRID_PT,
          w: Math.round(next.w / GRID_PT) * GRID_PT,
          h: Math.round(next.h / GRID_PT) * GRID_PT,
        };
      }
      setWidgets(
        (prev) => prev.map((w) => (w.id !== d.id ? w : { ...w, ...next })),
        { coalesce: true }
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setWidgets, snapToGrid, effectiveScale, pageDims]
  );

  function endDrag() {
    drag.current = null;
    history.finalise();
    setGuides({ page: 0, lines: [] });
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", endDrag);
  }

  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", onDragMove);
      window.removeEventListener("mouseup", endDrag);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onDragMove]);

  // ZOOM / PAN / FULLSCREEN ------------------------------------------------
  function setZoomClamped(z: number) {
    setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)));
  }
  function zoomIn() {
    setZoomClamped(Math.round(zoom * 1.2 * 100) / 100);
  }
  function zoomOut() {
    setZoomClamped(Math.round((zoom / 1.2) * 100) / 100);
  }
  function zoomReset() {
    setZoom(1);
  }
  function zoomFit() {
    // Fit page 1 to the canvas width. Uses 40px of padding so rulers +
    // shadow don't get clipped.
    const page = pageDims[1];
    const host = canvasRef.current;
    if (!page || !host) return;
    const avail = host.clientWidth - 80;
    if (avail <= 0) return;
    const desired = avail / (page.w * SCALE);
    setZoomClamped(desired);
  }

  function toggleFullscreen() {
    setFullscreen((v) => !v);
  }

  // Z-ORDER --------------------------------------------------------------
  // Re-normalise zIndex after every change so the integer values stay
  // densely packed — makes "bring forward by one" predictable.
  function renumber(list: Widget[]): Widget[] {
    // Sort by current zIndex, keep stable order for ties, then re-assign.
    const sorted = [...list].sort((a, b) => a.zIndex - b.zIndex);
    const order: Record<string, number> = {};
    sorted.forEach((w, i) => {
      order[w.id] = i;
    });
    return list.map((w) => ({ ...w, zIndex: order[w.id] }));
  }

  function bringToFront() {
    if (selectedIds.length === 0) return;
    setWidgets((prev) => {
      const maxZ = Math.max(0, ...prev.map((w) => w.zIndex));
      return renumber(
        prev.map((w, i) =>
          selectedSet.has(w.id) ? { ...w, zIndex: maxZ + 1 + i } : w
        )
      );
    });
  }
  function sendToBack() {
    if (selectedIds.length === 0) return;
    setWidgets((prev) => {
      const minZ = Math.min(0, ...prev.map((w) => w.zIndex));
      return renumber(
        prev.map((w, i) =>
          selectedSet.has(w.id) ? { ...w, zIndex: minZ - (prev.length + i) } : w
        )
      );
    });
  }
  function bringForward() {
    if (selectedIds.length === 0) return;
    setWidgets((prev) =>
      renumber(
        prev.map((w) => (selectedSet.has(w.id) ? { ...w, zIndex: w.zIndex + 1.5 } : w))
      )
    );
  }
  function sendBackward() {
    if (selectedIds.length === 0) return;
    setWidgets((prev) =>
      renumber(
        prev.map((w) => (selectedSet.has(w.id) ? { ...w, zIndex: w.zIndex - 1.5 } : w))
      )
    );
  }

  // LOCK / HIDE ----------------------------------------------------------
  function toggleLock() {
    if (selectedIds.length === 0) return;
    // Use the first selected widget's state to decide the target — if any
    // is unlocked, lock them all; otherwise unlock.
    const anyUnlocked = widgets.some((w) => selectedSet.has(w.id) && !w.locked);
    setWidgets((prev) =>
      prev.map((w) => (selectedSet.has(w.id) ? { ...w, locked: anyUnlocked } : w))
    );
  }
  function toggleHide() {
    if (selectedIds.length === 0) return;
    const anyVisible = widgets.some((w) => selectedSet.has(w.id) && !w.hidden);
    setWidgets((prev) =>
      prev.map((w) => (selectedSet.has(w.id) ? { ...w, hidden: anyVisible } : w))
    );
  }

  // MARQUEE --------------------------------------------------------------
  // Begin marquee when the user mousedowns on empty space inside a page.
  // Coordinates are BROWSER-relative to the page.
  const marqueeStart = useRef<{
    page: number;
    x: number;
    y: number;
    additive: boolean;
    baseIds: string[];
  } | null>(null);

  function beginMarquee(e: React.MouseEvent, page: number) {
    if (e.button !== 0) return;
    if (spaceHeld) return; // pan mode
    const rect = pageRefs.current[page]?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    marqueeStart.current = {
      page,
      x,
      y,
      additive: e.shiftKey,
      baseIds: selectedIds,
    };
    setMarquee({ page, x, y, w: 0, h: 0 });
    window.addEventListener("mousemove", onMarqueeMove);
    window.addEventListener("mouseup", endMarquee);
  }

  function onMarqueeMove(e: MouseEvent) {
    const m = marqueeStart.current;
    if (!m) return;
    const rect = pageRefs.current[m.page]?.getBoundingClientRect();
    if (!rect) return;
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const x = Math.min(m.x, cx);
    const y = Math.min(m.y, cy);
    const w = Math.abs(cx - m.x);
    const h = Math.abs(cy - m.y);
    setMarquee({ page: m.page, x, y, w, h });

    // Convert the BROWSER marquee to a PDF-space rect for the current page,
    // then test every widget on that page for intersection.
    const info = pageInfo(m.page);
    if (!info) return;
    const pdfRect = browserToPdf({ x, y, w, h }, info);
    const hitIds: string[] = [];
    for (const wid of widgets) {
      if (wid.page !== m.page) continue;
      if (rectIntersects({ x: wid.x, y: wid.y, w: wid.w, h: wid.h }, pdfRect)) {
        hitIds.push(wid.id);
      }
    }
    const next = m.additive
      ? Array.from(new Set([...m.baseIds, ...hitIds]))
      : hitIds;
    setSelectedIds(next);
  }

  function endMarquee() {
    marqueeStart.current = null;
    setMarquee(null);
    window.removeEventListener("mousemove", onMarqueeMove);
    window.removeEventListener("mouseup", endMarquee);
  }

  // CLIPBOARD / DUPLICATE -------------------------------------------------
  function copySelection() {
    const picks = widgets.filter((w) => selectedSet.has(w.id));
    if (picks.length === 0) return;
    setClipboard(picks);
    toast.show("info", `Copied ${picks.length} widget${picks.length === 1 ? "" : "s"}`);
  }

  function paste() {
    if (clipboard.length === 0) return;
    const news: Widget[] = [];
    setWidgets((prev) => {
      const base = prev.length;
      for (let i = 0; i < clipboard.length; i++) {
        const src = clipboard[i];
        news.push({
          ...src,
          id: newId(),
          x: src.x + 10,
          y: src.y - 10,
          zIndex: base + i,
          props: { ...(src.props || {}) },
        });
      }
      return [...prev, ...news];
    });
    setSelectedIds(news.map((n) => n.id));
  }

  function duplicate() {
    const picks = widgets.filter((w) => selectedSet.has(w.id));
    if (picks.length === 0) return;
    const news: Widget[] = [];
    setWidgets((prev) => {
      const base = prev.length;
      for (let i = 0; i < picks.length; i++) {
        news.push({
          ...picks[i],
          id: newId(),
          x: picks[i].x + 10,
          y: picks[i].y - 10,
          zIndex: base + i,
          props: { ...(picks[i].props || {}) },
        });
      }
      return [...prev, ...news];
    });
    setSelectedIds(news.map((n) => n.id));
  }

  function deleteSelection() {
    if (selectedIds.length === 0) return;
    setWidgets((prev) => prev.filter((w) => !selectedSet.has(w.id)));
    setSelectedIds([]);
  }

  function selectAll() {
    setSelectedIds(widgets.map((w) => w.id));
  }

  // NUDGE ----------------------------------------------------------------
  function nudge(dx: number, dy: number) {
    if (selectedIds.length === 0) return;
    setWidgets((prev) =>
      prev.map((w) =>
        selectedSet.has(w.id) ? { ...w, x: w.x + dx, y: w.y + dy } : w
      )
    );
  }

  // ALIGN / DISTRIBUTE ---------------------------------------------------
  function alignSelection(mode: "left" | "center" | "right" | "top" | "middle" | "bottom") {
    if (selectedIds.length < 2) return;
    setWidgets((prev) => {
      const picked = prev.filter((w) => selectedSet.has(w.id));
      let target: number;
      switch (mode) {
        case "left":
          target = Math.min(...picked.map((w) => w.x));
          return prev.map((w) => (selectedSet.has(w.id) ? { ...w, x: target } : w));
        case "right":
          target = Math.max(...picked.map((w) => w.x + w.w));
          return prev.map((w) =>
            selectedSet.has(w.id) ? { ...w, x: target - w.w } : w
          );
        case "center": {
          const minX = Math.min(...picked.map((w) => w.x));
          const maxX = Math.max(...picked.map((w) => w.x + w.w));
          const c = (minX + maxX) / 2;
          return prev.map((w) =>
            selectedSet.has(w.id) ? { ...w, x: c - w.w / 2 } : w
          );
        }
        case "top":
          target = Math.max(...picked.map((w) => w.y));
          return prev.map((w) => (selectedSet.has(w.id) ? { ...w, y: target } : w));
        case "bottom":
          target = Math.min(...picked.map((w) => w.y - w.h));
          return prev.map((w) =>
            selectedSet.has(w.id) ? { ...w, y: target + w.h } : w
          );
        case "middle": {
          const top = Math.max(...picked.map((w) => w.y));
          const bot = Math.min(...picked.map((w) => w.y - w.h));
          const c = (top + bot) / 2;
          return prev.map((w) =>
            selectedSet.has(w.id) ? { ...w, y: c + w.h / 2 } : w
          );
        }
      }
    });
  }

  function distribute(axis: "h" | "v") {
    if (selectedIds.length < 3) return;
    setWidgets((prev) => {
      const picked = prev.filter((w) => selectedSet.has(w.id));
      const sorted = [...picked].sort((a, b) =>
        axis === "h" ? a.x - b.x : b.y - a.y
      );
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      if (axis === "h") {
        const span = last.x - first.x;
        const step = span / (sorted.length - 1);
        const newXs: Record<string, number> = {};
        sorted.forEach((w, i) => {
          newXs[w.id] = first.x + step * i;
        });
        return prev.map((w) => (newXs[w.id] !== undefined ? { ...w, x: newXs[w.id] } : w));
      } else {
        const span = first.y - last.y;
        const step = span / (sorted.length - 1);
        const newYs: Record<string, number> = {};
        sorted.forEach((w, i) => {
          newYs[w.id] = first.y - step * i;
        });
        return prev.map((w) => (newYs[w.id] !== undefined ? { ...w, y: newYs[w.id] } : w));
      }
    });
  }

  // SAVE / AUTOSAVE ------------------------------------------------------
  const save = useCallback(async () => {
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
        // Tunnel locked/hidden through `props` so the existing Go schema
        // (Widget.Props map[string]any) round-trips them without a
        // server-side migration. Renderer ignores them; designer reads
        // them back on reload.
        props: {
          ...(w.props || {}),
          ...(w.locked ? { _locked: true } : {}),
          ...(w.hidden ? { _hidden: true } : {}),
        },
      }));
      await api(`/v1/templates/${tpl.id}/widgets`, {
        method: "PUT",
        body: JSON.stringify({ widgets: payload }),
      });
      setLastSaved(new Date());
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setSaving(false);
    }
  }, [widgets, tpl.id, toast]);

  // Debounced autosave — fires AUTOSAVE_MS after the last mutation.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (!autoSave) return;
    const t = setTimeout(() => {
      save();
    }, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [widgets, autoSave, save]);

  // KEYBOARD -------------------------------------------------------------
  useEffect(() => {
    function inField(el: EventTarget | null) {
      const t = el as HTMLElement | null;
      if (!t) return false;
      const tag = t.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      // Palette works from anywhere.
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      // Save from anywhere.
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
        return;
      }
      // Help — don't trigger while typing.
      if (!inField(e.target) && e.key === "?") {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }
      // Zoom shortcuts (outside fields).
      if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        zoomIn();
        return;
      }
      if (mod && e.key === "-") {
        e.preventDefault();
        zoomOut();
        return;
      }
      if (mod && e.key === "0") {
        e.preventDefault();
        zoomReset();
        return;
      }
      if (inField(e.target)) return;

      // Space-to-pan — only when the canvas is focused.
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        setSpaceHeld(true);
        return;
      }
      // F = fullscreen toggle.
      if (!mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        toggleFullscreen();
        return;
      }
      // Z-order
      if (mod && e.key === "]" && e.shiftKey) {
        e.preventDefault();
        bringToFront();
        return;
      }
      if (mod && e.key === "[" && e.shiftKey) {
        e.preventDefault();
        sendToBack();
        return;
      }
      if (mod && e.key === "]") {
        e.preventDefault();
        bringForward();
        return;
      }
      if (mod && e.key === "[") {
        e.preventDefault();
        sendBackward();
        return;
      }
      // Lock / hide
      if (mod && e.key.toLowerCase() === "l") {
        e.preventDefault();
        toggleLock();
        return;
      }
      if (mod && e.key.toLowerCase() === "h" && e.shiftKey) {
        // Don't clash with browser back — require Shift for hide.
        e.preventDefault();
        toggleHide();
        return;
      }

      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        history.undo();
        return;
      }
      if ((mod && e.key.toLowerCase() === "z" && e.shiftKey) || (mod && e.key.toLowerCase() === "y")) {
        e.preventDefault();
        history.redo();
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAll();
        return;
      }
      if (mod && e.key.toLowerCase() === "c") {
        e.preventDefault();
        copySelection();
        return;
      }
      if (mod && e.key.toLowerCase() === "v") {
        e.preventDefault();
        paste();
        return;
      }
      if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicate();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedIds.length > 0) {
          e.preventDefault();
          deleteSelection();
          return;
        }
      }
      if (e.key === "Escape") {
        setSelectedIds([]);
        return;
      }
      // Arrow nudging
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        if (selectedIds.length === 0) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        if (e.key === "ArrowUp") nudge(0, step); // PDF y goes up
        else if (e.key === "ArrowDown") nudge(0, -step);
        else if (e.key === "ArrowLeft") nudge(-step, 0);
        else if (e.key === "ArrowRight") nudge(step, 0);
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") setSpaceHeld(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, widgets, history, save, clipboard, zoom]);

  // GENERATE / BATCH -----------------------------------------------------
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

  // SINGLE-WIDGET UPDATES ------------------------------------------------
  function updateSelected(patch: Partial<Widget>) {
    if (!selected) return;
    setWidgets((prev) => prev.map((w) => (w.id === selected.id ? { ...w, ...patch } : w)));
  }

  function updateSelectedProp(key: string, value: any) {
    if (!selected) return;
    updateSelected({ props: { ...selected.props, [key]: value } });
  }

  // Bind the clicked schema path to the currently-selected widget(s). If
  // more than one widget is selected, only the primary one is rebound —
  // bulk rebinding isn't the common intent.
  function bindSelectedTo(path: string) {
    if (!selected) {
      toast.show("info", "Select a widget first, then click a key to bind.");
      return;
    }
    updateSelected({ dataKey: path });
  }

  function runBulkRename() {
    const from = bulkFind.trim();
    if (!from) return;
    let count = 0;
    setWidgets((prev) =>
      prev.map((w) => {
        if (!w.dataKey) return w;
        if (w.dataKey === from || w.dataKey.startsWith(from + ".")) {
          count++;
          const suffix = w.dataKey.slice(from.length);
          return { ...w, dataKey: bulkReplace + suffix };
        }
        return w;
      })
    );
    toast.show("success", `Renamed ${count} widget${count === 1 ? "" : "s"}`);
    setBulkRenameOpen(false);
    setBulkFind("");
    setBulkReplace("");
  }

  // COMMANDS (for the palette) -------------------------------------------
  const M = modSymbol();
  const commands: Command[] = useMemo(() => {
    const insertCmds: Command[] = PALETTE.map((p) => ({
      id: "insert:" + p.type,
      label: "Insert " + p.label,
      group: "Insert widget",
      keywords: [p.type],
      run: () => insertFromPalette(p.type),
    }));
    return [
      ...insertCmds,
      { id: "edit:undo", label: "Undo", hint: `${M}Z`, group: "Edit", run: history.undo },
      { id: "edit:redo", label: "Redo", hint: `${M}⇧Z`, group: "Edit", run: history.redo },
      { id: "edit:dup", label: "Duplicate selection", hint: `${M}D`, group: "Edit", run: duplicate },
      { id: "edit:copy", label: "Copy", hint: `${M}C`, group: "Edit", run: copySelection },
      { id: "edit:paste", label: "Paste", hint: `${M}V`, group: "Edit", run: paste },
      { id: "edit:delete", label: "Delete selection", hint: "Del", group: "Edit", run: deleteSelection },
      { id: "edit:selectAll", label: "Select all", hint: `${M}A`, group: "Edit", run: selectAll },
      {
        id: "align:left",
        label: "Align left",
        group: "Align",
        keywords: ["horizontal"],
        run: () => alignSelection("left"),
      },
      { id: "align:center", label: "Align center", group: "Align", run: () => alignSelection("center") },
      { id: "align:right", label: "Align right", group: "Align", run: () => alignSelection("right") },
      { id: "align:top", label: "Align top", group: "Align", run: () => alignSelection("top") },
      { id: "align:middle", label: "Align middle", group: "Align", run: () => alignSelection("middle") },
      { id: "align:bottom", label: "Align bottom", group: "Align", run: () => alignSelection("bottom") },
      { id: "dist:h", label: "Distribute horizontally", group: "Align", run: () => distribute("h") },
      { id: "dist:v", label: "Distribute vertically", group: "Align", run: () => distribute("v") },
      { id: "arr:front", label: "Bring to front", hint: `${M}⇧]`, group: "Arrange", run: bringToFront },
      { id: "arr:back", label: "Send to back", hint: `${M}⇧[`, group: "Arrange", run: sendToBack },
      { id: "arr:fwd", label: "Bring forward", hint: `${M}]`, group: "Arrange", run: bringForward },
      { id: "arr:bwd", label: "Send backward", hint: `${M}[`, group: "Arrange", run: sendBackward },
      {
        id: "edit:lock",
        label: "Lock / unlock selection",
        hint: `${M}L`,
        group: "Edit",
        run: toggleLock,
      },
      {
        id: "edit:hide",
        label: "Hide / show selection",
        hint: `${M}⇧H`,
        group: "Edit",
        run: toggleHide,
      },
      { id: "view:zoomIn", label: "Zoom in", hint: `${M}+`, group: "View", run: zoomIn },
      { id: "view:zoomOut", label: "Zoom out", hint: `${M}-`, group: "View", run: zoomOut },
      { id: "view:zoom100", label: "Zoom 100%", hint: `${M}0`, group: "View", run: zoomReset },
      { id: "view:fit", label: "Fit to width", group: "View", run: zoomFit },
      {
        id: "view:fullscreen",
        label: fullscreen ? "Exit fullscreen" : "Enter fullscreen",
        hint: "F",
        group: "View",
        run: toggleFullscreen,
      },
      {
        id: "view:rulers",
        label: showRulers ? "Hide rulers" : "Show rulers",
        group: "View",
        run: () => setShowRulers((v) => !v),
      },
      {
        id: "view:thumbs",
        label: showThumbs ? "Hide page thumbnails" : "Show page thumbnails",
        group: "View",
        run: () => setShowThumbs((v) => !v),
      },
      {
        id: "view:grid",
        label: showGrid ? "Hide grid" : "Show grid",
        group: "View",
        run: () => setShowGrid((v) => !v),
      },
      {
        id: "view:snap",
        label: snapToGrid ? "Disable snap to grid" : "Enable snap to grid",
        group: "View",
        run: () => setSnapToGrid((v) => !v),
      },
      {
        id: "view:autosave",
        label: autoSave ? "Disable auto-save" : "Enable auto-save",
        group: "View",
        run: () => setAutoSave((v) => !v),
      },
      {
        id: "data:preview",
        label: livePreview ? "Disable live data preview" : "Enable live data preview",
        group: "Data",
        run: () => setLivePreview((v) => !v),
      },
      { id: "data:sample", label: "Edit sample JSON", group: "Data", run: () => setEditSampleOpen(true) },
      { id: "data:rename", label: "Bulk rename data key", group: "Data", run: () => setBulkRenameOpen(true) },
      { id: "file:save", label: "Save now", hint: `${M}S`, group: "File", run: save },
      { id: "file:generate", label: "Generate PDF", group: "File", run: openGenerate },
      { id: "file:batch", label: "Batch generate from CSV", group: "File", run: () => setBatchOpen(true) },
      { id: "help:shortcuts", label: "Keyboard shortcuts", hint: "?", group: "Help", run: () => setHelpOpen(true) },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    widgets,
    selectedIds,
    showGrid,
    snapToGrid,
    autoSave,
    showRulers,
    showThumbs,
    fullscreen,
    zoom,
    livePreview,
    history.undo,
    history.redo,
    save,
  ]);

  const paletteEls = useMemo(
    () =>
      PALETTE.map((p) => (
        <div
          key={p.type}
          draggable
          onDragStart={(e) => onPaletteDragStart(e, p.type)}
          onDoubleClick={() => insertFromPalette(p.type)}
          title="Drag to page, or double-click to insert"
          className="px-3 py-2 border rounded bg-white cursor-grab hover:border-blue-500 text-sm select-none"
        >
          {p.label}
        </div>
      )),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [widgets.length, pageDims]
  );

  const savedHint = saving
    ? "Saving…"
    : lastSaved
    ? `Saved ${formatRelative(lastSaved)}`
    : "Unsaved";

  return (
    <div
      ref={rootRef}
      className={
        "flex flex-col " +
        (fullscreen ? "fixed inset-0 z-50 bg-background" : "min-h-screen")
      }
    >
      <header className="bg-white border-b px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/drive" className="text-blue-600 hover:underline text-sm">← Drive</Link>
          <h1 className="font-semibold">{tpl.name}</h1>
          <span className="text-xs uppercase tracking-wide bg-gray-100 px-2 py-0.5 rounded">static</span>
          <span className="text-xs text-gray-500">v{tpl.version}</span>
          <span
            className={
              "text-xs " +
              (saving
                ? "text-amber-600"
                : lastSaved
                ? "text-emerald-600"
                : "text-gray-400")
            }
          >
            · {savedHint}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={history.undo}
            disabled={!history.canUndo}
            title={`Undo (${M}Z)`}
            className="inline-flex items-center gap-1.5 px-2 py-2 text-sm border rounded hover:bg-gray-50 disabled:opacity-40"
          >
            <Undo2 className="h-4 w-4" />
          </button>
          <button
            onClick={history.redo}
            disabled={!history.canRedo}
            title={`Redo (${M}⇧Z)`}
            className="inline-flex items-center gap-1.5 px-2 py-2 text-sm border rounded hover:bg-gray-50 disabled:opacity-40"
          >
            <Redo2 className="h-4 w-4" />
          </button>
          <button
            onClick={() => setPaletteOpen(true)}
            title={`Command palette (${M}K)`}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border rounded hover:bg-gray-50"
          >
            <LayoutGrid className="h-4 w-4" />
            Commands
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-sm border rounded hover:bg-gray-50 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            onClick={openGenerate}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Generate
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                title="More actions"
                className="inline-flex items-center gap-1 px-2 py-2 text-sm border rounded hover:bg-gray-50"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={() => setBatchOpen(true)}>
                Batch generate (CSV)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setLayoutOpen(true)}>
                <Settings2 className="h-4 w-4" /> Page layout
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href={`/templates/${tpl.id}/versions`}>
                  Version history
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/templates/${tpl.id}/playground`}>
                  Open playground
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={toggleFullscreen}>
                {fullscreen ? (
                  <>
                    <Minimize2 className="h-4 w-4" /> Exit fullscreen
                  </>
                ) : (
                  <>
                    <Maximize2 className="h-4 w-4" /> Fullscreen
                  </>
                )}
                <span className="ml-auto text-[10px] text-muted-foreground">F</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setHelpOpen(true)}>
                <Keyboard className="h-4 w-4" /> Keyboard shortcuts
                <span className="ml-auto text-[10px] text-muted-foreground">?</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Alignment toolbar — appears only when multi-select is active. */}
      {selectedIds.length >= 2 && (
        <div className="bg-muted/40 border-b px-6 py-1.5 flex flex-wrap items-center gap-1 text-xs">
          <span className="mr-2 text-muted-foreground">
            {selectedIds.length} selected
          </span>
          <AlignBtn label="Align left" onClick={() => alignSelection("left")}>
            <AlignLeft className="h-3.5 w-3.5" />
          </AlignBtn>
          <AlignBtn label="Align center" onClick={() => alignSelection("center")}>
            <AlignCenter className="h-3.5 w-3.5" />
          </AlignBtn>
          <AlignBtn label="Align right" onClick={() => alignSelection("right")}>
            <AlignRight className="h-3.5 w-3.5" />
          </AlignBtn>
          <span className="mx-1 h-4 w-px bg-border" />
          <AlignBtn label="Align top" onClick={() => alignSelection("top")}>
            <AlignVerticalJustifyCenter className="h-3.5 w-3.5 rotate-180" />
          </AlignBtn>
          <AlignBtn label="Align middle" onClick={() => alignSelection("middle")}>
            <AlignVerticalJustifyCenter className="h-3.5 w-3.5" />
          </AlignBtn>
          <AlignBtn label="Align bottom" onClick={() => alignSelection("bottom")}>
            <AlignVerticalJustifyCenter className="h-3.5 w-3.5" />
          </AlignBtn>
          <span className="mx-1 h-4 w-px bg-border" />
          <AlignBtn
            label="Distribute horizontally"
            disabled={selectedIds.length < 3}
            onClick={() => distribute("h")}
          >
            <AlignHorizontalJustifyCenter className="h-3.5 w-3.5" />
          </AlignBtn>
          <AlignBtn
            label="Distribute vertically"
            disabled={selectedIds.length < 3}
            onClick={() => distribute("v")}
          >
            <AlignHorizontalJustifyCenter className="h-3.5 w-3.5 rotate-90" />
          </AlignBtn>
          <span className="mx-1 h-4 w-px bg-border" />
          <AlignBtn label="Duplicate" onClick={duplicate}>
            <CopyIcon className="h-3.5 w-3.5" />
          </AlignBtn>
          <AlignBtn label="Delete" onClick={deleteSelection}>
            <Trash2 className="h-3.5 w-3.5" />
          </AlignBtn>
          <span className="ml-auto flex items-center gap-2 text-muted-foreground">
            <button
              onClick={() => setShowGrid((v) => !v)}
              className={"inline-flex items-center gap-1 rounded px-2 py-0.5 " + (showGrid ? "bg-primary/10 text-primary" : "hover:bg-muted")}
            >
              <Grid3x3 className="h-3.5 w-3.5" /> Grid
            </button>
            <button
              onClick={() => setSnapToGrid((v) => !v)}
              className={"rounded px-2 py-0.5 " + (snapToGrid ? "bg-primary/10 text-primary" : "hover:bg-muted")}
            >
              Snap
            </button>
          </span>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* Vertical nav rail — one click swaps the adjacent panel. Click
            the active icon again to collapse and give the canvas max room. */}
        <nav
          aria-label="Designer panels"
          className="flex w-12 shrink-0 flex-col items-center gap-1 border-r bg-muted/30 py-2"
        >
          <RailBtn
            icon={Shapes}
            label="Widgets"
            active={activePanel === "widgets"}
            onClick={() =>
              setActivePanel((p) => (p === "widgets" ? null : "widgets"))
            }
          />
          <RailBtn
            icon={Files}
            label="Pages"
            active={activePanel === "pages"}
            onClick={() =>
              setActivePanel((p) => (p === "pages" ? null : "pages"))
            }
            badge={numPages || undefined}
          />
          <RailBtn
            icon={Database}
            label="Data schema"
            active={activePanel === "schema"}
            onClick={() =>
              setActivePanel((p) => (p === "schema" ? null : "schema"))
            }
          />
          <div className="my-1 h-px w-6 bg-border" />
          <RailBtn
            icon={livePreview ? EyeOff : Eye}
            label={livePreview ? "Turn off live preview" : "Live data preview"}
            active={livePreview}
            onClick={() => setLivePreview((v) => !v)}
          />
          <RailBtn
            icon={Grid3x3}
            label={showGrid ? "Hide grid" : "Show grid"}
            active={showGrid}
            onClick={() => setShowGrid((v) => !v)}
          />
          <div className="flex-1" />
          <RailBtn
            icon={Keyboard}
            label="Keyboard shortcuts"
            onClick={() => setHelpOpen(true)}
          />
        </nav>

        {/* Single active side panel. Widgets | Pages | Data schema. */}
        {activePanel === "widgets" && (
          <aside className="w-56 shrink-0 overflow-y-auto border-r bg-gray-50 p-3">
            <div className="mb-2 text-xs uppercase tracking-wide text-gray-500">
              Widgets
            </div>
            <div className="space-y-2">{paletteEls}</div>
            <div className="pt-4 text-[10px] leading-relaxed text-gray-500">
              Drag onto page. Double-click to insert at origin.
            </div>
            <div className="mt-4 border-t pt-3 space-y-1 text-xs">
              <div className="pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                View
              </div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={snapToGrid}
                  onChange={(e) => setSnapToGrid(e.target.checked)}
                />
                Snap to grid
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={showRulers}
                  onChange={(e) => setShowRulers(e.target.checked)}
                />
                Rulers
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={autoSave}
                  onChange={(e) => setAutoSave(e.target.checked)}
                />
                Auto-save
              </label>
            </div>
          </aside>
        )}
        {activePanel === "pages" && numPages > 0 && (
          <PageThumbnails
            previewUrl={previewUrl}
            numPages={numPages}
            currentPage={currentPage}
            onJump={(p) => {
              const el = pageRefs.current[p];
              if (el && canvasRef.current) {
                el.scrollIntoView({ behavior: "smooth", block: "start" });
              }
              setCurrentPage(p);
            }}
          />
        )}
        {activePanel === "schema" && (
          <aside className="w-64 shrink-0 border-r bg-muted/20">
            <SchemaPanel
              sampleJSON={sampleJSON}
              usedKeys={widgets.map((w) => w.dataKey).filter(Boolean)}
              selectedDataKey={selected?.dataKey}
              onBind={bindSelectedTo}
              onEditSample={() => setEditSampleOpen(true)}
            />
          </aside>
        )}

        {/* Canvas */}
        <section
          ref={canvasRef}
          className={
            "flex-1 overflow-auto bg-gray-200 min-h-0 " +
            (showRulers ? "pl-10 pt-10 pr-6 pb-6 " : "p-6 ") +
            (spaceHeld ? "cursor-grab" : "")
          }
          onClick={() => {
            if (!marquee) setSelectedIds([]);
            setCtxMenu(null);
          }}
          onContextMenu={(e) => {
            // Right-click on empty canvas background → mini menu with
            // paste / select-all. Widget-level menus are handled inside
            // the widget div above.
            const tgt = e.target as HTMLElement;
            if (tgt.dataset.widgetBg === "1" || tgt.tagName === "SECTION") {
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY });
            }
          }}
        >
          <Document
            file={previewUrl}
            onLoadSuccess={({ numPages }) => setNumPages(numPages)}
            loading={<div className="text-gray-500">Loading PDF…</div>}
            error={<div className="text-red-600">Failed to load PDF</div>}
          >
            {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => {
              const pageD = pageDims[pageNum];
              const pageWpx = pageD ? pageD.w * effectiveScale : 0;
              const pageHpx = pageD ? pageD.h * effectiveScale : 0;
              const isGuidePage = guides.page === pageNum && guides.lines.length > 0;
              return (
                <div
                  key={pageNum}
                  ref={(el) => {
                    pageRefs.current[pageNum] = el;
                  }}
                  onDragOver={onPageDragOver}
                  onDrop={(e) => onPageDrop(e, pageNum)}
                  onMouseDown={(e) => {
                    // Only marquee when the mousedown lands on the page
                    // background, not on a widget or its handle.
                    if ((e.target as HTMLElement).dataset.widgetBg === "1") {
                      beginMarquee(e, pageNum);
                    }
                  }}
                  onMouseEnter={() => setCurrentPage(pageNum)}
                  onMouseMove={(e) => {
                    const rect = pageRefs.current[pageNum]?.getBoundingClientRect();
                    const info = pageInfo(pageNum);
                    if (!rect || !info) return;
                    const bx = e.clientX - rect.left;
                    const by = e.clientY - rect.top;
                    const pdf = browserToPdf({ x: bx, y: by, w: 0, h: 0 }, info);
                    setCursorPt({ page: pageNum, x: pdf.x, y: pdf.y + info.heightPts });
                  }}
                  onMouseLeave={() => setCursorPt(null)}
                  className="relative mx-auto mb-6 shadow-lg"
                  style={{ width: "fit-content" }}
                >
                  {showRulers && pageD && (
                    <Rulers
                      widthBrowser={pageWpx}
                      heightBrowser={pageHpx}
                      pageW={pageD.w}
                      pageH={pageD.h}
                      zoom={effectiveScale}
                      cursor={
                        cursorPt && cursorPt.page === pageNum
                          ? { x: cursorPt.x, y: pageD.h - cursorPt.y + pageD.h }
                          : null
                      }
                    />
                  )}
                  <Page
                    pageNumber={pageNum}
                    scale={effectiveScale}
                    renderAnnotationLayer={false}
                    renderTextLayer={false}
                    onLoadSuccess={(p) => {
                      setPageDims((prev) => ({
                        ...prev,
                        [pageNum]: { w: p.originalWidth, h: p.originalHeight },
                      }));
                    }}
                  />
                  {/* Grid overlay */}
                  {showGrid && pageD && (
                    <div
                      className="pointer-events-none absolute inset-0 opacity-30"
                      style={{
                        backgroundImage:
                          "linear-gradient(to right, rgba(59,130,246,0.35) 1px, transparent 1px)," +
                          "linear-gradient(to bottom, rgba(59,130,246,0.35) 1px, transparent 1px)",
                        backgroundSize: `${GRID_PT * effectiveScale}px ${GRID_PT * effectiveScale}px`,
                      }}
                    />
                  )}
                  {/* Smart-guide lines */}
                  {isGuidePage && pageD && (
                    <div className="pointer-events-none absolute inset-0">
                      {guides.lines.map((g, gi) =>
                        g.kind === "vertical" ? (
                          <div
                            key={"v" + gi}
                            className="absolute bg-pink-500"
                            style={{
                              left: g.x * effectiveScale,
                              top: 0,
                              width: 1,
                              height: pageHpx,
                            }}
                          />
                        ) : (
                          <div
                            key={"h" + gi}
                            className="absolute bg-pink-500"
                            style={{
                              // PDF y grows up → invert for browser.
                              top: (pageD.h - g.y) * effectiveScale,
                              left: 0,
                              height: 1,
                              width: pageWpx,
                            }}
                          />
                        )
                      )}
                    </div>
                  )}
                  {/* Marquee rectangle */}
                  {marquee && marquee.page === pageNum && (
                    <div
                      className="pointer-events-none absolute border border-primary bg-primary/10"
                      style={{
                        left: marquee.x,
                        top: marquee.y,
                        width: marquee.w,
                        height: marquee.h,
                      }}
                    />
                  )}
                  {/* Widget overlay — marker div absorbs background clicks
                      so canvas onClick doesn't misfire while marquee-ing. */}
                  <div className="absolute inset-0" data-widget-bg="1">
                    {widgets
                      .filter((w) => w.page === pageNum)
                      .sort((a, b) => a.zIndex - b.zIndex)
                      .map((w) => {
                        const info = pageInfo(pageNum);
                        if (!info) return null;
                        const b = pdfToBrowser(w, info);
                        const isSel = selectedSet.has(w.id);
                        const isPrimary = w.id === selectedId;
                        // Data-binding status: resolved sample value, missing-
                        // key warning, showIf evaluation. All cheap, called
                        // once per widget render.
                        const keyMissing =
                          !!w.dataKey && !keyExists(sampleKeys, w.dataKey);
                        const showIfExpr: string = (w.props?.showIf as string) || "";
                        const showIfResult = showIfExpr
                          ? evalShowIf(showIfExpr, sample)
                          : true;
                        const transforms: string[] = Array.isArray(w.props?.transforms)
                          ? (w.props?.transforms as string[])
                          : [];
                        const resolved = w.dataKey
                          ? resolvePath(sample, w.dataKey)
                          : undefined;
                        const displayValue =
                          resolved !== undefined
                            ? applyTransforms(resolved, transforms)
                            : "";
                        const showPreview = livePreview && !!w.dataKey && resolved !== undefined;
                        return (
                          <div
                            key={w.id}
                            onMouseDown={(e) => beginMove(e, w)}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (e.shiftKey) {
                                setSelectedIds((cur) =>
                                  cur.includes(w.id)
                                    ? cur.filter((x) => x !== w.id)
                                    : [...cur, w.id]
                                );
                              } else {
                                setSelectedIds([w.id]);
                              }
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              if (!selectedSet.has(w.id)) setSelectedIds([w.id]);
                              setCtxMenu({
                                x: e.clientX,
                                y: e.clientY,
                                widgetId: w.id,
                              });
                            }}
                            className={
                              "absolute border text-xs overflow-hidden " +
                              (w.locked ? "cursor-not-allowed " : "cursor-move ") +
                              (w.hidden || !showIfResult
                                ? "bg-muted/40 opacity-50 border-dashed "
                                : showPreview
                                ? "bg-white/90 "
                                : "bg-blue-100/40 ") +
                              (keyMissing
                                ? "border-amber-500 ring-1 ring-amber-300"
                                : isPrimary
                                ? "border-blue-600 ring-2 ring-blue-300"
                                : isSel
                                ? "border-blue-500 ring-1 ring-blue-200"
                                : "border-blue-400")
                            }
                            style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
                            title={
                              (w.locked ? "(Locked) " : "") +
                              (w.hidden ? "(Hidden) " : "") +
                              (keyMissing ? "(Key missing from sample) " : "") +
                              (!showIfResult ? "(Hidden by showIf) " : "") +
                              w.dataKey
                            }
                          >
                            <span
                              className={
                                "pointer-events-none px-1 truncate block " +
                                (showPreview
                                  ? "text-[11px] text-foreground"
                                  : "font-mono text-[10px] text-blue-900")
                              }
                            >
                              {w.locked ? "🔒 " : ""}
                              {w.hidden ? "👁 " : ""}
                              {keyMissing ? "⚠ " : ""}
                              {showPreview ? displayValue : w.dataKey}
                            </span>
                            {isPrimary && !w.locked && (
                              <>
                                {(
                                  [
                                    "nw",
                                    "n",
                                    "ne",
                                    "e",
                                    "se",
                                    "s",
                                    "sw",
                                    "w",
                                  ] as ResizeHandle[]
                                ).map((h) => (
                                  <div
                                    key={h}
                                    onMouseDown={(e) => beginResize(e, w, h)}
                                    className={
                                      "absolute bg-blue-600 border border-white " +
                                      handleCursor(h)
                                    }
                                    style={{
                                      width: 8,
                                      height: 8,
                                      ...handlePosition(h),
                                    }}
                                  />
                                ))}
                              </>
                            )}
                          </div>
                        );
                      })}
                  </div>
                </div>
              );
            })}
          </Document>
        </section>

        {/* Properties */}
        <aside className="w-80 bg-white border-l overflow-y-auto">
          <div className="p-4 border-b">
            <h2 className="font-semibold">Properties</h2>
            <p className="text-xs text-gray-500 mt-1">
              {selectedIds.length > 1
                ? `${selectedIds.length} widgets selected`
                : selected
                ? `Widget: ${selected.type}`
                : "Nothing selected"}
            </p>
          </div>
          {selected && selectedIds.length === 1 ? (
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

              {selected.type !== "checkbox" &&
                selected.type !== "qr" &&
                selected.type !== "barcode" && (
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

              {selected.type === "barcode" && (
                <Field label="Barcode kind">
                  <select
                    className="w-full border rounded px-2 py-1 text-sm"
                    value={selected.props?.barcodeKind || "code128"}
                    onChange={(e) => updateSelectedProp("barcodeKind", e.target.value)}
                  >
                    <option value="code128">Code 128</option>
                    <option value="code39">Code 39</option>
                    <option value="ean13">EAN-13</option>
                    <option value="ean8">EAN-8</option>
                  </select>
                </Field>
              )}

              {(selected.type === "qr" || selected.type === "barcode") && (
                <p className="rounded bg-muted/30 p-2 text-[10px] text-muted-foreground">
                  The <code>dataKey</code> value in the payload encodes the{" "}
                  {selected.type === "qr" ? "QR" : "barcode"} image at render time.
                </p>
              )}

              {/* ---- Data binding / transforms / validation / showIf ---- */}
              <div className="space-y-2 rounded-md border p-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Data binding
                </div>
                {selected.dataKey && !keyExists(sampleKeys, selected.dataKey) && (
                  <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700">
                    Key <code className="font-mono">{selected.dataKey}</code>{" "}
                    doesn&apos;t exist in the sample.
                  </div>
                )}
                {selected.dataKey && (
                  <div className="text-[10px] text-muted-foreground">
                    Resolved:{" "}
                    <span className="font-mono text-foreground">
                      {formatPreviewValue(
                        resolvePath(sample, selected.dataKey),
                        Array.isArray(selected.props?.transforms)
                          ? (selected.props?.transforms as string[])
                          : []
                      )}
                    </span>
                  </div>
                )}
                <Field label="Transforms (comma-separated)">
                  <input
                    className="w-full border rounded px-2 py-1 font-mono text-xs"
                    value={
                      Array.isArray(selected.props?.transforms)
                        ? (selected.props?.transforms as string[]).join(",")
                        : ""
                    }
                    onChange={(e) =>
                      updateSelectedProp(
                        "transforms",
                        e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean)
                      )
                    }
                    placeholder="uppercase, truncate:40"
                  />
                </Field>
                <details className="text-[10px] text-muted-foreground">
                  <summary className="cursor-pointer">Supported transforms</summary>
                  <ul className="mt-1 space-y-0.5 font-mono">
                    <li>uppercase / lowercase / titlecase / trim</li>
                    <li>truncate:40</li>
                    <li>number:2 — 2 decimals</li>
                    <li>currency:USD</li>
                    <li>date:yyyy-MM-dd</li>
                    <li>default:value</li>
                  </ul>
                </details>
                <Field label="Show if (e.g. status === 'paid')">
                  <input
                    className="w-full border rounded px-2 py-1 font-mono text-xs"
                    value={(selected.props?.showIf as string) || ""}
                    onChange={(e) => updateSelectedProp("showIf", e.target.value)}
                    placeholder="status === 'paid'"
                  />
                </Field>
              </div>

              <div className="space-y-2 rounded-md border p-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Validation
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={!!selected.props?.required}
                    onChange={(e) => updateSelectedProp("required", e.target.checked)}
                  />
                  Required
                </label>
                <Field label="Regex pattern">
                  <input
                    className="w-full border rounded px-2 py-1 font-mono text-xs"
                    value={(selected.props?.pattern as string) || ""}
                    onChange={(e) => updateSelectedProp("pattern", e.target.value)}
                    placeholder="^[A-Z0-9-]+$"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Min">
                    <input
                      className="w-full border rounded px-2 py-1 text-xs"
                      value={(selected.props?.min as string) ?? ""}
                      onChange={(e) => updateSelectedProp("min", e.target.value)}
                    />
                  </Field>
                  <Field label="Max">
                    <input
                      className="w-full border rounded px-2 py-1 text-xs"
                      value={(selected.props?.max as string) ?? ""}
                      onChange={(e) => updateSelectedProp("max", e.target.value)}
                    />
                  </Field>
                </div>
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  onClick={duplicate}
                  className="flex-1 text-xs px-3 py-2 border rounded hover:bg-gray-50"
                >
                  Duplicate
                </button>
                <button
                  onClick={deleteSelection}
                  className="flex-1 text-xs px-3 py-2 border border-red-300 text-red-600 rounded hover:bg-red-50"
                >
                  Delete
                </button>
              </div>
            </div>
          ) : selectedIds.length > 1 ? (
            <div className="p-4 text-xs text-gray-600 space-y-3">
              <p>
                Use the toolbar above the canvas to align or distribute the
                selected widgets. Arrow keys nudge them; Shift+Arrow moves by
                10pt.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={duplicate}
                  className="flex-1 px-3 py-2 border rounded hover:bg-gray-50"
                >
                  Duplicate ({selectedIds.length})
                </button>
                <button
                  onClick={deleteSelection}
                  className="flex-1 px-3 py-2 border border-red-300 text-red-600 rounded hover:bg-red-50"
                >
                  Delete
                </button>
              </div>
            </div>
          ) : (
            <div className="p-4 text-xs text-gray-500">
              Drag a widget from the palette onto the page, or press{" "}
              <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
                {M}K
              </kbd>{" "}
              to open commands.
            </div>
          )}
        </aside>
      </div>

      {/* Status bar */}
      <footer className="bg-white border-t px-6 py-1 flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
        <div className="flex items-center gap-4">
          <span>{widgets.length} widget{widgets.length === 1 ? "" : "s"}</span>
          <span>{selectedIds.length} selected</span>
          {selected && selectedIds.length === 1 && (
            <span>
              x {selected.x.toFixed(1)} · y {selected.y.toFixed(1)} · w{" "}
              {selected.w.toFixed(1)} · h {selected.h.toFixed(1)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden sm:inline">{savedHint}</span>
          {/* Zoom cluster lives in the status bar — canvas-local controls
              don't belong in the global header. */}
          <div className="flex items-center gap-0.5 rounded border bg-background">
            <button
              onClick={zoomOut}
              disabled={zoom <= ZOOM_MIN}
              title={`Zoom out (${M}-)`}
              className="px-1.5 py-0.5 hover:bg-muted disabled:opacity-40"
            >
              <Minus className="h-3 w-3" />
            </button>
            <button
              onClick={zoomReset}
              title={`Reset zoom (${M}0)`}
              className="min-w-[42px] px-1 py-0.5 text-[11px] tabular-nums hover:bg-muted"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              onClick={zoomIn}
              disabled={zoom >= ZOOM_MAX}
              title={`Zoom in (${M}+)`}
              className="px-1.5 py-0.5 hover:bg-muted disabled:opacity-40"
            >
              <Plus className="h-3 w-3" />
            </button>
            <button
              onClick={zoomFit}
              title="Fit to width"
              className="border-l px-1.5 py-0.5 text-[11px] hover:bg-muted"
            >
              Fit
            </button>
          </div>
        </div>
      </footer>

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
              <button
                onClick={() => !genBusy && setGenOpen(false)}
                className="text-gray-500 hover:text-gray-900"
              >
                ✕
              </button>
            </div>
            <div className="p-5 space-y-3 overflow-y-auto">
              <textarea
                className="w-full font-mono text-xs border rounded p-3 h-64"
                value={genJSON}
                onChange={(e) => setGenJSON(e.target.value)}
              />
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={genAsync}
                  onChange={(e) => setGenAsync(e.target.checked)}
                />
                Run asynchronously (via worker queue)
              </label>
              {genProgress && <div className="text-sm text-gray-600">Job: {genProgress}</div>}
            </div>
            <div className="px-5 py-3 border-t flex items-center justify-end gap-2">
              <button
                onClick={() => setGenOpen(false)}
                disabled={genBusy}
                className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50"
              >
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

      <PageLayoutDialog
        open={layoutOpen}
        onOpenChange={setLayoutOpen}
        value={currentConfig?.pageLayout}
        onSave={savePageLayout}
        supportsHeaderFooter={false}
        busy={savingLayout}
      />

      <BatchDialog open={batchOpen} onOpenChange={setBatchOpen} templateId={tpl.id} />

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
      <ShortcutHelp
        open={helpOpen}
        onOpenChange={setHelpOpen}
        shortcuts={[
          { keys: `${M}K`, label: "Open command palette", group: "General" },
          { keys: `${M}S`, label: "Save now", group: "General" },
          { keys: "F", label: "Toggle fullscreen", group: "General" },
          { keys: "?", label: "Show this help", group: "General" },
          { keys: `${M}+ / ${M}- / ${M}0`, label: "Zoom in / out / reset", group: "View" },
          { keys: "Space + drag", label: "Pan canvas", group: "View" },
          { keys: `${M}Z / ${M}⇧Z`, label: "Undo / redo", group: "Edit" },
          { keys: `${M}C / ${M}V`, label: "Copy / paste", group: "Edit" },
          { keys: `${M}D`, label: "Duplicate selection", group: "Edit" },
          { keys: `${M}A`, label: "Select all", group: "Edit" },
          { keys: "Del / ⌫", label: "Delete selection", group: "Edit" },
          { keys: "Esc", label: "Clear selection", group: "Edit" },
          { keys: `${M}L`, label: "Lock / unlock selection", group: "Edit" },
          { keys: `${M}⇧H`, label: "Hide / show selection", group: "Edit" },
          { keys: "Shift + Click", label: "Add to selection", group: "Select" },
          { keys: "Drag in empty space", label: "Marquee select", group: "Select" },
          { keys: "Arrow", label: "Nudge 1pt", group: "Move" },
          { keys: "Shift + Arrow", label: "Nudge 10pt", group: "Move" },
          { keys: "Shift + Drag", label: "Constrain to axis", group: "Move" },
          { keys: `${M}]`, label: "Bring forward", group: "Arrange" },
          { keys: `${M}[`, label: "Send backward", group: "Arrange" },
          { keys: `${M}⇧]`, label: "Bring to front", group: "Arrange" },
          { keys: `${M}⇧[`, label: "Send to back", group: "Arrange" },
        ]}
      />

      {/* Edit sample JSON */}
      <Dialog open={editSampleOpen} onOpenChange={setEditSampleOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Sample data</DialogTitle>
            <DialogDescription>
              Used by the schema panel and live preview. Keys shown here are
              the shape your Generate call should send.
            </DialogDescription>
          </DialogHeader>
          <textarea
            className="min-h-[240px] w-full rounded-md border bg-background p-3 font-mono text-xs"
            value={sampleJSON}
            onChange={(e) => setSampleJSON(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditSampleOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk rename data key */}
      <Dialog open={bulkRenameOpen} onOpenChange={setBulkRenameOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Bulk rename data key</DialogTitle>
            <DialogDescription>
              Replaces an exact match or a prefix across every widget.
              Example: renaming <code className="font-mono">user</code> to{" "}
              <code className="font-mono">customer</code> also rewrites{" "}
              <code className="font-mono">user.name</code> →{" "}
              <code className="font-mono">customer.name</code>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Find</Label>
              <Input
                value={bulkFind}
                onChange={(e) => setBulkFind(e.target.value)}
                placeholder="old.key"
                className="font-mono"
              />
            </div>
            <div>
              <Label>Replace with</Label>
              <Input
                value={bulkReplace}
                onChange={(e) => setBulkReplace(e.target.value)}
                placeholder="new.key"
                className="font-mono"
              />
            </div>
            <div className="text-[11px] text-muted-foreground">
              {bulkFind
                ? `${widgets.filter((w) => w.dataKey === bulkFind || w.dataKey.startsWith(bulkFind + ".")).length} match(es)`
                : ""}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkRenameOpen(false)}>
              Cancel
            </Button>
            <Button onClick={runBulkRename} disabled={!bulkFind.trim()}>
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {ctxMenu && (
        <WidgetContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={buildContextMenuItems({
            M,
            selectedCount: selectedIds.length,
            selectedLocked: widgets.some(
              (w) => selectedSet.has(w.id) && w.locked
            ),
            selectedHidden: widgets.some(
              (w) => selectedSet.has(w.id) && w.hidden
            ),
            duplicate,
            copySelection,
            paste,
            deleteSelection,
            toggleLock,
            toggleHide,
            bringForward,
            sendBackward,
            bringToFront,
            sendToBack,
            align: alignSelection,
          })}
        />
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

function RailBtn({
  icon: Icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={
        "relative grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition-colors " +
        (active
          ? "bg-primary/10 text-primary"
          : "hover:bg-muted hover:text-foreground")
      }
    >
      <Icon className="h-4 w-4" />
      {badge !== undefined && badge > 0 && (
        <span className="absolute -right-0.5 -top-0.5 grid h-3.5 min-w-[14px] place-items-center rounded-full bg-primary px-1 text-[9px] font-medium text-primary-foreground">
          {badge}
        </span>
      )}
    </button>
  );
}

function AlignBtn({
  children,
  label,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-muted disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function defaultProps(type: string): Record<string, any> {
  switch (type) {
    case "checkbox":
      return { color: "#111827" };
    case "multiline":
      return { fontSize: 11, fontFamily: "Helvetica", color: "#111827", align: "L" };
    case "qr":
      return {};
    case "barcode":
      return { barcodeKind: "code128" };
    default:
      return { fontSize: 12, fontFamily: "Helvetica", color: "#111827", align: "L" };
  }
}

function makeWidget(
  type: string,
  page: number,
  x: number,
  y: number,
  w: number,
  h: number,
  zIndex: number
): Widget {
  return {
    id: newId(),
    type,
    page,
    x,
    y,
    w,
    h,
    dataKey: `field_${zIndex + 1}`,
    zIndex,
    props: defaultProps(type),
  };
}

function newId() {
  return `w_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;
}

function maybeSnap(v: number, on: boolean) {
  return on ? Math.round(v / GRID_PT) * GRID_PT : v;
}

// Position a resize handle relative to its widget's inner box. Widgets
// are positioned with top:left in browser-space, so "n" is at the top
// center regardless of the PDF y-flip.
function handlePosition(h: ResizeHandle): React.CSSProperties {
  const center = { left: "50%", top: "50%" } as React.CSSProperties;
  const transform = "translate(-50%, -50%)";
  switch (h) {
    case "nw":
      return { left: 0, top: 0, transform: "translate(-50%, -50%)" };
    case "n":
      return { ...center, top: 0, transform };
    case "ne":
      return { right: 0, top: 0, transform: "translate(50%, -50%)" };
    case "e":
      return { ...center, left: "auto", right: 0, transform };
    case "se":
      return { right: 0, bottom: 0, transform: "translate(50%, 50%)" };
    case "s":
      return { ...center, top: "auto", bottom: 0, transform };
    case "sw":
      return { left: 0, bottom: 0, transform: "translate(-50%, 50%)" };
    case "w":
      return { ...center, left: 0, right: "auto", transform };
  }
}

function handleCursor(h: ResizeHandle): string {
  switch (h) {
    case "n":
    case "s":
      return "cursor-ns-resize";
    case "e":
    case "w":
      return "cursor-ew-resize";
    case "ne":
    case "sw":
      return "cursor-nesw-resize";
    case "nw":
    case "se":
      return "cursor-nwse-resize";
  }
}

function buildContextMenuItems(p: {
  M: string;
  selectedCount: number;
  selectedLocked: boolean;
  selectedHidden: boolean;
  duplicate: () => void;
  copySelection: () => void;
  paste: () => void;
  deleteSelection: () => void;
  toggleLock: () => void;
  toggleHide: () => void;
  bringForward: () => void;
  sendBackward: () => void;
  bringToFront: () => void;
  sendToBack: () => void;
  align: (mode: "left" | "center" | "right" | "top" | "middle" | "bottom") => void;
}): MenuItem[] {
  const { M, selectedCount } = p;
  const multi = selectedCount >= 2;
  return [
    { kind: "item", label: "Duplicate", hint: `${M}D`, run: p.duplicate },
    { kind: "item", label: "Copy", hint: `${M}C`, run: p.copySelection },
    { kind: "item", label: "Paste", hint: `${M}V`, run: p.paste },
    { kind: "separator" },
    {
      kind: "item",
      label: p.selectedLocked ? "Unlock" : "Lock",
      hint: `${M}L`,
      run: p.toggleLock,
    },
    {
      kind: "item",
      label: p.selectedHidden ? "Show" : "Hide",
      hint: `${M}⇧H`,
      run: p.toggleHide,
    },
    { kind: "separator" },
    { kind: "item", label: "Bring forward", hint: `${M}]`, run: p.bringForward },
    { kind: "item", label: "Send backward", hint: `${M}[`, run: p.sendBackward },
    { kind: "item", label: "Bring to front", hint: `${M}⇧]`, run: p.bringToFront },
    { kind: "item", label: "Send to back", hint: `${M}⇧[`, run: p.sendToBack },
    { kind: "separator" },
    {
      kind: "item",
      label: "Align left",
      disabled: !multi,
      run: () => p.align("left"),
    },
    {
      kind: "item",
      label: "Align center",
      disabled: !multi,
      run: () => p.align("center"),
    },
    {
      kind: "item",
      label: "Align right",
      disabled: !multi,
      run: () => p.align("right"),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Delete",
      hint: "Del",
      danger: true,
      run: p.deleteSelection,
    },
  ];
}

function formatPreviewValue(v: any, transforms: string[]): string {
  if (v === undefined) return "—";
  const out = applyTransforms(v, transforms);
  return out.length > 32 ? out.slice(0, 32) + "…" : out;
}

function formatRelative(d: Date): string {
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 2) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return d.toLocaleTimeString();
}
