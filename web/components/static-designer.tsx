"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/esm/Page/AnnotationLayer.css";
import "react-pdf/dist/esm/Page/TextLayer.css";
import { api } from "@/lib/api";
import { runGenerate } from "@/lib/generate";
import { GeneratedPreviewDialog } from "@/components/generated-preview-dialog";
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
  Bold,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Clipboard,
  Code2,
  Download,
  FileJson,
  Group,
  PackageOpen,
  Layers,
  ShieldCheck,
  Copy as CopyIcon,
  Database,
  Eye,
  EyeOff,
  Files,
  Grid3x3,
  Hash,
  Italic,
  Keyboard,
  LayoutGrid,
  Lock,
  LockOpen,
  Maximize2,
  MessageSquare,
  Sparkles,
  Minimize2,
  Minus,
  MoreHorizontal,
  Plus,
  Redo2,
  Settings2,
  Shapes,
  Trash2,
  Underline,
  Undo2,
  Upload,
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
import { LayersPanel, type LayerWidget } from "@/components/designer/layers-panel";
import { GroupsPanel, type GroupWidget } from "@/components/designer/groups-panel";
import { AcroFormPanel } from "@/components/designer/acroform-panel";
import { TabOrderPanel, type TabWidget } from "@/components/designer/tab-order-panel";
import { isAcroFieldType } from "@/lib/acroform-types";
import {
  ValidationPanel,
  runValidation,
  type ValidWidget,
} from "@/components/designer/validation-panel";
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
import { InlineRenameTitle } from "@/components/designer/inline-rename-title";
import { ApiGuideSheet } from "@/components/api-guide-trigger";
import { CollabDrawer } from "@/components/collab-drawer";
import {
  AIDetectFieldsModal,
  type DetectedProposal,
} from "@/components/ai-detect-fields-modal";
import { DocAITools } from "@/components/doc-ai-tools";
import { Label } from "@/components/ui/label";
import { TYPOGRAPHY_PRESETS, FONT_FAMILIES } from "@/lib/font-presets";
import { TransformEditor } from "@/components/acroform/transform-editor";
import { ValidationRulesEditor } from "@/components/acroform/validation-rules-editor";
import { ConditionalEditor } from "@/components/acroform/conditional-editor";
import type {
  AcroFormField as AcroFormFieldFull,
  ValidationRule,
} from "@/components/acroform/types";
import type { Transform } from "@/lib/acroform-transforms";
import {
  copyToClipboard,
  downloadFullExport,
  downloadJSON,
  downloadSkeleton,
  downloadTypeScript,
  pickAndParseFullImport,
  toTypeScript,
} from "@/lib/schema-export";

// Self-hosted PDF.js worker — see components/acroform/pdf-preview.tsx for
// the full rationale. tl;dr: avoids a CSP carve-out for unpkg and
// removes a runtime dependency on a third-party CDN.
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf-worker/pdf.worker.min.js";

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
  // When set, this widget is a synthetic representation of an existing
  // AcroForm /FT field on the underlying PDF. Such widgets are NEVER
  // persisted to /v1/templates/:id/widgets — on save() they're split
  // out and written back to /v1/templates/:id/config under .mappings,
  // preserving the existing acroform API contract. Their geometry is
  // pinned to the PDF's /Annots rect (locked: true) so the user can
  // edit binding/transform/validation but not move the box.
  acroFieldName?: string;
  // Original PDF /FT type — "Tx" / "Btn" / "Ch" / "Sig". Used by the
  // properties panel to render the appropriate metadata badge.
  acroFieldType?: string;
};

// Minimal AcroForm field shape — duplicated from
// components/acroform/types.ts to keep this file self-contained
// (StaticDesigner is now the only designer for both modes; the old
// acroform-designer is unreachable from the router).
type AcroFormField = {
  name: string;
  type: string;
  page: number;
  rect?: { x: number; y: number; w: number; h: number };
  options?: string[];
  required?: boolean;
  multiline?: boolean;
  readOnly?: boolean;
  tooltip?: string;
  maxLen?: number;
};
type AcroMapping = {
  dataKey: string;
  default?: string;
  required?: boolean;
  transform?: any;
  section?: string;
  flatten?: boolean;
  validation?: any;
  fillWhen?: string;
};

type Template = {
  id: string;
  name: string;
  mode: string;
  version: number;
  widgets: Widget[];
  config?: {
    pageLayout?: PageLayout;
    mappings?: Record<string, AcroMapping>;
    [key: string]: any;
  };
  // Present only for mode="acroform" templates — the /FT fields the
  // server extracted from the PDF at upload. Absent for static-mode.
  fields?: AcroFormField[];
};

type Props = {
  tpl: Template;
  previewUrl: string;
  // View-only viewers from resource_shares (role=viewer) reach this page
  // too — they should see the design but not be able to persist changes.
  // When set, Save is disabled and autosave is short-circuited so we don't
  // hammer the server with 403s from local edits. Local state still
  // accepts changes (so users can poke around) — nothing persists.
  readOnly?: boolean;
  // Source file ID. Threaded through from the page wrapper so the
  // header can offer Extract text + Summarize / Ask against the
  // underlying PDF/asset — same affordance Drive shows on preview.
  // Optional because some legacy entry points (test fixtures) may
  // mount the designer without a backing file row.
  fileId?: string;
};

const PALETTE: { type: Widget["type"]; label: string; defaultW: number; defaultH: number; group?: string }[] = [
  { type: "text", label: "Text", defaultW: 160, defaultH: 18, group: "Text" },
  { type: "multiline", label: "Multiline", defaultW: 200, defaultH: 60, group: "Text" },
  // Char-grid widget for forms that print one box per character (PAN,
  // CKYC, account number blocks, date DD/MM/YYYY cells). Renderer
  // distributes the value across `cells` equal-width columns. Default
  // 10 cells fits PAN; tweak via the Properties panel.
  { type: "comb", label: "Char grid", defaultW: 200, defaultH: 18, group: "Text" },
  { type: "date", label: "Date", defaultW: 110, defaultH: 18, group: "Text" },
  { type: "number", label: "Number", defaultW: 90, defaultH: 18, group: "Text" },
  { type: "currency", label: "Currency", defaultW: 120, defaultH: 18, group: "Text" },
  { type: "checkbox", label: "Checkbox", defaultW: 16, defaultH: 16, group: "Form" },
  { type: "radio", label: "Radio button", defaultW: 14, defaultH: 14, group: "Form" },
  { type: "dropdown", label: "Dropdown", defaultW: 140, defaultH: 18, group: "Form" },
  { type: "signature-field", label: "Sig. field", defaultW: 200, defaultH: 50, group: "Form" },
  { type: "button", label: "Button", defaultW: 100, defaultH: 22, group: "Form" },
  { type: "qr", label: "QR code", defaultW: 80, defaultH: 80, group: "Media" },
  { type: "barcode", label: "Barcode", defaultW: 160, defaultH: 48, group: "Media" },
  { type: "image", label: "Image", defaultW: 160, defaultH: 100, group: "Media" },
  { type: "signature", label: "Signature", defaultW: 180, defaultH: 60, group: "Media" },
  { type: "rectangle", label: "Rectangle", defaultW: 160, defaultH: 60, group: "Shape" },
  { type: "line", label: "Divider", defaultW: 200, defaultH: 1, group: "Shape" },
  { type: "pageNumber", label: "Page number", defaultW: 80, defaultH: 16, group: "Auto" },
  { type: "watermark", label: "Watermark", defaultW: 360, defaultH: 60, group: "Auto" },
  { type: "repeat", label: "Repeat list", defaultW: 260, defaultH: 120, group: "Data" },
];

// Default zoom — Cmd+0 returns to this. Range is ZOOM_MIN…ZOOM_MAX.
const SCALE = 1.5;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
// Grid step in PDF points — 6pt is a natural multi-of-12pt typography grid.
const GRID_PT = 6;
// Autosave debounce after the last edit.
const AUTOSAVE_MS = 1800;

export default function StaticDesigner({
  tpl,
  previewUrl,
  readOnly = false,
  fileId,
}: Props) {
  const toast = useToast();
  // Hydrate persisted locked/hidden flags out of `props.*` so they survive
  // reload (see save() for the mirror side of this tunneling).
  const userWidgets: Widget[] = (tpl.widgets || []).map((w) => {
    const p = (w.props || {}) as Record<string, any>;
    const { _locked, _hidden, ...rest } = p;
    return {
      ...w,
      locked: !!_locked || !!w.locked,
      hidden: !!_hidden || !!w.hidden,
      props: rest,
    };
  });
  // Synthesize one acro-bound widget per existing /FT field on the
  // PDF. They're locked (geometry comes from the PDF's /Annots rect
  // and can't drift), bound to their data key via the existing
  // mappings config, and round-trip back to /config.mappings on save —
  // never to /widgets. Putting them at zIndex 0 keeps them under any
  // user-added overlays so a stamped logo or page number can sit on
  // top without obscuring the field rectangle.
  const acroBoundWidgets: Widget[] = (tpl.fields || [])
    .filter((f) => !!f.rect)
    .map((f) => {
      const m = tpl.config?.mappings?.[f.name] || { dataKey: f.name };
      return {
        id: `acro:${f.name}`,
        type: "acroform",
        page: f.page,
        x: f.rect!.x,
        y: f.rect!.y,
        w: f.rect!.w,
        h: f.rect!.h,
        dataKey: m.dataKey || f.name,
        zIndex: 0,
        props: {
          // Tunnel the rich mapping fields through props so the
          // existing widget-properties panel can edit them with no
          // schema changes. Save splits them back out to mappings.
          _acroMapping: m,
          _acroFieldType: f.type,
          _acroOptions: f.options,
          _acroMaxLen: f.maxLen,
          _acroTooltip: f.tooltip,
          _acroReadOnly: !!f.readOnly,
          _acroMultiline: !!f.multiline,
        },
        locked: true,
        acroFieldName: f.name,
        acroFieldType: f.type,
      };
    });
  const initialWidgets: Widget[] = [...acroBoundWidgets, ...userWidgets];
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
  // Per-render output options (mirror lib/generate.ts GenerateOptions).
  // saveToDrive defaults to FALSE so an ad-hoc test render doesn't pollute
  // the file list — authors opt in explicitly when they want to keep the
  // PDF. Filename / folder live alongside it because they only matter
  // when persistence is on.
  const [genSaveToDrive, setGenSaveToDrive] = useState(false);
  const [genOutputName, setGenOutputName] = useState("");
  const [genOutputPath, setGenOutputPath] = useState("");
  const [genFlatten, setGenFlatten] = useState(false);
  // Security inputs. Empty passwords = no encryption for this render
  // (we don't send the security block at all when both are blank, so the
  // template's policy still applies). When either is set we send the
  // full block — the server treats provided-with-empty-passwords as
  // "render unprotected even if the template would have encrypted".
  const [genUserPwd, setGenUserPwd] = useState("");
  const [genOwnerPwd, setGenOwnerPwd] = useState("");
  const [genEncryption, setGenEncryption] = useState<"AES-256" | "AES-128">(
    "AES-256"
  );
  const [genPermAll, setGenPermAll] = useState(true);
  const [genPermPrint, setGenPermPrint] = useState(true);
  const [genPermCopy, setGenPermCopy] = useState(false);
  const [genPermModify, setGenPermModify] = useState(false);
  const [genPermAnnotate, setGenPermAnnotate] = useState(false);
  // Collapse the security block by default — most renders don't need it,
  // and the dialog stays scannable.
  const [genSecurityOpen, setGenSecurityOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [savingLayout, setSavingLayout] = useState(false);
  const [currentConfig, setCurrentConfig] = useState(tpl.config || {});
  // Local name overlay for inline rename; parent prop is authoritative at
  // mount, header updates optimistically from server-confirmed rename.
  const [tplName, setTplName] = useState<string>(tpl.name);
  // Post-generate preview dialog state. Replaces the old
  // `window.open(downloadUrl)` auto-download.
  const [genResult, setGenResult] = useState<{
    downloadUrl: string;
    outputFileId?: string;
    fileName: string;
  } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [showGrid, setShowGrid] = useState(false);
  const [snapToGrid, setSnapToGrid] = useState(false);
  const [clipboard, setClipboard] = useState<Widget[]>([]);
  // Default off: auto-save can mask intent (an in-progress widget drag
  // gets versioned the moment the debounce timer fires). Authors opt in
  // via the View menu / palette ("Enable auto-save") when they want the
  // convenience.
  const [autoSave, setAutoSave] = useState(false);
  // Zoom is applied on top of SCALE — effective render scale = SCALE * zoom.
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  // Collaboration drawer — Comments, Reviews (request/decide), Share /
  // external review-links, and live presence. Mirrors the wiring in
  // markdown-designer.tsx and html-designer.tsx so the PDF designer gets
  // the same "Request review" entry point. The drawer is purely a
  // dialog; no canvas state depends on it.
  const [collabOpen, setCollabOpen] = useState(false);
  // AI auto-detect-fields modal. Opens via toolbar button or command
  // palette; never opens on its own. Hits POST /ai/detect-fields,
  // surfaces proposals, merges accepted ones into widgets state.
  const [aiDetectOpen, setAiDetectOpen] = useState(false);
  const [showRulers, setShowRulers] = useState(true);
  const [showThumbs, setShowThumbs] = useState(true);
  // Page rendering mode. "continuous" stacks every page top-to-bottom (the
  // long-standing default — best for scrolling through a multi-page PDF
  // like a normal document). "paginated" renders one page at a time with
  // prev/next controls — useful for reviewing form fills or comparing
  // widget placement against a single page without other pages drifting
  // through the viewport. The active page in paginated mode is the same
  // `currentPage` that drives the thumbnail highlight, so jumping from
  // the Pages panel "just works" in either mode.
  const [viewMode, setViewMode] = useState<"continuous" | "paginated">(
    "continuous"
  );
  // Left rail controls which side panel is visible. Single-panel model
  // gives the canvas more room; clicking the active icon collapses it.
  // The Schema / Layers / Tab-order panels were three separate rail
  // buttons originally — same widget list, three lenses on it. Merged
  // into a single "fields" panel with an internal tabbed sub-nav so the
  // rail stays scannable and authors can flip between lenses without
  // losing scroll position. The active sub-tab is its own piece of state
  // (`fieldsTab`) so it survives panel toggles.
  type LeftPanel = "widgets" | "pages" | "fields" | "groups" | "inspect" | null;
  const [activePanel, setActivePanel] = useState<LeftPanel>("widgets");
  type FieldsTab = "schema" | "layers" | "taborder";
  const [fieldsTab, setFieldsTab] = useState<FieldsTab>("schema");
  // Live preview: when on, widgets render the resolved value from the
  // sample data instead of the dataKey name — like turning on "Preview"
  // mode in Figma.
  const [livePreview, setLivePreview] = useState(false);
  // Cell-pitch sampling mode for char-grid (comb) widgets. When set, an
  // overlay over each page captures the next two clicks: first click
  // anchors the widget's left edge to the left side of the first
  // printed cell; second click anchors the widget's right edge to the
  // right side of the last printed cell. Pitch is then derived as
  // (x2 - x1) / cells. Single-shot — auto-exits after the second click
  // or on Esc. The widgetId targets a specific widget so the rest of
  // the canvas keeps working normally.
  const [sampleMode, setSampleMode] = useState<{
    widgetId: string;
    firstPdf: { page: number; x: number } | null;
  } | null>(null);
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
  const [copiedSchema, setCopiedSchema] = useState(false);
  const [bulkRenameOpen, setBulkRenameOpen] = useState(false);
  const [bulkFind, setBulkFind] = useState("");
  const [bulkReplace, setBulkReplace] = useState("");
  // Which page the user is "on" — drives the thumbnail highlight and
  // keyboard-insert defaults. Updated as the canvas scrolls.
  const [currentPage, setCurrentPage] = useState(1);
  // Clamp currentPage when the doc shrinks (e.g. PDF re-rendered with
  // fewer pages after a layout change). Without this, paginated mode
  // could end up rendering nothing because the page-filter never matches.
  useEffect(() => {
    if (numPages > 0 && currentPage > numPages) setCurrentPage(numPages);
    if (numPages > 0 && currentPage < 1) setCurrentPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numPages]);
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

  // Validation issues — recomputed whenever widgets or page dims change.
  const validationIssues = useMemo(
    () => runValidation(widgets as ValidWidget[], pageDims, sampleKeys),
    [widgets, pageDims, sampleKeys]
  );
  const issueCount = useMemo(
    () => validationIssues.filter((i) => i.severity !== "info").length,
    [validationIssues]
  );

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

  // Merge AI-detected proposals into the widgets list. Coordinates
  // come back from the server already in PDF user-space (origin
  // bottom-left), so no translation is needed — they slot straight
  // into the same coordinate convention the rest of the canvas uses.
  // Each proposal becomes a fresh widget with a new id; we push them
  // at the end of the z-stack so they sit above existing decoration
  // and the user can immediately click-to-select to fine-tune.
  function applyDetectedProposals(proposals: DetectedProposal[]) {
    if (!proposals.length) return;
    const startZ = widgets.length;
    const created: Widget[] = proposals.map((p, i) => ({
      id: newId(),
      type: p.type,
      page: p.page || 1,
      x: p.x,
      y: p.y,
      w: p.w,
      h: p.h,
      dataKey: p.dataKey || `field_${startZ + i + 1}`,
      zIndex: startZ + i,
      props: { ...defaultProps(p.type), ...(p.props || {}) },
    }));
    setWidgets((prev) => [...prev, ...created]);
    setSelectedIds(created.map((w) => w.id));
    toast.show(
      "success",
      `Added ${created.length} field${created.length === 1 ? "" : "s"} from auto-detect`,
    );
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
      }
    | {
        // Per-cell boundary drag inside a comb widget. Drags the
        // boundary between cellIndex and cellIndex+1 — pulls width
        // from one neighbour into the other so total widget.W stays
        // constant. Lazy-initialises cellWidths from the current pitch
        // if the widget is still in equal-pitch mode.
        kind: "combCell";
        id: string;
        cellIndex: number;
        startX: number;
        origWidths: number[];
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

  // Per-cell boundary drag for the comb widget. We snapshot the current
  // cell-width array (lazy-deriving it from pitch the first time) so the
  // mousemove can compute deltas off a stable origin instead of chasing
  // a moving target through React state.
  function beginCombCellResize(
    e: React.MouseEvent,
    w: Widget,
    cellIndex: number
  ) {
    if (w.locked) return;
    e.stopPropagation();
    setSelectedIds([w.id]);
    const cells = Math.max(1, Math.round(Number(w.props?.cells ?? 10)));
    const existing = w.props?.cellWidths;
    let origWidths: number[];
    if (Array.isArray(existing) && existing.length === cells) {
      origWidths = existing.map((n: unknown) => Number(n) || 0);
    } else {
      const pitch = Number(w.props?.cellWidth) || w.w / cells;
      origWidths = Array.from({ length: cells }, () => pitch);
    }
    drag.current = {
      kind: "combCell",
      id: w.id,
      cellIndex,
      startX: e.clientX,
      origWidths,
    };
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", endDrag);
  }

  const onDragMove = useCallback(
    (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const dxPts = (e.clientX - d.startX) / effectiveScale;

      if (d.kind === "combCell") {
        // Steal width from the right neighbour and give it to the left
        // (or vice-versa). Total widget.w stays constant — only the
        // distribution shifts. Clamp so neither cell collapses below 2pt
        // (~0.7mm), which keeps a draggable handle visible.
        const i = d.cellIndex;
        const min = 2;
        const maxRight = d.origWidths[i + 1] - min; // upper bound of dx
        const maxLeft = -(d.origWidths[i] - min); // lower bound of dx
        const clamped = Math.max(maxLeft, Math.min(maxRight, dxPts));
        const next = d.origWidths.slice();
        next[i] = d.origWidths[i] + clamped;
        next[i + 1] = d.origWidths[i + 1] - clamped;
        setWidgets(
          (prev) =>
            prev.map((w) =>
              w.id !== d.id
                ? w
                : { ...w, props: { ...w.props, cellWidths: next } }
            ),
          { coalesce: true }
        );
        return;
      }

      // move/resize both work in PDF Y (which grows UP), so invert
      // browser dy here. combCell never reads Y at all.
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
        (prev) =>
          prev.map((w) => {
            if (w.id !== d.id) return w;
            const merged: Widget = { ...w, ...next };
            // Comb widgets with per-cell widths: scale the array
            // proportionally so the visual pattern survives an outer
            // resize. Without this, dragging the e/w handle would
            // stretch widget.w but leave cellWidths summing to the old
            // value, producing dead space (or overflow) on the right.
            const origCellWidths = (d.orig as Widget).props?.cellWidths;
            if (
              w.type === "comb" &&
              Array.isArray(origCellWidths) &&
              origCellWidths.length > 0 &&
              d.orig.w > 0 &&
              next.w > 0 &&
              next.w !== d.orig.w
            ) {
              // Scale from the drag-start snapshot, not the live widget.
              // The live widget already has the previous frame's scaled
              // values; scaling those again would compound each frame.
              const factor = next.w / d.orig.w;
              const scaled = (origCellWidths as unknown[]).map(
                (n) => (Number(n) || 0) * factor
              );
              merged.props = { ...w.props, cellWidths: scaled };
            }
            return merged;
          }),
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

  // GROUP / UNGROUP -------------------------------------------------------
  // Cmd+G assigns a shared _group ID to all selected widgets so they move
  // together. Cmd+Shift+G removes the shared grouping.
  function groupSelection() {
    if (selectedIds.length < 2) return;
    const gid = `g-${Date.now().toString(36)}`;
    history.commit(
      widgets.map((w) =>
        selectedSet.has(w.id)
          ? { ...w, props: { ...w.props, _group: gid } }
          : w
      )
    );
  }
  function ungroupSelection() {
    if (selectedIds.length === 0) return;
    const groupIds = new Set(
      selectedIds
        .map((id) => widgets.find((w) => w.id === id)?.props?._group)
        .filter(Boolean) as string[]
    );
    if (groupIds.size === 0) return;
    history.commit(
      widgets.map((w) => {
        if (w.props?._group && groupIds.has(w.props._group as string)) {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { _group, ...rest } = w.props;
          return { ...w, props: rest };
        }
        return w;
      })
    );
  }
  /** Select every widget that shares a group ID. */
  function selectGroup(groupId: string) {
    setSelectedIds(widgets.filter((w) => w.props?._group === groupId).map((w) => w.id));
  }

  /** Rename a group — writes props._groupName on every member. Empty label
   *  clears the name (falling back to the auto "Group xxxx" display). */
  function renameGroup(groupId: string, name: string) {
    const trimmed = name.trim();
    history.commit(
      widgets.map((w) => {
        if (w.props?._group !== groupId) return w;
        if (trimmed === "") {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { _groupName, ...rest } = w.props ?? {};
          return { ...w, props: rest };
        }
        return { ...w, props: { ...w.props, _groupName: trimmed } };
      })
    );
  }

  /** Ungroup by group id — strips _group/_groupName from every member. */
  function ungroupById(groupId: string) {
    history.commit(
      widgets.map((w) => {
        if (w.props?._group !== groupId) return w;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { _group, _groupName, ...rest } = w.props ?? {};
        return { ...w, props: rest };
      })
    );
  }

  /** Delete every widget that belongs to the group. */
  function deleteGroupById(groupId: string) {
    const remaining = widgets.filter((w) => w.props?._group !== groupId);
    history.commit(remaining);
    setSelectedIds((ids) =>
      ids.filter((id) => remaining.some((w) => w.id === id))
    );
  }

  /** Count of distinct groups on the template — drives the rail badge. */
  const groupCount = useMemo(() => {
    const s = new Set<string>();
    for (const w of widgets) {
      const g = w.props?._group as string | undefined;
      if (g) s.add(g);
    }
    return s.size;
  }, [widgets]);

  /**
   * Reverse index: dataKey → widget ids that bind to it. The schema panel
   * uses this to render the "·N" bind-count badge next to each leaf and
   * to power reverse-navigation when no widget is selected.
   */
  const bindingsByKey = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const w of widgets) {
      if (!w.dataKey) continue;
      (out[w.dataKey] ||= []).push(w.id);
    }
    return out;
  }, [widgets]);

  // WIDGET RENAME (layers panel) -----------------------------------------
  function renameWidget(id: string, label: string) {
    setWidgets((prev) =>
      prev.map((w) =>
        w.id === id
          ? { ...w, props: { ...w.props, _label: label || undefined } }
          : w
      )
    );
  }

  // LAYERS REORDER -------------------------------------------------------
  // Drag a layer row over another → swap z-indices so the dragged widget
  // takes the z-position of the drop target and vice versa.
  function reorderLayer(draggedId: string, targetId: string) {
    const dragged = widgets.find((w) => w.id === draggedId);
    const target = widgets.find((w) => w.id === targetId);
    if (!dragged || !target) return;
    const dragZ = dragged.zIndex;
    const targZ = target.zIndex;
    history.commit(
      widgets.map((w) => {
        if (w.id === draggedId) return { ...w, zIndex: targZ };
        if (w.id === targetId) return { ...w, zIndex: dragZ };
        return w;
      })
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
    // Acro-bound widgets are projections of real PDF /FT fields —
    // deleting one in the designer wouldn't change the PDF, it would
    // just orphan the field. Skip them silently so a Delete keystroke
    // on a mixed selection still cleans up the user-added overlays.
    setWidgets((prev) =>
      prev.filter((w) => !selectedSet.has(w.id) || !!w.acroFieldName)
    );
    setSelectedIds((cur) => {
      // Keep the acro-bound members of the selection visible — the
      // user still wants the inspector open on them.
      const stillThere = new Set(
        widgets.filter((w) => !!w.acroFieldName).map((w) => w.id)
      );
      return cur.filter((id) => stillThere.has(id));
    });
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
    // Viewer shares reach this component too — short-circuit locally so
    // autosave doesn't spam 403s for every keystroke. The top banner on
    // the designer page already tells the user nothing will persist.
    if (readOnly) return;
    setSaving(true);
    try {
      // Split widgets back into the two persistent stores they came
      // from: real overlays go to /widgets, acro-bound projections go
      // back to /config.mappings. Keeping the two stores separate
      // preserves the existing API contract — old clients that only
      // read `mappings` continue to work.
      const realWidgets = widgets.filter((w) => !w.acroFieldName);
      const acroBound = widgets.filter((w) => !!w.acroFieldName);

      const payload = realWidgets.map((w) => ({
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
      // Persist sample data alongside widgets so it survives page
      // refresh. For acroform-mode templates we ALSO rebuild
      // config.mappings from the acro-bound widget set so binding
      // edits round-trip through the existing acroform fill path.
      try {
        const sampleData = JSON.parse(sampleJSON || "{}");
        const mergedConfig: Record<string, any> = {
          ...currentConfig,
          sampleData,
        };
        if (acroBound.length > 0) {
          // Each acro-bound widget carries the rich AcroMapping in
          // props._acroMapping (plus a possibly-edited dataKey at the
          // top level). Reconstitute the MappingMap by merging the
          // current dataKey on top of the stored mapping.
          const mappings: Record<string, any> = {
            ...(currentConfig?.mappings || {}),
          };
          for (const w of acroBound) {
            const base =
              (w.props?._acroMapping as Record<string, any>) || {
                dataKey: w.acroFieldName!,
              };
            mappings[w.acroFieldName!] = {
              ...base,
              dataKey: w.dataKey || base.dataKey || w.acroFieldName!,
            };
          }
          mergedConfig.mappings = mappings;
        }
        await api(`/v1/templates/${tpl.id}/config`, {
          method: "PUT",
          body: JSON.stringify({ config: mergedConfig }),
        });
        setCurrentConfig(mergedConfig);
      } catch {
        // Non-fatal — sample data is UI-only, don't block save on parse error.
      }
      setLastSaved(new Date());
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setSaving(false);
    }
  }, [widgets, tpl.id, toast, readOnly]);

  // Import a full template config JSON, replacing widgets + page layout +
  // sample data while preserving acroform-bound widgets that belong to
  // THIS pdf's /Annots. Reused by the More-actions menu and the Sample
  // dialog's import card so both surfaces share the same flow.
  const importFullConfig = useCallback(async () => {
    if (readOnly) return;
    try {
      const imported = await pickAndParseFullImport();
      if (!imported) return; // user cancelled the picker
      const acroCount = widgets.filter((w) => w.acroFieldName).length;
      const ok = window.confirm(
        `Import will replace ${widgets.length - acroCount} user widget(s) and overwrite sample data + page layout. Continue?\n\n` +
          `Incoming: ${imported.widgets.length} widget(s)` +
          (imported.sourceMeta.name ? ` from "${imported.sourceMeta.name}"` : "") +
          `.`
      );
      if (!ok) return;
      // Re-id every imported widget so they never collide with widgets
      // already in state. Strip acroFieldName too — those bindings are
      // tied to the CURRENT pdf's /Annots and don't transfer.
      const reIded: Widget[] = imported.widgets.map((w) => ({
        id: newId(),
        type: w.type,
        page: w.page,
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
        dataKey: w.dataKey,
        zIndex: w.zIndex,
        props: w.props ?? {},
        ...(w.locked ? { locked: true } : {}),
        ...(w.hidden ? { hidden: true } : {}),
      }));
      const acroBound = widgets.filter((w) => w.acroFieldName);
      setWidgets(() => [...acroBound, ...reIded]);
      setCurrentConfig((prev: Record<string, any>) => ({
        ...prev,
        ...imported.config,
        // Don't let an import wipe mappings for THIS pdf's acroform
        // fields — they're tied to the document, not the design.
        mappings: prev?.mappings ?? imported.config?.mappings ?? {},
      }));
      setSampleJSON(JSON.stringify(imported.sampleData, null, 2));
      setSelectedIds([]);
      toast.show(
        "success",
        `Imported ${reIded.length} widget(s) — remember to Save.`
      );
    } catch (e: any) {
      toast.show("error", `Import failed: ${e?.message || e}`);
    }
  }, [readOnly, widgets, setWidgets, toast]);

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
      // PageUp / PageDown navigate pages in paginated mode. In continuous
      // mode we fall through and let the browser scroll naturally — that's
      // what users expect from a long, scrolling document.
      if (!mod && (e.key === "PageUp" || e.key === "PageDown")) {
        if (viewMode !== "paginated" || numPages <= 1) return;
        e.preventDefault();
        if (e.key === "PageUp") {
          setCurrentPage((p) => Math.max(1, p - 1));
        } else {
          setCurrentPage((p) => Math.min(numPages, p + 1));
        }
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
      // Group / ungroup
      if (mod && e.key.toLowerCase() === "g" && !e.shiftKey) {
        e.preventDefault();
        groupSelection();
        return;
      }
      if (mod && e.key.toLowerCase() === "g" && e.shiftKey) {
        e.preventDefault();
        ungroupSelection();
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
        // Cancel cell-pitch sampling first if active, otherwise
        // fall through to clearing the selection.
        if (sampleMode) {
          setSampleMode(null);
          return;
        }
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
  }, [selectedIds, widgets, history, save, clipboard, zoom, sampleMode, viewMode, numPages]);

  // GENERATE / BATCH -----------------------------------------------------
  function openGenerate() {
    // Seed the Generate dialog with whatever's in the designer's live
    // sample data, falling back to empty strings for any widget key
    // that's missing. The old implementation always blanked everything,
    // which meant hitting Generate right after designing produced a PDF
    // with no text overlaid — the preview showed just the empty
    // AcroForm widget boxes with no resolved values, and users
    // reasonably concluded "no content is displaying".
    let base: Record<string, any> = {};
    try {
      const parsed = JSON.parse(sampleJSON || "{}");
      if (parsed && typeof parsed === "object") base = parsed;
    } catch {
      base = {};
    }
    const skel: Record<string, any> = { ...base };
    for (const w of widgets) {
      if (!w.dataKey) continue;
      if (!(w.dataKey in skel)) skel[w.dataKey] = "";
    }
    setGenJSON(JSON.stringify(skel, null, 2));
    setGenOpen(true);
  }

  async function runGenerateFlow() {
    setGenBusy(true);
    setGenProgress(null);
    try {
      const data = JSON.parse(genJSON);
      // Persist the latest widget state before generating. The backend
      // pulls widgets from the DB via loadWidgets(), so if the user
      // added/edited widgets without saving (autosave is off by default)
      // the overlay would render against stale data — producing PDFs
      // with values "missing". Always-save right before generate makes
      // the button do what users expect: render WHAT THEY SEE.
      // No-op for read-only viewers (save() short-circuits internally).
      if (!readOnly) {
        setGenProgress("saving…");
        await save();
      }
      setGenProgress(null);
      // Build the security block lazily — only send when the user typed
      // a password. Sending an empty block would tell the server "render
      // unprotected even if the template would have encrypted", which is
      // a legitimate but rare ask; the dialog has no way to express it
      // explicitly today, so we keep behaviour simple and let the
      // template's policy apply when both fields are blank.
      const security =
        genUserPwd || genOwnerPwd
          ? {
              userPassword: genUserPwd || undefined,
              ownerPassword: genOwnerPwd || undefined,
              encryption: genEncryption,
              permissions: genPermAll
                ? { all: true }
                : {
                    print: genPermPrint,
                    copy: genPermCopy,
                    modify: genPermModify,
                    annotate: genPermAnnotate,
                  },
            }
          : undefined;
      const result = await runGenerate(tpl.id, {
        data,
        async: genAsync,
        flatten: genFlatten || undefined,
        // Server defaults to true for legacy parity, so we ALWAYS send
        // the explicit value from the dialog — no implicit fallback.
        saveToDrive: genSaveToDrive,
        outputName: genOutputName.trim() || undefined,
        outputPath: genOutputPath.trim() || undefined,
        security,
        onProgress: setGenProgress,
      });
      setGenResult({
        downloadUrl: result.downloadUrl,
        outputFileId: result.outputFileId,
        fileName: `${tplName}.pdf`,
      });
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

  // Acro-bound widgets store their full mapping (transform pipeline,
  // validation, fillWhen, etc.) inside `props._acroMapping`. On save() we
  // unpack that back into config.mappings — so the rich editor here just
  // needs to keep that one tunneled object in sync. dataKey is mirrored
  // out to the top-level widget field too, since the rest of the
  // designer (schema panel, validation panel, live preview) reads it
  // from there.
  function patchAcroMapping(patch: Partial<AcroMapping>) {
    if (!selected || !selected.acroFieldName) return;
    const cur =
      (selected.props?._acroMapping as AcroMapping) ||
      ({ dataKey: selected.dataKey } as AcroMapping);
    const merged: AcroMapping = { ...cur, ...patch };
    const nextProps = { ...selected.props, _acroMapping: merged };
    const topPatch: Partial<Widget> = { props: nextProps };
    if (patch.dataKey !== undefined) topPatch.dataKey = patch.dataKey;
    updateSelected(topPatch);
  }

  // Bind the clicked schema path to the currently-selected widget(s). If
  // more than one widget is selected, only the primary one is rebound —
  // bulk rebinding isn't the common intent.
  // SYNC SAMPLE -----------------------------------------------------------
  // Merges every widget dataKey that's currently missing from the sample
  // into the sample JSON, using an empty-string placeholder value.
  // Dot-paths are expanded into nested objects:
  //   "invoice.total" → { invoice: { total: "" } }
  function syncSampleFromWidgets() {
    const missingKeys = widgets
      .map((w) => w.dataKey)
      .filter((k) => k && !keyExists(sampleKeys, k));
    if (missingKeys.length === 0) return;

    let current: Record<string, any> = {};
    try {
      current = JSON.parse(sampleJSON || "{}");
    } catch { /* keep empty */ }

    function setNestedKey(obj: Record<string, any>, dotPath: string): void {
      const parts = dotPath.split(".");
      let cur = obj;
      for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") {
          cur[parts[i]] = {};
        }
        cur = cur[parts[i]];
      }
      const leaf = parts[parts.length - 1];
      if (cur[leaf] === undefined) cur[leaf] = "";
    }

    for (const key of missingKeys) {
      setNestedKey(current, key);
    }
    setSampleJSON(JSON.stringify(current, null, 2));
    toast.show("success", `Added ${missingKeys.length} missing key${missingKeys.length === 1 ? "" : "s"} to sample`);
  }

  function bindSelectedTo(path: string) {
    if (!selected) {
      toast.show("info", "Select a widget first, then click a key to bind.");
      return;
    }
    updateSelected({ dataKey: path });
    toast.show(
      "success",
      `Bound "${widgetLabel(selected)}" → ${path}`
    );
  }

  // Reverse-navigation: when the schema tab is open with no widget
  // selected, clicking a key that already has bindings selects the first
  // widget bound to it and scrolls it into view. Lets users explore "what
  // is this key wired to?" without context-switching to the canvas.
  function selectFirstWidgetForKey(path: string) {
    const target = widgets.find((w) => w.dataKey === path);
    if (!target) {
      toast.show("info", "No widget is bound to that key yet.");
      return;
    }
    setSelectedIds([target.id]);
    const el = pageRefs.current[target.page || 1];
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    toast.show("success", `Selected "${widgetLabel(target)}"`);
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
      { id: "arr:group", label: "Group selection", hint: `${M}G`, group: "Arrange", run: groupSelection },
      { id: "arr:ungroup", label: "Ungroup selection", hint: `${M}⇧G`, group: "Arrange", run: ungroupSelection },
      { id: "arr:inspect", label: "Open validation panel", group: "Arrange", run: () => setActivePanel("inspect") },
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
        id: "view:mode",
        label:
          viewMode === "continuous"
            ? "View one page at a time (paginated)"
            : "View all pages (continuous)",
        group: "View",
        run: () =>
          setViewMode((m) => (m === "continuous" ? "paginated" : "continuous")),
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
        id: "panel:fields:schema",
        label: "Open Fields → Schema",
        group: "Panels",
        run: () => {
          setActivePanel("fields");
          setFieldsTab("schema");
        },
      },
      {
        id: "panel:fields:layers",
        label: "Open Fields → Layers",
        group: "Panels",
        run: () => {
          setActivePanel("fields");
          setFieldsTab("layers");
        },
      },
      {
        id: "panel:fields:taborder",
        label: "Open Fields → Tab order",
        group: "Panels",
        run: () => {
          setActivePanel("fields");
          setFieldsTab("taborder");
        },
      },
      {
        id: "data:preview",
        label: livePreview ? "Disable live data preview" : "Enable live data preview",
        group: "Data",
        run: () => setLivePreview((v) => !v),
      },
      { id: "data:sample", label: "Edit sample JSON", group: "Data", run: () => setEditSampleOpen(true) },
      { id: "data:rename", label: "Bulk rename data key", group: "Data", run: () => setBulkRenameOpen(true) },
      {
        id: "data:export:full",
        label: "Export full template config (widgets + layout + data)",
        group: "Data",
        run: () => downloadFullExport(tpl, widgets, currentConfig, sampleJSON),
      },
      {
        id: "data:import:full",
        label: "Import full template config (JSON)",
        group: "Data",
        run: () => importFullConfig(),
      },
      {
        id: "data:export:json",
        label: "Export schema → JSON",
        group: "Data",
        run: () => {
          try {
            downloadJSON(JSON.stringify(JSON.parse(sampleJSON || "{}"), null, 2), `${tpl.name || "schema"}.json`);
          } catch { toast.show("error", "Sample data is not valid JSON"); }
        },
      },
      {
        id: "data:export:ts",
        label: "Export schema → TypeScript interface",
        group: "Data",
        run: () => {
          try {
            downloadTypeScript(JSON.parse(sampleJSON || "{}"), `${tpl.name || "schema"}.ts`);
          } catch { toast.show("error", "Sample data is not valid JSON"); }
        },
      },
      {
        id: "data:export:skeleton",
        label: "Export skeleton payload",
        group: "Data",
        run: () => {
          try {
            downloadSkeleton(JSON.parse(sampleJSON || "{}"), `${tpl.name || "payload"}-skeleton.json`);
          } catch { toast.show("error", "Sample data is not valid JSON"); }
        },
      },
      {
        id: "data:export:copy",
        label: "Copy schema JSON to clipboard",
        group: "Data",
        run: () => copyToClipboard(sampleJSON).then((ok) => {
          if (ok) toast.show("success", "Schema JSON copied to clipboard");
        }),
      },
      { id: "file:save", label: "Save now", hint: `${M}S`, group: "File", run: save },
      { id: "file:generate", label: "Generate PDF", group: "File", run: openGenerate },
      // Same save-before-render guarantee as single Generate — the
      // batch runner reads widgets from the DB, not from this React
      // tree. Without saving first, every CSV row would render against
      // whatever was last persisted and the user's recent changes
      // would silently disappear.
      { id: "file:batch", label: "Batch generate from CSV", group: "File", run: async () => { if (!readOnly) await save(); setBatchOpen(true); } },
      { id: "view:collab", label: "Open comments & reviews", group: "Share", run: () => setCollabOpen(true) },
      { id: "ai:detect-fields", label: "Auto-detect form fields", group: "AI", run: () => { if (!readOnly) setAiDetectOpen(true); } },
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
    viewMode,
    fieldsTab,
    fullscreen,
    zoom,
    livePreview,
    history.undo,
    history.redo,
    save,
  ]);

  const paletteEls = useMemo(() => {
    // Group by category so the expanded palette (now ~15 types) stays
    // scannable. Preserves original order within each group.
    const groups: Record<string, typeof PALETTE> = {};
    const order: string[] = [];
    for (const p of PALETTE) {
      const g = p.group || "Misc";
      if (!groups[g]) {
        groups[g] = [];
        order.push(g);
      }
      groups[g].push(p);
    }
    return (
      <div className="space-y-3">
        {order.map((g) => (
          <div key={g} className="space-y-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {g}
            </div>
            {groups[g].map((p) => (
              <div
                key={p.type}
                draggable
                onDragStart={(e) => onPaletteDragStart(e, p.type)}
                onDoubleClick={() => insertFromPalette(p.type)}
                title="Drag to page, or double-click to insert"
                className="cursor-grab select-none rounded border bg-white px-3 py-1.5 text-sm hover:border-blue-500"
              >
                {p.label}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgets.length, pageDims]);

  const savedHint = saving
    ? "Saving…"
    : lastSaved
    ? `Saved ${formatRelative(lastSaved)}`
    : "Unsaved";

  return (
    <div
      ref={rootRef}
      className={
        // h-screen (not min-h-screen) so the root is *exactly* the
        // viewport height. Without this, a tall PDF stack in
        // continuous mode grew the page, the window itself became the
        // scroller, and the canvas's `flex-1 overflow-auto` never had
        // a constrained height to scroll inside — making the last
        // page unreachable when adding fields. Fullscreen already
        // pins via `fixed inset-0` so it gets the same effect.
        "flex flex-col " +
        (fullscreen ? "fixed inset-0 z-50 bg-background" : "h-screen")
      }
    >
      <header className="bg-white border-b px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/drive" className="text-blue-600 hover:underline text-sm">← Drive</Link>
          <InlineRenameTitle
            templateId={tpl.id}
            name={tplName}
            onRenamed={setTplName}
            className="font-semibold"
          />
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
            disabled={saving || readOnly}
            title={
              readOnly
                ? "View-only access — ask the owner for edit access"
                : undefined
            }
            className="px-4 py-2 text-sm border rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            onClick={openGenerate}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Generate
          </button>
          {/* Extract text + Summarize / Ask. Both open a right-side
              drawer so the designer canvas stays visible behind them
              — useful when the user wants to copy a value out of the
              source PDF and paste it into a widget property. */}
          {fileId ? (
            <DocAITools fileId={fileId} fileName={tpl.name} />
          ) : null}
          {/* API integration guide — drawer with endpoint, payload, and
              runnable snippets derived from this template's schema. */}
          <ApiGuideSheet templateId={tpl.id} templateName={tpl.name} />
          {/* Collaboration — comments, @mentions, request-review, and
              external review-links. Surfaces the same drawer the
              markdown / HTML designers expose so PDF authors aren't a
              second-class citizen for review workflows. */}
          <button
            type="button"
            title="Auto-detect form fields from PDF"
            onClick={() => setAiDetectOpen(true)}
            disabled={readOnly}
            className="inline-flex items-center gap-1 px-2 py-2 text-sm border rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed text-violet-700 border-violet-200 hover:bg-violet-50"
          >
            <Sparkles className="h-4 w-4" />
            <span className="hidden lg:inline">Auto-detect</span>
          </button>
          <button
            type="button"
            title="Comments & reviews"
            onClick={() => setCollabOpen(true)}
            className="inline-flex items-center gap-1 px-2 py-2 text-sm border rounded hover:bg-gray-50"
          >
            <MessageSquare className="h-4 w-4" />
            <span className="hidden lg:inline">Collaborate</span>
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
              <DropdownMenuItem
                onClick={async () => {
                  // Save before opening batch — see comment on the
                  // command-palette equivalent for full rationale.
                  if (!readOnly) await save();
                  setBatchOpen(true);
                }}
              >
                Batch generate (CSV)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setLayoutOpen(true)}>
                <Settings2 className="h-4 w-4" /> Page layout
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* Import / Export — full template config. The same actions
                  also live inside the Sample-data dialog's import/export
                  toolbar; surfacing them here makes them discoverable
                  from the top-level menu without opening the dialog. */}
              <DropdownMenuItem
                onClick={() =>
                  downloadFullExport(tpl, widgets, currentConfig, sampleJSON)
                }
              >
                <PackageOpen className="h-4 w-4" /> Export config (JSON)
              </DropdownMenuItem>
              {!readOnly && (
                <DropdownMenuItem onClick={() => importFullConfig()}>
                  <Upload className="h-4 w-4" /> Import config (JSON)
                </DropdownMenuItem>
              )}
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
          {/* Fields: merged Data schema / Layers / Tab order. The tab
              the user picks survives panel toggles via `fieldsTab`. */}
          <RailBtn
            icon={Database}
            label="Fields (schema · layers · tab order)"
            active={activePanel === "fields"}
            onClick={() =>
              setActivePanel((p) => (p === "fields" ? null : "fields"))
            }
            badge={widgets.length || undefined}
          />
          <RailBtn
            icon={Group}
            label="Groups"
            active={activePanel === "groups"}
            onClick={() =>
              setActivePanel((p) => (p === "groups" ? null : "groups"))
            }
            badge={groupCount || undefined}
          />
          <RailBtn
            icon={ShieldCheck}
            label="Validation"
            active={activePanel === "inspect"}
            onClick={() =>
              setActivePanel((p) => (p === "inspect" ? null : "inspect"))
            }
            badge={issueCount || undefined}
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
            {paletteEls}
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
        {activePanel === "fields" && (
          <aside className="w-64 shrink-0 border-r bg-muted/20 flex flex-col">
            {/* Segmented sub-nav. Three lenses on the same widget list:
                Schema = data-key bindings + sample data, Layers = z-order
                + lock/hide, Tab order = AcroForm tab traversal. */}
            <div className="flex items-stretch border-b bg-background text-[11px]">
              <FieldsTabBtn
                active={fieldsTab === "schema"}
                onClick={() => setFieldsTab("schema")}
                icon={Database}
                label="Schema"
              />
              <FieldsTabBtn
                active={fieldsTab === "layers"}
                onClick={() => setFieldsTab("layers")}
                icon={Layers}
                label="Layers"
                badge={widgets.length || undefined}
              />
              <FieldsTabBtn
                active={fieldsTab === "taborder"}
                onClick={() => setFieldsTab("taborder")}
                icon={Hash}
                label="Tab"
              />
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              {fieldsTab === "schema" && (
                <SchemaPanel
                  sampleJSON={sampleJSON}
                  templateName={tpl.name}
                  usedKeys={widgets.map((w) => w.dataKey).filter(Boolean)}
                  selectedDataKey={selected?.dataKey}
                  selectedWidgetLabel={
                    selected
                      ? widgetLabel(selected) +
                        (selectedIds.length > 1
                          ? ` (+${selectedIds.length - 1} more — only the first will be bound)`
                          : "")
                      : undefined
                  }
                  bindingsByKey={bindingsByKey}
                  onBind={bindSelectedTo}
                  onSelectByKey={selectFirstWidgetForKey}
                  onEditSample={() => setEditSampleOpen(true)}
                  onSyncSample={syncSampleFromWidgets}
                  onExportFull={() => downloadFullExport(tpl, widgets, currentConfig, sampleJSON)}
                />
              )}
              {fieldsTab === "layers" && (
                <LayersPanel
                  widgets={widgets as LayerWidget[]}
                  selectedIds={selectedIds}
                  onSelect={setSelectedIds}
                  onReorder={reorderLayer}
                  onToggleLock={(id) => {
                    setWidgets((prev) =>
                      prev.map((w) => (w.id === id ? { ...w, locked: !w.locked } : w))
                    );
                  }}
                  onToggleHide={(id) => {
                    setWidgets((prev) =>
                      prev.map((w) => (w.id === id ? { ...w, hidden: !w.hidden } : w))
                    );
                  }}
                  onRename={renameWidget}
                  onSelectGroup={selectGroup}
                  onGroupSelection={groupSelection}
                  onUngroupSelection={ungroupSelection}
                />
              )}
              {fieldsTab === "taborder" && (
                <TabOrderPanel
                  widgets={widgets as TabWidget[]}
                  selectedIds={selectedIds}
                  onSelect={(id) => setSelectedIds([id])}
                  onReorder={(orderedIds) => {
                    setWidgets((prev) =>
                      prev.map((w) => {
                        const idx = orderedIds.indexOf(w.id);
                        if (idx === -1) return w;
                        return {
                          ...w,
                          props: { ...w.props, acroTabOrder: idx + 1 },
                        };
                      })
                    );
                  }}
                />
              )}
            </div>
          </aside>
        )}
        {activePanel === "groups" && (
          <aside className="w-64 shrink-0 border-r bg-muted/20">
            <GroupsPanel
              widgets={widgets as GroupWidget[]}
              selectedIds={selectedIds}
              onCreateGroup={groupSelection}
              onRenameGroup={renameGroup}
              onSelectGroup={selectGroup}
              onUngroup={ungroupById}
              onDeleteGroup={deleteGroupById}
            />
          </aside>
        )}
        {activePanel === "inspect" && (
          <aside className="w-64 shrink-0 border-r bg-muted/20">
            <ValidationPanel
              issues={validationIssues}
              onSelectWidget={(id) => {
                setSelectedIds([id]);
                // Scroll widget into view
                const w = widgets.find((x) => x.id === id);
                if (w) {
                  const el = pageRefs.current[w.page || 1];
                  el?.scrollIntoView({ behavior: "smooth", block: "center" });
                }
              }}
            />
          </aside>
        )}

        {/* Canvas */}
        <section
          ref={canvasRef}
          className={
            // min-w-0 is critical: without it, a flex item's
            // implicit min-width: auto refuses to shrink below the
            // PDF's intrinsic rendered width (SCALE * pageWidth ≈
            // 918px for letter), so the whole designer overflows
            // horizontally instead of letting overflow-auto here
            // produce an internal scrollbar.
            "flex-1 min-w-0 overflow-auto bg-gray-200 min-h-0 " +
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
          {/* Sticky banner for cell-pitch sampling — anchored to the
              top of the canvas so users can read the next instruction
              even after they've scrolled the PDF. */}
          {sampleMode && (
            <div className="sticky top-0 z-40 -mx-6 -mt-10 mb-4 border-b border-blue-200 bg-blue-50 px-6 py-2 text-sm text-blue-900 shadow-sm">
              <div className="flex items-center justify-between gap-4">
                <span>
                  <span className="font-semibold">Sampling cell pitch:</span>{" "}
                  {sampleMode.firstPdf
                    ? "Now click the RIGHT edge of the LAST printed cell."
                    : "Click the LEFT edge of the FIRST printed cell."}
                </span>
                <button
                  onClick={() => setSampleMode(null)}
                  className="text-xs underline hover:no-underline"
                >
                  Cancel (Esc)
                </button>
              </div>
            </div>
          )}
          <Document
            file={previewUrl}
            onLoadSuccess={({ numPages }) => setNumPages(numPages)}
            loading={<div className="text-gray-500">Loading PDF…</div>}
            error={<div className="text-red-600">Failed to load PDF</div>}
          >
            {Array.from({ length: numPages }, (_, i) => i + 1)
              // Paginated mode: render only the active page. We still let
              // react-pdf's <Document> mount normally so onLoadSuccess fires
              // with the real numPages — switching modes never loses the
              // page count or has to refetch the PDF.
              .filter(
                (pageNum) =>
                  viewMode === "continuous" || pageNum === currentPage
              )
              .map((pageNum) => {
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
                  {/* Cell-pitch sampling overlay — captures the next two
                      clicks when the user is calibrating a comb widget
                      against a printed grid. Sits ABOVE the widget
                      overlay so it intercepts clicks even on top of
                      existing widgets. Only rendered while sampling. */}
                  {sampleMode && (
                    <div
                      className="absolute inset-0 z-30 cursor-crosshair"
                      style={{ background: "rgba(59,130,246,0.04)" }}
                      title="Click to mark cell edge — Esc to cancel"
                      onClick={(e) => {
                        e.stopPropagation();
                        const rect = pageRefs.current[pageNum]?.getBoundingClientRect();
                        const info = pageInfo(pageNum);
                        if (!rect || !info) return;
                        const bx = e.clientX - rect.left;
                        const by = e.clientY - rect.top;
                        const pdf = browserToPdf({ x: bx, y: by, w: 0, h: 0 }, info);
                        if (!sampleMode.firstPdf) {
                          // First click — anchor the LEFT edge.
                          setSampleMode({
                            ...sampleMode,
                            firstPdf: { page: pageNum, x: pdf.x },
                          });
                          return;
                        }
                        // Second click — anchor the RIGHT edge and
                        // derive pitch + reposition the widget.
                        const target = widgets.find(
                          (w) => w.id === sampleMode.widgetId,
                        );
                        if (!target) {
                          setSampleMode(null);
                          return;
                        }
                        const x1 = sampleMode.firstPdf.x;
                        const x2 = pdf.x;
                        const xLeft = Math.min(x1, x2);
                        const xRight = Math.max(x1, x2);
                        const totalW = xRight - xLeft;
                        const cells = Math.max(
                          1,
                          Math.round(Number(target.props?.cells ?? 10)),
                        );
                        const pitch = totalW / cells;
                        // Apply: move widget X to the sampled left edge,
                        // resize to span the full grid, lock the pitch
                        // so future cell-count edits scale W proportionally.
                        setWidgets((prev) =>
                          prev.map((w) =>
                            w.id === target.id
                              ? {
                                  ...w,
                                  x: xLeft,
                                  w: totalW,
                                  page: sampleMode.firstPdf!.page,
                                  props: {
                                    ...(w.props || {}),
                                    cellWidth: pitch,
                                  },
                                }
                              : w,
                          ),
                        );
                        toast.show(
                          "success",
                          `Sampled pitch ${pitch.toFixed(2)}pt across ${cells} cell${cells === 1 ? "" : "s"}`,
                        );
                        setSampleMode(null);
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
                                // If the widget belongs to a group, select all members
                                const gid = w.props?._group as string | undefined;
                                if (gid) {
                                  setSelectedIds(
                                    widgets.filter((x) => x.props?._group === gid).map((x) => x.id)
                                  );
                                } else {
                                  setSelectedIds([w.id]);
                                }
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
                              (w.locked ? "cursor-pointer " : "cursor-move ") +
                              (w.hidden || !showIfResult
                                ? "bg-muted/40 opacity-50 border-dashed "
                                : w.acroFieldName
                                ? "bg-amber-50/40 border-dashed "
                                : showPreview
                                ? "bg-white/90 "
                                : "bg-blue-100/40 ") +
                              (w.acroFieldName
                                ? isPrimary
                                  ? "border-amber-600 ring-2 ring-amber-300"
                                  : isSel
                                  ? "border-amber-500 ring-1 ring-amber-200"
                                  : "border-amber-500"
                                : keyMissing
                                ? "border-amber-500 ring-1 ring-amber-300"
                                : isPrimary
                                ? "border-blue-600 ring-2 ring-blue-300"
                                : isSel
                                ? "border-blue-500 ring-1 ring-blue-200"
                                : "border-blue-400")
                            }
                            style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
                            title={
                              (w.acroFieldName
                                ? `AcroForm /${w.acroFieldType || "FT"} field "${w.acroFieldName}" — `
                                : "") +
                              (w.locked && !w.acroFieldName ? "(Locked) " : "") +
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
                                  ? "text-[11px] text-foreground" +
                                    (w.props?.bold ? " font-bold" : "") +
                                    (w.props?.italic ? " italic" : "") +
                                    (w.props?.underline ? " underline" : "")
                                  : "font-mono text-[10px] text-blue-900")
                              }
                            >
                              {w.acroFieldName ? "▦ " : w.locked ? "🔒 " : ""}
                              {w.hidden ? "👁 " : ""}
                              {keyMissing ? "⚠ " : ""}
                              {w.type === "radio" ? "◉ " : ""}
                              {w.type === "dropdown" ? "▾ " : ""}
                              {w.type === "signature-field" ? "✎ " : ""}
                              {w.type === "button" ? "▶ " : ""}
                              {w.type === "comb" ? "▦ " : ""}
                              {showPreview ? displayValue : w.dataKey}
                            </span>
                            {isPrimary && !w.locked && w.type === "comb" && (() => {
                              // Per-cell boundary drag handles. We render
                              // N-1 thin vertical strips at the cumulative
                              // cell positions; the renderer reads the same
                              // cellWidths array we mutate here. Equal-pitch
                              // mode is just "no cellWidths set yet" — we
                              // synthesize a flat array on first drag.
                              const cells = Math.max(
                                1,
                                Math.round(Number(w.props?.cells ?? 10))
                              );
                              const widths: number[] =
                                Array.isArray(w.props?.cellWidths) &&
                                w.props.cellWidths.length === cells
                                  ? w.props.cellWidths.map(
                                      (n: unknown) => Number(n) || 0
                                    )
                                  : Array.from({ length: cells }, () => {
                                      const pitch = Number(w.props?.cellWidth);
                                      return pitch > 0 ? pitch : w.w / cells;
                                    });
                              const handles: React.ReactNode[] = [];
                              let acc = 0;
                              for (let i = 0; i < cells - 1; i++) {
                                acc += widths[i];
                                handles.push(
                                  <div
                                    key={`cb-${i}`}
                                    onMouseDown={(e) =>
                                      beginCombCellResize(e, w, i)
                                    }
                                    className="absolute bg-blue-500/60 hover:bg-blue-700 cursor-col-resize"
                                    style={{
                                      left: acc * effectiveScale - 2,
                                      top: 0,
                                      width: 4,
                                      height: b.h,
                                      zIndex: 5,
                                    }}
                                    title={`Drag to resize cells ${i + 1} ↔ ${i + 2}`}
                                  />
                                );
                              }
                              return <>{handles}</>;
                            })()}
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
        <aside className="w-80 shrink-0 bg-white border-l overflow-y-auto">
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
            selected.acroFieldName ? (
              // ACRO-BOUND WIDGET — synthesises the AcroForm Designer's
              // rich mapping editor inside this same Properties panel so
              // the user gets the full transform-pipeline / validation /
              // conditional UI without context-switching to a separate
              // designer. Geometry inputs are intentionally omitted: the
              // rect comes from the PDF's /Annots and shouldn't drift.
              <AcroBoundProps
                selected={selected}
                widgets={widgets}
                tpl={tpl}
                sample={sample}
                sampleKeys={sampleKeys}
                patchAcroMapping={patchAcroMapping}
                updateSelected={updateSelected}
              />
            ) : (
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
                selected.type !== "radio" &&
                selected.type !== "qr" &&
                selected.type !== "barcode" &&
                selected.type !== "image" &&
                selected.type !== "signature" &&
                selected.type !== "signature-field" &&
                selected.type !== "button" &&
                selected.type !== "rectangle" &&
                selected.type !== "line" && (
                  <div className="space-y-2 rounded-md border p-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Typography
                    </div>

                    {/* Preset chips */}
                    <div className="flex flex-wrap gap-1">
                      {TYPOGRAPHY_PRESETS.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => {
                            const patch: Record<string, any> = { ...p.props };
                            // strip undefined keys so they don't overwrite existing values
                            Object.keys(patch).forEach(
                              (k) => patch[k] === undefined && delete patch[k]
                            );
                            updateSelected({
                              props: { ...selected.props, ...patch },
                            });
                          }}
                          className="rounded border px-2 py-0.5 text-[10px] font-medium hover:bg-muted/60"
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>

                    {/* Font family */}
                    <Field label="Font family">
                      <select
                        className="w-full rounded border px-2 py-1 text-xs"
                        value={(selected.props?.fontFamily as string) || "Helvetica"}
                        onChange={(e) => updateSelectedProp("fontFamily", e.target.value)}
                      >
                        {FONT_FAMILIES.map((f) => (
                          <option key={f.value} value={f.value}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                    </Field>

                    {/* Size + style toggles on one row */}
                    <div className="flex items-end gap-2">
                      <div className="flex-1">
                        <Field label="Size (pt)">
                          <NumInput
                            value={selected.props?.fontSize ?? 12}
                            onChange={(v) => updateSelectedProp("fontSize", v)}
                          />
                        </Field>
                      </div>
                      {/* B / I / U toggles */}
                      <div className="flex gap-1 pb-0.5">
                        {(
                          [
                            { key: "bold",      Icon: Bold,      title: "Bold" },
                            { key: "italic",    Icon: Italic,    title: "Italic" },
                            { key: "underline", Icon: Underline, title: "Underline" },
                          ] as const
                        ).map(({ key, Icon, title }) => (
                          <button
                            key={key}
                            type="button"
                            title={title}
                            onClick={() =>
                              updateSelectedProp(key, !selected.props?.[key])
                            }
                            className={`grid h-7 w-7 place-items-center rounded border text-xs transition-colors ${
                              selected.props?.[key]
                                ? "bg-primary text-primary-foreground border-primary"
                                : "hover:bg-muted/60"
                            }`}
                          >
                            <Icon className="h-3 w-3" />
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Color + Alignment */}
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Color">
                        <input
                          type="color"
                          className="h-8 w-full rounded border"
                          value={(selected.props?.color as string) || "#111827"}
                          onChange={(e) => updateSelectedProp("color", e.target.value)}
                        />
                      </Field>
                      <Field label="Align">
                        <select
                          className="w-full rounded border px-2 py-1 text-xs"
                          value={(selected.props?.align as string) || "L"}
                          onChange={(e) => updateSelectedProp("align", e.target.value)}
                        >
                          <option value="L">Left</option>
                          <option value="C">Center</option>
                          <option value="R">Right</option>
                        </select>
                      </Field>
                    </div>

                    {/* Line height — only meaningful for multiline/repeat */}
                    {(selected.type === "multiline" || selected.type === "repeat") && (
                      <Field label="Line height (×)">
                        <NumInput
                          value={
                            selected.props?.lineHeight != null
                              ? Number(selected.props.lineHeight)
                              : 1.15
                          }
                          onChange={(v) => updateSelectedProp("lineHeight", v)}
                          step={0.05}
                        />
                      </Field>
                    )}
                  </div>
                )}

              {/* ---- Char-grid (comb) only: cells + pitch + cell-outline ---- */}
              {selected.type === "comb" && (() => {
                const cells = Math.max(
                  1,
                  Math.round(Number(selected.props?.cells ?? 10)),
                );
                // Two pitch sources: explicit `cellWidth` (fixed-pitch
                // mode — survives W resize) or derived from W/cells.
                // The input below shows whichever is authoritative.
                const explicitPitch = Number(selected.props?.cellWidth) || 0;
                const derivedPitch = selected.w / cells;
                const pitch = explicitPitch > 0 ? explicitPitch : derivedPitch;
                return (
                  <div className="space-y-2 rounded-md border p-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Char grid
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Cells">
                        <NumInput
                          value={cells}
                          onChange={(v) => {
                            const next = Math.max(1, Math.round(v));
                            // If the user has set an explicit cell pitch,
                            // grow/shrink W to keep the grid aligned to
                            // that pitch instead of squishing each cell.
                            if (explicitPitch > 0) {
                              updateSelected({
                                w: next * explicitPitch,
                                props: {
                                  ...selected.props,
                                  cells: next,
                                },
                              });
                            } else {
                              updateSelectedProp("cells", next);
                            }
                          }}
                        />
                      </Field>
                      <Field label="Cell width (pt)">
                        <NumInput
                          value={pitch}
                          step={0.1}
                          onChange={(v) => {
                            // Setting cell width locks pitch + recomputes
                            // total W. Set to 0 to clear (revert to
                            // W/cells derivation).
                            const cw = v > 0 ? v : 0;
                            updateSelected({
                              w: cw > 0 ? cw * cells : selected.w,
                              props: {
                                ...selected.props,
                                cellWidth: cw,
                              },
                            });
                          }}
                        />
                      </Field>
                    </div>
                    <Field label="Cell offset X (pt)">
                      <NumInput
                        value={Number(selected.props?.cellOffsetX ?? 0)}
                        step={0.1}
                        onChange={(v) =>
                          updateSelectedProp("cellOffsetX", v)
                        }
                      />
                    </Field>
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={!!selected.props?.drawCells}
                        onChange={(e) =>
                          updateSelectedProp("drawCells", e.target.checked)
                        }
                      />
                      Draw cell outlines
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        if (sampleMode?.widgetId === selected.id) {
                          setSampleMode(null);
                        } else {
                          setSampleMode({
                            widgetId: selected.id,
                            firstPdf: null,
                          });
                        }
                      }}
                      className={
                        "w-full rounded border px-2 py-1.5 text-xs font-medium transition-colors " +
                        (sampleMode?.widgetId === selected.id
                          ? "border-blue-500 bg-blue-50 text-blue-700"
                          : "hover:bg-muted/60")
                      }
                    >
                      {sampleMode?.widgetId === selected.id
                        ? "✕ Cancel sampling (Esc)"
                        : "📐 Sample pitch from canvas"}
                    </button>
                    {(() => {
                      // Per-cell mode is implicit: presence of a
                      // cellWidths array of the right length means the
                      // user has dragged at least one boundary. Surface
                      // the mode + offer a reset back to equal pitch.
                      const cw = selected.props?.cellWidths;
                      const perCell =
                        Array.isArray(cw) && cw.length === cells;
                      if (!perCell) {
                        return (
                          <p className="text-[11px] text-muted-foreground italic">
                            Equal pitch — drag the blue vertical bars
                            between cells on the canvas to make widths
                            individually adjustable.
                          </p>
                        );
                      }
                      const widths = (cw as unknown[]).map(
                        (n) => Number(n) || 0,
                      );
                      const minW = Math.min(...widths);
                      const maxW = Math.max(...widths);
                      return (
                        <div className="space-y-1">
                          <p className="text-[11px] text-muted-foreground">
                            <em>Per-cell widths</em> active —{" "}
                            {widths.length} cells from {minW.toFixed(1)}pt
                            to {maxW.toFixed(1)}pt.
                          </p>
                          <button
                            type="button"
                            onClick={() => {
                              const rest = { ...selected.props };
                              delete (rest as Record<string, unknown>)
                                .cellWidths;
                              updateSelected({ props: rest });
                            }}
                            className="w-full rounded border px-2 py-1.5 text-xs hover:bg-muted/60"
                          >
                            ↺ Reset to equal pitch
                          </button>
                        </div>
                      );
                    })()}
                    <p className="text-[11px] text-muted-foreground">
                      To match a printed grid: drag the widget so its
                      left edge sits on the first printed cell, set{" "}
                      <span className="font-semibold">Cells</span> to
                      the number of printed boxes, then type the printed
                      cell pitch into{" "}
                      <span className="font-semibold">Cell width</span>{" "}
                      (W auto-adjusts). Use{" "}
                      <span className="font-semibold">Cell offset X</span>{" "}
                      to nudge characters left/right inside their cell
                      if the printed boxes aren't perfectly even.
                      {explicitPitch > 0 ? (
                        <> Currently <em>fixed-pitch</em> at {explicitPitch.toFixed(2)}pt.</>
                      ) : (
                        <> Currently <em>auto-fit</em> at ≈ {derivedPitch.toFixed(2)}pt per cell.</>
                      )}
                    </p>
                  </div>
                );
              })()}

              {/* ---- Box style: background, border, padding, opacity ---- */}
              {selected.type !== "checkbox" &&
                selected.type !== "radio" &&
                selected.type !== "qr" &&
                selected.type !== "barcode" &&
                selected.type !== "image" &&
                selected.type !== "signature" &&
                selected.type !== "signature-field" &&
                selected.type !== "rectangle" &&
                selected.type !== "line" && (
                  <div className="space-y-2 rounded-md border p-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Box style
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Background">
                        <input
                          type="color"
                          className="h-8 w-full rounded border"
                          value={(selected.props?.backgroundColor as string) || "#ffffff"}
                          onChange={(e) =>
                            updateSelectedProp("backgroundColor", e.target.value)
                          }
                        />
                      </Field>
                      <Field label="Border color">
                        <input
                          type="color"
                          className="h-8 w-full rounded border"
                          value={(selected.props?.borderColor as string) || "#111827"}
                          onChange={(e) =>
                            updateSelectedProp("borderColor", e.target.value)
                          }
                        />
                      </Field>
                      <Field label="Border width (pt)">
                        <NumInput
                          value={Number(selected.props?.borderWidth ?? 0)}
                          onChange={(v) => updateSelectedProp("borderWidth", v)}
                          step={0.25}
                        />
                      </Field>
                      <Field label="Padding (pt)">
                        <NumInput
                          value={Number(selected.props?.padding ?? 0)}
                          onChange={(v) => updateSelectedProp("padding", v)}
                          step={1}
                        />
                      </Field>
                    </div>
                    <Field label="Opacity (0 – 1)">
                      <div className="flex items-center gap-2">
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          className="flex-1"
                          value={Number(selected.props?.opacity ?? 1)}
                          onChange={(e) =>
                            updateSelectedProp("opacity", parseFloat(e.target.value))
                          }
                        />
                        <span className="w-8 text-right text-xs tabular-nums">
                          {Number(selected.props?.opacity ?? 1).toFixed(2)}
                        </span>
                      </div>
                    </Field>
                  </div>
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

              {(selected.type === "image" || selected.type === "signature") && (
                <>
                  <Field label="Image source (data URI, URL, or base64)">
                    <input
                      className="w-full border rounded px-2 py-1 font-mono text-xs"
                      value={(selected.props?.src as string) || ""}
                      onChange={(e) => updateSelectedProp("src", e.target.value)}
                      placeholder={
                        selected.type === "signature"
                          ? "data:image/png;base64,… (leave blank to bind via dataKey)"
                          : "https://… or data:image/…;base64,…"
                      }
                    />
                  </Field>
                  <Field label="Fit">
                    <select
                      className="w-full border rounded px-2 py-1 text-sm"
                      value={(selected.props?.fit as string) || "contain"}
                      onChange={(e) => updateSelectedProp("fit", e.target.value)}
                    >
                      <option value="contain">Contain (preserve ratio)</option>
                      <option value="stretch">Stretch (fill box)</option>
                    </select>
                  </Field>
                  <p className="rounded bg-muted/30 p-2 text-[10px] text-muted-foreground">
                    If <code>src</code> is empty, the resolved{" "}
                    <code>dataKey</code> is used instead — handy for signatures
                    drawn at fill time.
                  </p>
                  <Field label="Opacity (0 – 1)">
                    <div className="flex items-center gap-2">
                      <input
                        type="range" min={0} max={1} step={0.05} className="flex-1"
                        value={Number(selected.props?.opacity ?? 1)}
                        onChange={(e) => updateSelectedProp("opacity", parseFloat(e.target.value))}
                      />
                      <span className="w-8 text-right text-xs tabular-nums">
                        {Number(selected.props?.opacity ?? 1).toFixed(2)}
                      </span>
                    </div>
                  </Field>
                </>
              )}

              {selected.type === "rectangle" && (
                <div className="space-y-2 rounded-md border p-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Shape style
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Fill">
                      <input
                        type="color"
                        className="h-8 w-full rounded border"
                        value={(selected.props?.backgroundColor as string) || "#f3f4f6"}
                        onChange={(e) => updateSelectedProp("backgroundColor", e.target.value)}
                      />
                    </Field>
                    <Field label="Border color">
                      <input
                        type="color"
                        className="h-8 w-full rounded border"
                        value={(selected.props?.borderColor as string) || "#111827"}
                        onChange={(e) => updateSelectedProp("borderColor", e.target.value)}
                      />
                    </Field>
                    <Field label="Border width">
                      <NumInput
                        value={Number(selected.props?.borderWidth ?? 0.5)}
                        onChange={(v) => updateSelectedProp("borderWidth", v)}
                        step={0.25}
                      />
                    </Field>
                    <Field label="Corner radius">
                      <NumInput
                        value={Number(selected.props?.borderRadius ?? 0)}
                        onChange={(v) => updateSelectedProp("borderRadius", v)}
                        step={1}
                      />
                    </Field>
                  </div>
                  <Field label="Opacity (0 – 1)">
                    <div className="flex items-center gap-2">
                      <input
                        type="range" min={0} max={1} step={0.05} className="flex-1"
                        value={Number(selected.props?.opacity ?? 1)}
                        onChange={(e) => updateSelectedProp("opacity", parseFloat(e.target.value))}
                      />
                      <span className="w-8 text-right text-xs tabular-nums">
                        {Number(selected.props?.opacity ?? 1).toFixed(2)}
                      </span>
                    </div>
                  </Field>
                </div>
              )}

              {selected.type === "line" && (
                <div className="space-y-2 rounded-md border p-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Line style
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Orientation">
                      <select
                        className="w-full rounded border px-2 py-1 text-xs"
                        value={(selected.props?.orientation as string) || "horizontal"}
                        onChange={(e) => updateSelectedProp("orientation", e.target.value)}
                      >
                        <option value="horizontal">Horizontal</option>
                        <option value="vertical">Vertical</option>
                      </select>
                    </Field>
                    <Field label="Color">
                      <input
                        type="color"
                        className="h-8 w-full rounded border"
                        value={(selected.props?.color as string) || "#111827"}
                        onChange={(e) => updateSelectedProp("color", e.target.value)}
                      />
                    </Field>
                  </div>
                  <Field label="Thickness (pt)">
                    <NumInput
                      value={Number(selected.props?.borderWidth ?? 0.5)}
                      onChange={(v) => updateSelectedProp("borderWidth", v)}
                      step={0.25}
                    />
                  </Field>
                  <Field label="Opacity (0 – 1)">
                    <div className="flex items-center gap-2">
                      <input
                        type="range" min={0} max={1} step={0.05} className="flex-1"
                        value={Number(selected.props?.opacity ?? 1)}
                        onChange={(e) => updateSelectedProp("opacity", parseFloat(e.target.value))}
                      />
                      <span className="w-8 text-right text-xs tabular-nums">
                        {Number(selected.props?.opacity ?? 1).toFixed(2)}
                      </span>
                    </div>
                  </Field>
                </div>
              )}

              {selected.type === "pageNumber" && (
                <Field label="Format">
                  <input
                    className="w-full border rounded px-2 py-1 font-mono text-xs"
                    value={(selected.props?.format as string) || "{page} / {pages}"}
                    onChange={(e) => updateSelectedProp("format", e.target.value)}
                    placeholder="Page {page} of {pages}"
                  />
                </Field>
              )}

              {selected.type === "watermark" && (
                <>
                  <Field label="Text">
                    <input
                      className="w-full border rounded px-2 py-1 text-sm"
                      value={(selected.props?.text as string) || "DRAFT"}
                      onChange={(e) => updateSelectedProp("text", e.target.value)}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Angle (°)">
                      <NumInput
                        value={Number(selected.props?.angle ?? -30)}
                        onChange={(v) => updateSelectedProp("angle", v)}
                      />
                    </Field>
                    <Field label="Opacity (0 – 1)">
                      <div className="flex items-center gap-2">
                        <input
                          type="range" min={0} max={1} step={0.05} className="flex-1"
                          value={Number(selected.props?.opacity ?? 0.15)}
                          onChange={(e) =>
                            updateSelectedProp("opacity", parseFloat(e.target.value))
                          }
                        />
                        <span className="w-8 text-right text-xs tabular-nums">
                          {Number(selected.props?.opacity ?? 0.15).toFixed(2)}
                        </span>
                      </div>
                    </Field>
                  </div>
                </>
              )}

              {selected.type === "repeat" && (
                <>
                  <Field label="Row template">
                    <input
                      className="w-full border rounded px-2 py-1 font-mono text-xs"
                      value={(selected.props?.rowTemplate as string) || "{.}"}
                      onChange={(e) => updateSelectedProp("rowTemplate", e.target.value)}
                      placeholder="{name} — {amount}"
                    />
                  </Field>
                  <Field label="Row height (pt)">
                    <NumInput
                      value={Number(selected.props?.rowHeight ?? 16)}
                      onChange={(v) => updateSelectedProp("rowHeight", v)}
                    />
                  </Field>
                  <p className="rounded bg-muted/30 p-2 text-[10px] text-muted-foreground">
                    Bind <code>dataKey</code> to an array. Each <code>{"{key}"}</code>{" "}
                    in the template is replaced per row.
                  </p>
                </>
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

              {/* AcroForm interactive field panel — shown for form-capable widget types */}
              {isAcroFieldType(selected.type) && (
                <AcroFormPanel
                  type={selected.type}
                  props={selected.props ?? {}}
                  onChange={(key, value) => updateSelectedProp(key, value)}
                  allWidgets={widgets
                    .filter(
                      (w) =>
                        w.id !== selected.id &&
                        ["text", "number", "currency"].includes(w.type)
                    )
                    .map((w) => ({ id: w.id, dataKey: w.dataKey, type: w.type }))}
                />
              )}

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
            )
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
          {/* View-mode toggle. Continuous = stack-all (legacy default,
              best for scrolling a multi-page doc). Paginated = one page
              at a time with prev/next controls — narrower viewport,
              easier review of a single page. */}
          <div className="flex items-center gap-0.5 rounded border bg-background">
            <button
              onClick={() => setViewMode("continuous")}
              title="Show all pages (continuous scroll)"
              className={
                "px-2 py-0.5 text-[11px] " +
                (viewMode === "continuous"
                  ? "bg-primary/10 text-primary"
                  : "hover:bg-muted")
              }
            >
              All
            </button>
            <button
              onClick={() => setViewMode("paginated")}
              title="Show one page at a time"
              className={
                "border-l px-2 py-0.5 text-[11px] " +
                (viewMode === "paginated"
                  ? "bg-primary/10 text-primary"
                  : "hover:bg-muted")
              }
            >
              Page
            </button>
          </div>
          {/* Page navigator — only meaningful in paginated mode. We
              still render it disabled in continuous mode would just be
              noise, so hide it entirely there. PageUp/PageDown shortcuts
              cover keyboard nav. */}
          {viewMode === "paginated" && numPages > 0 && (
            <div className="flex items-center gap-0.5 rounded border bg-background">
              <button
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
                title="Previous page (PageUp)"
                className="px-1.5 py-0.5 hover:bg-muted disabled:opacity-40"
              >
                <ChevronLeft className="h-3 w-3" />
              </button>
              <input
                type="number"
                min={1}
                max={numPages}
                value={currentPage}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  if (!Number.isFinite(n)) return;
                  setCurrentPage(Math.max(1, Math.min(numPages, n)));
                }}
                className="w-10 bg-transparent px-1 py-0.5 text-center text-[11px] tabular-nums outline-none"
              />
              <span className="pr-1 text-[11px] tabular-nums text-muted-foreground">
                / {numPages}
              </span>
              <button
                onClick={() =>
                  setCurrentPage((p) => Math.min(numPages, p + 1))
                }
                disabled={currentPage >= numPages}
                title="Next page (PageDown)"
                className="border-l px-1.5 py-0.5 hover:bg-muted disabled:opacity-40"
              >
                <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          )}
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
              <p className="text-xs text-muted-foreground">
                Edit the values below and click Generate. The latest
                widget changes are saved automatically before rendering,
                so the PDF reflects what you see on the canvas.
              </p>
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

              {/* Output options — what to do with the rendered PDF.
                  Save-to-Drive defaults OFF so a quick test render stays
                  ephemeral. When OFF the response carries only a 10-min
                  presigned download URL; no Drive row, no clutter.
                  When ON the filename + folder inputs become live so the
                  user can override the template's defaults per render. */}
              <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Output
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={genSaveToDrive}
                    onChange={(e) => setGenSaveToDrive(e.target.checked)}
                  />
                  Save to Drive
                  <span className="text-[11px] text-muted-foreground">
                    (off = ephemeral 10-min download URL, no file row)
                  </span>
                </label>
                {genSaveToDrive && (
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <label className="space-y-1 text-xs">
                      <span className="text-muted-foreground">
                        Filename (overrides template)
                      </span>
                      <input
                        type="text"
                        value={genOutputName}
                        onChange={(e) => setGenOutputName(e.target.value)}
                        placeholder="Invoice-{{invoiceNumber}}.pdf"
                        className="w-full rounded border px-2 py-1 text-xs font-mono"
                      />
                    </label>
                    <label className="space-y-1 text-xs">
                      <span className="text-muted-foreground">
                        Folder path (logical)
                      </span>
                      <input
                        type="text"
                        value={genOutputPath}
                        onChange={(e) => setGenOutputPath(e.target.value)}
                        placeholder="clients/{{customer}}/2025"
                        className="w-full rounded border px-2 py-1 text-xs font-mono"
                      />
                    </label>
                  </div>
                )}
                <label className="flex items-center gap-2 text-sm pt-1">
                  <input
                    type="checkbox"
                    checked={genFlatten}
                    onChange={(e) => setGenFlatten(e.target.checked)}
                  />
                  Flatten form fields (AcroForm only)
                  <span className="text-[11px] text-muted-foreground">
                    bakes values into static content
                  </span>
                </label>
              </div>

              {/* Security — collapsed by default. When opened, the user
                  can encrypt this single render with a password +
                  permissions, overriding the template's security policy.
                  Sending an empty block is intentional: it lets users
                  render unprotected even when the template normally
                  encrypts. We DON'T expose that today (both fields blank
                  → omit the block entirely so template policy applies). */}
              <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                <button
                  type="button"
                  onClick={() => setGenSecurityOpen((v) => !v)}
                  className="flex w-full items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  <span>Security {(genUserPwd || genOwnerPwd) && "• ON"}</span>
                  <span>{genSecurityOpen ? "▴" : "▾"}</span>
                </button>
                {genSecurityOpen && (
                  <div className="space-y-2">
                    <p className="text-[11px] text-muted-foreground">
                      Set a password to encrypt this render. Leave both
                      blank to use the template&apos;s default security
                      policy.
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1 text-xs">
                        <span className="text-muted-foreground">
                          User password (open)
                        </span>
                        <input
                          type="password"
                          value={genUserPwd}
                          onChange={(e) => setGenUserPwd(e.target.value)}
                          autoComplete="new-password"
                          className="w-full rounded border px-2 py-1 text-xs"
                        />
                      </label>
                      <label className="space-y-1 text-xs">
                        <span className="text-muted-foreground">
                          Owner password (permissions)
                        </span>
                        <input
                          type="password"
                          value={genOwnerPwd}
                          onChange={(e) => setGenOwnerPwd(e.target.value)}
                          autoComplete="new-password"
                          className="w-full rounded border px-2 py-1 text-xs"
                        />
                      </label>
                    </div>
                    <label className="space-y-1 text-xs block">
                      <span className="text-muted-foreground">Encryption</span>
                      <select
                        value={genEncryption}
                        onChange={(e) =>
                          setGenEncryption(
                            e.target.value as "AES-128" | "AES-256",
                          )
                        }
                        className="w-full rounded border px-2 py-1 text-xs"
                      >
                        <option value="AES-256">AES-256 (recommended)</option>
                        <option value="AES-128">AES-128</option>
                      </select>
                    </label>
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground">
                        Permissions
                      </div>
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={genPermAll}
                          onChange={(e) => setGenPermAll(e.target.checked)}
                        />
                        Grant all (overrides individual flags)
                      </label>
                      {!genPermAll && (
                        <div className="grid grid-cols-2 gap-1 pl-5">
                          <label className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={genPermPrint}
                              onChange={(e) =>
                                setGenPermPrint(e.target.checked)
                              }
                            />
                            Print
                          </label>
                          <label className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={genPermCopy}
                              onChange={(e) =>
                                setGenPermCopy(e.target.checked)
                              }
                            />
                            Copy text
                          </label>
                          <label className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={genPermModify}
                              onChange={(e) =>
                                setGenPermModify(e.target.checked)
                              }
                            />
                            Modify
                          </label>
                          <label className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={genPermAnnotate}
                              onChange={(e) =>
                                setGenPermAnnotate(e.target.checked)
                              }
                            />
                            Annotate
                          </label>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

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
                onClick={runGenerateFlow}
                disabled={genBusy}
                className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {genBusy
                  ? "Generating…"
                  : genSaveToDrive
                  ? "Generate & save to Drive"
                  : "Generate (download only)"}
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

      <CollabDrawer
        open={collabOpen}
        onOpenChange={setCollabOpen}
        templateId={tpl.id}
        templateName={tpl.name}
      />

      <AIDetectFieldsModal
        open={aiDetectOpen}
        onOpenChange={setAiDetectOpen}
        templateId={tpl.id}
        existingDataKeys={widgets.map((w) => w.dataKey).filter(Boolean)}
        onAccept={applyDetectedProposals}
      />

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
          { keys: "PageUp / PageDown", label: "Previous / next page (paginated mode)", group: "View" },
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
          { keys: `${M}G`, label: "Group selection", group: "Arrange" },
          { keys: `${M}⇧G`, label: "Ungroup selection", group: "Arrange" },
        ]}
      />

      {/* Edit sample JSON */}
      <Dialog open={editSampleOpen} onOpenChange={setEditSampleOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Sample data</DialogTitle>
            <DialogDescription>
              Used by the schema panel and live preview. The keys define the
              shape your Generate call must send.
            </DialogDescription>
          </DialogHeader>

          <textarea
            className="min-h-[260px] w-full rounded-md border bg-background p-3 font-mono text-xs"
            value={sampleJSON}
            onChange={(e) => setSampleJSON(e.target.value)}
          />

          {/* Import toolbar — replace widgets+layout+sample from a JSON
              file produced by the matching Export → Full config button.
              Hidden when readOnly (viewers shouldn't be able to mutate). */}
          {!readOnly && (
            <div className="rounded-md border bg-muted/30 p-3">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Import
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => importFullConfig()}
              >
                <Upload className="h-3.5 w-3.5" />
                Import full config (JSON)
              </Button>
              <p className="mt-2 text-[10px] text-muted-foreground">
                Replaces the current widgets, page layout, and sample data
                with those from a previously-exported template config file.
                AcroForm field bindings on the underlying PDF are preserved.
                Click <strong>Save</strong> after importing to persist.
              </p>
            </div>
          )}

          {/* Export toolbar */}
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Export
            </div>
            <div className="flex flex-wrap gap-2">
              {/* ---- Full template config (widgets + layout + sample) ---- */}
              <Button
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() =>
                  downloadFullExport(
                    tpl,
                    widgets,
                    currentConfig,
                    sampleJSON
                  )
                }
              >
                <PackageOpen className="h-3.5 w-3.5" />
                Full config (widgets + layout + data)
              </Button>

              {/* ---- Sample-data-only exports ---- */}
              <div className="w-full border-t pt-2 text-[10px] font-medium text-muted-foreground">
                Sample data only
              </div>

              {/* Download JSON */}
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => {
                  try {
                    const parsed = JSON.parse(sampleJSON || "{}");
                    downloadJSON(
                      JSON.stringify(parsed, null, 2),
                      `${tpl.name || "schema"}.json`
                    );
                  } catch {
                    toast.show("error", "Sample data is not valid JSON");
                  }
                }}
              >
                <FileJson className="h-3.5 w-3.5" />
                Download JSON
              </Button>

              {/* Download TypeScript interface */}
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => {
                  try {
                    const parsed = JSON.parse(sampleJSON || "{}");
                    downloadTypeScript(parsed, `${tpl.name || "schema"}.ts`);
                  } catch {
                    toast.show("error", "Sample data is not valid JSON");
                  }
                }}
              >
                <Code2 className="h-3.5 w-3.5" />
                Download .ts
              </Button>

              {/* Download skeleton payload */}
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => {
                  try {
                    const parsed = JSON.parse(sampleJSON || "{}");
                    downloadSkeleton(parsed, `${tpl.name || "payload"}-skeleton.json`);
                  } catch {
                    toast.show("error", "Sample data is not valid JSON");
                  }
                }}
              >
                <Download className="h-3.5 w-3.5" />
                Skeleton payload
              </Button>

              {/* Copy JSON to clipboard */}
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs"
                onClick={async () => {
                  const ok = await copyToClipboard(sampleJSON);
                  if (ok) {
                    setCopiedSchema(true);
                    setTimeout(() => setCopiedSchema(false), 1800);
                  }
                }}
              >
                {copiedSchema ? (
                  <Check className="h-3.5 w-3.5 text-emerald-500" />
                ) : (
                  <Clipboard className="h-3.5 w-3.5" />
                )}
                {copiedSchema ? "Copied!" : "Copy JSON"}
              </Button>

              {/* Copy TypeScript interface to clipboard */}
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs"
                onClick={async () => {
                  try {
                    const parsed = JSON.parse(sampleJSON || "{}");
                    const ts = toTypeScript(parsed);
                    await copyToClipboard(ts);
                    toast.show("success", "TypeScript interface copied to clipboard");
                  } catch {
                    toast.show("error", "Sample data is not valid JSON");
                  }
                }}
              >
                <Clipboard className="h-3.5 w-3.5" />
                Copy as TypeScript
              </Button>
            </div>
            <p className="mt-2 text-[10px] text-muted-foreground">
              <strong>Full config</strong> — every widget (type, position,
              size, props), page layout settings, and sample data in one file.
              Use it as a backup or to reproduce this template elsewhere.{" "}
              <strong>Skeleton payload</strong> — same shape as the sample but
              all values zeroed (<code>""</code>, <code>0</code>,{" "}
              <code>false</code>) — a starter for API integration tests.
            </p>
          </div>

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
            groupSelection,
            ungroupSelection,
            align: alignSelection,
          })}
        />
      )}
      <GeneratedPreviewDialog
        open={!!genResult}
        onOpenChange={(o) => !o && setGenResult(null)}
        downloadUrl={genResult?.downloadUrl ?? null}
        outputFileId={genResult?.outputFileId}
        fileName={genResult?.fileName ?? `${tplName}.pdf`}
      />
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

function NumInput({
  value,
  onChange,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <input
      type="number"
      step={step ?? 0.1}
      className="w-full rounded border px-2 py-1 text-sm"
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

// Sub-tab button for the unified Fields panel (Schema / Layers / Tab order).
// Three of these sit side-by-side under the panel header. Active tab shows
// a bottom underline + tinted background; inactive tabs hover-darken.
function FieldsTabBtn({
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
      aria-pressed={active}
      className={
        "relative flex flex-1 items-center justify-center gap-1 px-2 py-2 transition-colors " +
        (active
          ? "bg-muted/50 font-medium text-foreground border-b-2 border-primary"
          : "text-muted-foreground hover:bg-muted/40 hover:text-foreground border-b-2 border-transparent")
      }
    >
      <Icon className="h-3.5 w-3.5" />
      <span>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="ml-0.5 rounded-full bg-muted px-1 text-[9px] tabular-nums text-muted-foreground">
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
  const textBase = {
    fontSize: 12,
    fontFamily: "Helvetica",
    bold: false,
    italic: false,
    underline: false,
    color: "#111827",
    align: "L",
    lineHeight: 1.15,
    opacity: 1,
  };
  switch (type) {
    case "checkbox":
      return { color: "#111827" };
    case "radio":
      return { color: "#111827", acroGroupName: "", acroExportValue: "" };
    case "dropdown":
      return { ...textBase, acroOptions: [] };
    case "signature-field":
      return { color: "#111827", acroLockAfterSign: false };
    case "button":
      return {
        acroButtonLabel: "Button",
        acroButtonAction: "none",
        backgroundColor: "#e5e7eb",
        borderColor: "#9ca3af",
        borderWidth: 0.5,
        color: "#111827",
        fontSize: 11,
        fontFamily: "Helvetica",
        align: "C",
      };
    case "multiline":
      return { ...textBase, fontSize: 11 };
    case "comb":
      // Char-grid: 10 cells, centred per cell, monospace by default so
      // the seeded look matches printed PAN-style boxes out of the gate.
      return {
        ...textBase,
        fontFamily: "Courier",
        align: "C",
        cells: 10,
        drawCells: false,
      };
    case "qr":
      return {};
    case "barcode":
      return { barcodeKind: "code128" };
    case "image":
    case "signature":
      return { fit: "contain", opacity: 1 };
    case "rectangle":
      return { backgroundColor: "#f3f4f6", borderColor: "#111827", borderWidth: 0.5, borderRadius: 0, opacity: 1 };
    case "line":
      return { color: "#111827", borderWidth: 0.5, orientation: "horizontal", opacity: 1 };
    case "pageNumber":
      return { ...textBase, format: "{page} / {pages}", align: "C", fontSize: 10, color: "#6b7280" };
    case "watermark":
      return { text: "DRAFT", angle: -30, opacity: 0.15, color: "#111827", fontSize: 18 };
    case "repeat":
      return { ...textBase, rowTemplate: "{name} — {amount}", rowHeight: 16, fontSize: 11 };
    default:
      return { ...textBase };
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

// Best human-readable name for a widget. Mirrors how the layers panel
// labels rows: explicit `_label` wins, then dataKey, then acro field
// name, then the widget type, then a generic fallback.
function widgetLabel(w: Widget): string {
  const lbl = (w.props?._label as string | undefined)?.trim();
  if (lbl) return lbl;
  if (w.dataKey) return w.dataKey;
  if (w.acroFieldName) return w.acroFieldName;
  if (w.type) return w.type;
  return "Untitled";
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
  groupSelection: () => void;
  ungroupSelection: () => void;
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
    { kind: "item", label: "Group",   hint: `${M}G`,  disabled: !multi, run: p.groupSelection },
    { kind: "item", label: "Ungroup", hint: `${M}⇧G`,                   run: p.ungroupSelection },
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

// Properties panel body for an acro-bound widget — i.e. a synthetic
// widget that represents a /FT field already on the source PDF. Renders
// the same rich mapping editor the standalone AcroForm Designer used
// (transform pipeline, validation rules, conditional fill) so users
// don't lose any capability when they edit AcroForm templates inside
// the Static Designer surface. All edits flow through `patchAcroMapping`,
// which keeps `props._acroMapping` in sync — and `save()` later splits
// that back out into `config.mappings` (preserving the AcroForm API
// contract — no schema migration).
function AcroBoundProps({
  selected,
  widgets,
  tpl,
  sample,
  sampleKeys,
  patchAcroMapping,
  updateSelected,
}: {
  selected: Widget;
  widgets: Widget[];
  tpl: Template;
  sample: Record<string, any>;
  sampleKeys: Set<string>;
  patchAcroMapping: (patch: Partial<AcroMapping>) => void;
  updateSelected: (patch: Partial<Widget>) => void;
}) {
  const mapping: AcroMapping =
    (selected.props?._acroMapping as AcroMapping) ||
    ({ dataKey: selected.dataKey } as AcroMapping);

  // Reconstruct an AcroFormField shape from the tunneled props for
  // ValidationRulesEditor (which uses field.maxLen / field.type / etc.
  // to seed sensible defaults like type=boolean for checkboxes).
  const acroField: AcroFormFieldFull = {
    name: selected.acroFieldName!,
    type: selected.acroFieldType || "Tx",
    page: selected.page,
    rect: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
    options: selected.props?._acroOptions as string[] | undefined,
    maxLen: selected.props?._acroMaxLen as number | undefined,
    tooltip: selected.props?._acroTooltip as string | undefined,
    readOnly: !!selected.props?._acroReadOnly,
    multiline: !!selected.props?._acroMultiline,
    required: !!mapping.required,
  };

  // Auto-complete suggestions for transform/conditional editors. Pulls
  // from every other widget's dataKey + every existing acro mapping.
  const allFieldDataKeys: string[] = (() => {
    const set = new Set<string>();
    for (const w of widgets) {
      if (w.id !== selected.id && w.dataKey) set.add(w.dataKey);
    }
    const cfgMappings = (tpl.config?.mappings || {}) as Record<
      string,
      AcroMapping
    >;
    for (const m of Object.values(cfgMappings)) {
      if (m?.dataKey) set.add(m.dataKey);
    }
    for (const k of sampleKeys) set.add(k);
    return Array.from(set).sort();
  })();

  return (
    <div className="p-4 space-y-3 text-sm">
      {/* Field metadata header — read-only since these come from the PDF */}
      <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="font-mono font-semibold text-amber-900">
            ▦ {selected.acroFieldName}
          </span>
          <span className="rounded bg-amber-200 px-1.5 py-0.5 font-mono text-[10px] text-amber-900">
            {selected.acroFieldType || "Tx"}
          </span>
        </div>
        <p className="mt-1 text-[11px] text-amber-800">
          AcroForm field from the source PDF. Geometry is locked; binding
          and behaviour are editable below.
        </p>
        {acroField.tooltip && (
          <p className="mt-1 text-[11px] italic text-amber-700">
            Tooltip: {acroField.tooltip}
          </p>
        )}
      </div>

      <Field label="Data key">
        <input
          className="w-full border rounded px-2 py-1 font-mono text-sm"
          value={mapping.dataKey || ""}
          onChange={(e) => patchAcroMapping({ dataKey: e.target.value })}
        />
      </Field>

      <Field label="Default value">
        <input
          className="w-full border rounded px-2 py-1 text-sm"
          value={mapping.default || ""}
          onChange={(e) =>
            patchAcroMapping({ default: e.target.value || undefined })
          }
          placeholder="(none)"
        />
      </Field>

      <Field label="Section">
        <input
          className="w-full border rounded px-2 py-1 text-sm"
          value={mapping.section || ""}
          onChange={(e) =>
            patchAcroMapping({ section: e.target.value || undefined })
          }
          placeholder="(ungrouped)"
        />
      </Field>

      <div className="flex items-center gap-4 text-xs">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={!!mapping.required}
            onChange={(e) =>
              patchAcroMapping({ required: e.target.checked || undefined })
            }
          />
          Required
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={!!mapping.flatten}
            onChange={(e) =>
              patchAcroMapping({ flatten: e.target.checked || undefined })
            }
          />
          Flatten
        </label>
      </div>

      {/* Transform pipeline */}
      <div className="space-y-1.5 rounded-md border p-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Transform
        </div>
        <TransformEditor
          value={mapping.transform as Transform | Transform[] | string | undefined}
          allFieldDataKeys={allFieldDataKeys}
          onChange={(t) => patchAcroMapping({ transform: t })}
        />
      </div>

      {/* Validation rule */}
      <div className="space-y-1.5 rounded-md border p-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Validation
        </div>
        <ValidationRulesEditor
          value={mapping.validation as ValidationRule | undefined}
          field={acroField}
          onChange={(rule) => patchAcroMapping({ validation: rule })}
        />
      </div>

      {/* Conditional fill */}
      <ConditionalEditor
        value={mapping.fillWhen}
        allFieldDataKeys={allFieldDataKeys}
        sampleData={sample}
        onChange={(expr) => patchAcroMapping({ fillWhen: expr })}
      />

      {/* Lock toggle — the field is locked by default (geometry pinned to
          PDF /Annots), but we expose unlock-for-data-bind via the existing
          locked flag so power users can still nudge a tooltip etc. */}
      <div className="flex items-center justify-between rounded-md border p-2 text-xs">
        <span className="text-muted-foreground">Geometry locked</span>
        <button
          type="button"
          className="rounded border px-2 py-0.5 text-xs hover:bg-muted/60"
          onClick={() => updateSelected({ locked: !selected.locked })}
        >
          {selected.locked ? "Unlock" : "Lock"}
        </button>
      </div>
    </div>
  );
}
