"use client";

// AcroFormDesigner — Tier A visual mapping experience for /FT fields.
// Replaces the iframe + flat list with:
//   • react-pdf preview + click-to-map field overlays (left)
//   • sectioned, bulk-editable, live-preview mapping rows (right)
//   • auto-map dialog, schema export, field inspector

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// useDebouncedValue — trailing-edge debounce. We only care about the
// final value after the user stops typing, so leading-edge behavior
// isn't needed. 250ms is snappy enough to feel instant but coalesces
// rapid keystrokes into one validation pass.
function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileSpreadsheet,
  Grid3x3,
  Download,
  Layers,
  MapPin,
  MoreHorizontal,
  MousePointer2,
  Upload,
  PenSquare,
  PencilRuler,
  PlayCircle,
  Save,
  ScanSearch,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  Undo2,
  Wand2,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { runGenerate } from "@/lib/generate";
import { GeneratedPreviewDialog } from "@/components/generated-preview-dialog";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";
import { useHistoryStack } from "@/hooks/use-history-stack";
import { useAcroformFixtures } from "@/hooks/use-acroform-fixtures";
import { cn } from "@/lib/utils";
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
import { FixturesPicker } from "./fixtures-picker";
import { CsvImportDialog } from "./csv-import-dialog";
import { useConfigImportExport } from "./config-import-export";
import { AlignToolbar } from "./align-toolbar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  alignRects,
  distributeRects,
  matchSize,
  type AlignAxis,
  type DistributeAxis,
  type SizeAxis,
} from "./align-tools";
import { DesignQAPanel, runAcroQA } from "./design-qa-panel";
import { InlineRenameTitle } from "@/components/designer/inline-rename-title";
import { ApiGuideSheet } from "@/components/api-guide-trigger";
import { DocAITools } from "@/components/doc-ai-tools";
import { validateAll } from "@/lib/acroform-validation";
import {
  applyStructurePatches,
  type StructurePatch,
} from "@/lib/acroform-api";
import type {
  AcroFormField,
  AcroMapping,
  CrossValidation,
  FieldRect,
  MappingMap,
} from "./types";

// Stable empty array used when a page has no fields. Sharing the same
// reference across renders prevents the overlay's props from looking
// changed, which would otherwise re-render every empty page every time
// any field mutates.
const EMPTY_FIELDS: AcroFormField[] = [];

type Tpl = {
  id: string;
  name: string;
  mode: string;
  version: number;
  fields: AcroFormField[];
  config: { mappings?: MappingMap; crossValidations?: CrossValidation[] };
};

type Props = {
  tpl: Tpl;
  previewUrl: string;
  // When true the designer renders in view-only mode — Save and
  // Save-structure buttons are disabled and the top banner makes the
  // restriction explicit. Viewers can still click around (inspect
  // mappings, try Generate) but nothing they change here persists.
  readOnly?: boolean;
  // Source PDF file ID. Threaded from the templates page so the
  // designer's header can offer Extract text + Summarize / Ask
  // against the underlying PDF — handy when mapping AcroForm fields
  // to data keys whose names live inside the PDF's instructions.
  fileId?: string;
};

export function AcroFormDesigner({
  tpl,
  previewUrl,
  readOnly = false,
  fileId,
}: Props) {
  const router = useRouter();
  const toast = useToast();
  const [mappings, setMappings] = useState<MappingMap>(
    tpl.config?.mappings || defaultMappings(tpl.fields)
  );
  const [crossValidations, setCrossValidations] = useState<CrossValidation[]>(
    tpl.config?.crossValidations || []
  );
  const [qaOpen, setQaOpen] = useState(false);
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set());
  // Fixtures replace the old single-blob sampleData state. `fx.data` is
  // the currently-active fixture's payload; `fx.setData` writes back to
  // it, with legacy migration handled inside the hook.
  const fx = useAcroformFixtures(tpl.id);
  const sampleData = fx.data;
  const setSampleData = fx.setData;
  const [csvOpen, setCsvOpen] = useState(false);
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
  // Server-side validation errors from a 422 response. Kept separately
  // from genErr so we can render a structured per-field list in the
  // Generate dialog (and let the user click a field to jump to it).
  const [genFieldErrors, setGenFieldErrors] = useState<
    Array<{ field: string; dataKey: string; message: string }> | null
  >(null);
  const [genProgress, setGenProgress] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  // Search + filter state for the mapping list. At high field counts the
  // flat list is unusable; search + a few status filters let the user
  // zero in on what they need. Filters are intentionally cheap to keep
  // typing responsive.
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<"all" | "unmapped" | "errors">("all");
  const debouncedSearch = useDebouncedValue(searchQuery, 150);

  // Page-aware mapping panel controls. At 500+ pages with hundreds of
  // fields the flat (or even section-grouped) list is unusable. Two
  // controls fix this:
  //   • groupBy = "page" turns each PDF page into its own collapsible
  //     section, mirroring how users actually think about long forms.
  //   • onlyCurrentPage narrows the panel to whatever page the PDF
  //     viewer is currently looking at — so scrolling the PDF
  //     scrolls the mapping list with it.
  // Defaults: when there are >1 pages the page-grouped view is the
  // friendlier default; otherwise we keep the legacy section view.
  const [groupBy, setGroupBy] = useState<"section" | "page" | "none">("section");
  const [onlyCurrentPage, setOnlyCurrentPage] = useState<boolean>(false);
  // Currently-visible top page in the PDF preview, fed back from
  // PdfPreview's IntersectionObserver. Drives the "current page only"
  // filter and the contextual page-jump button on the mapping panel.
  const [currentPage, setCurrentPage] = useState<number>(1);
  // PDF download progress (0..1, or null while no progress events seen
  // yet / once the load is complete). Surfaced as a thin progress bar
  // above the mapping list so the user has feedback during the long
  // initial fetch of a 500-page PDF.
  const [pdfProgress, setPdfProgress] = useState<number | null>(null);

  // Auto-pick a sensible default group mode once we know how many pages
  // the field set spans. > 5 pages → "page" is more navigable than the
  // section view, especially since most templates haven't bothered to
  // assign sections. Runs once on mount; the user can flip it any time.
  const initialGroupRef = useRef(false);
  useEffect(() => {
    if (initialGroupRef.current) return;
    if (tpl.fields.length === 0) return;
    initialGroupRef.current = true;
    let maxPage = 0;
    for (const f of tpl.fields) {
      if (f.page > maxPage) maxPage = f.page;
    }
    if (maxPage > 5) setGroupBy("page");
  }, [tpl.fields]);

  // Tier C — structure edit mode.
  // Fields state can drift from tpl.fields when patches are queued locally:
  // the overlay shows `localFields` while a Save roundtrips; the server then
  // returns refreshed rich fields which we commit back.
  const [localFields, setLocalFields] = useState<AcroFormField[]>(tpl.fields);
  const [localVersion, setLocalVersion] = useState<number>(tpl.version);
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string>(previewUrl);
  // "off" = Bind (data mapping), "select" = Edit (move/resize), "draw" = add.
  // Default is Bind — it's the primary workflow and doesn't show drag
  // handles so the PDF preview stays clean while mapping fields.
  const [editMode, setEditMode] = useState<"off" | "select" | "draw">("off");
  // When non-null, the next rectangle drawn in "draw" mode is treated
  // as a placement for this existing (rect-less) field rather than
  // creating a brand-new one. Cleared once the rect is committed or
  // the user cancels.
  const [placingForField, setPlacingForField] = useState<string | null>(null);
  const [pendingPatches, setPendingPatches] = useState<StructurePatch[]>([]);
  const [draftRectsByField, setDraftRectsByField] = useState<Record<string, FieldRect>>({});
  const [structureSaving, setStructureSaving] = useState(false);
  const [structureErr, setStructureErr] = useState<string | null>(null);
  // Snap-to-grid: when on, rect coordinates round to GRID_SIZE-point
  // multiples on drag-commit, arrow-nudge, and draw. Helps align fields
  // to a consistent baseline when the original PDF's field placement is
  // slightly inconsistent.
  const [snapToGrid, setSnapToGrid] = useState<boolean>(false);
  // Local name overlay — the parent prop (`tpl.name`) is the authoritative
  // value at mount, but rename edits live here so the header can update
  // immediately without a full page refetch.
  const [tplName, setTplName] = useState<string>(tpl.name);
  // Post-generate preview. Replaces the old `window.open(downloadUrl)`
  // auto-download — users now review the filled PDF in a dialog and
  // pick Download / Share / Open-in-Drive explicitly.
  const [genResult, setGenResult] = useState<{
    downloadUrl: string;
    outputFileId?: string;
    fileName: string;
  } | null>(null);

  // Sample data persistence is handled inside useAcroformFixtures.

  // Dirty flag — true when there's any unsaved config change OR pending
  // structure patches. Cheap-ish to recompute; we JSON.stringify the
  // config side because `mappings` / `crossValidations` can mutate by
  // reference from many code paths and shallow equality would miss deep
  // edits. JSON on a mapping object of 5k fields is ~1ms, well under
  // the debounced re-render cadence.
  const savedSnapshotRef = useRef(
    JSON.stringify({
      mappings: tpl.config?.mappings ?? {},
      crossValidations: tpl.config?.crossValidations ?? [],
    })
  );
  const dirty = useMemo(() => {
    if (pendingPatches.length > 0) return true;
    const current = JSON.stringify({ mappings, crossValidations });
    return current !== savedSnapshotRef.current;
  }, [mappings, crossValidations, pendingPatches.length]);

  const { confirmNavigate } = useUnsavedChangesGuard(dirty);

  // Undo/redo over the config tuple. The hook takes a debounced
  // snapshot of mappings+crossValidations so a flurry of keystrokes
  // undoes in one step. Discrete operations (auto-map, bulk rename)
  // call `history.commit()` to force an immediate snapshot boundary.
  const historyValue = useMemo(
    () => ({ mappings, crossValidations }),
    [mappings, crossValidations]
  );
  const history = useHistoryStack(historyValue, {
    debounceMs: 500,
    maxDepth: 50,
    equals: (a, b) =>
      a.mappings === b.mappings && a.crossValidations === b.crossValidations,
    onRestore: (snap) => {
      setMappings(snap.mappings);
      setCrossValidations(snap.crossValidations);
    },
  });

  // Config JSON import/export. `dialog` is rendered once at the bottom of
  // the component; `download` and `openFilePicker` are wired into the
  // header's Tools dropdown.
  const configIO = useConfigImportExport({
    templateName: tpl.name,
    mappings,
    crossValidations,
    onImport: ({ mappings: m, crossValidations: cv }) => {
      // Commit an undo point BEFORE swap so Cmd+Z backs out a mistaken
      // import. The history hook is debounced, so force a snapshot now.
      history.commit();
      setMappings(m);
      setCrossValidations(cv);
      toast.show(
        "success",
        `Imported ${Object.keys(m).length} mapping${Object.keys(m).length === 1 ? "" : "s"}`
      );
    },
  });

  // Keyboard shortcuts: Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z or
  // Cmd/Ctrl+Y = redo. Skip when typing in an input so we don't hijack
  // the browser's native text-field undo.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const isRedo = key === "y" || (key === "z" && e.shiftKey);
      e.preventDefault();
      if (isRedo) history.redo();
      else history.undo();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [history]);

  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // allDataKeys feeds every row's TransformEditor autocomplete. Without
  // content-stability the array identity flips on every keystroke,
  // which would defeat React.memo on MappingRow at exactly the field
  // counts where memoization matters most. We stabilise it via a join-
  // key compare: same string ⇒ same array reference.
  const allDataKeysRef = useRef<string[]>([]);
  const allDataKeysJoinedRef = useRef<string>("");
  const allDataKeys = useMemo(() => {
    const next = Object.values(mappings)
      .map((m) => m.dataKey)
      .filter(Boolean) as string[];
    const joined = next.join("\u0001");
    if (joined === allDataKeysJoinedRef.current) return allDataKeysRef.current;
    allDataKeysJoinedRef.current = joined;
    allDataKeysRef.current = next;
    return next;
  }, [mappings]);

  // Identity-stable callbacks for MappingRow. The list re-renders on
  // every keystroke (search, mapping edits, validation), so passing
  // fresh closures per row would defeat React.memo on MappingRow at
  // exactly the field counts where memoization matters most.
  //
  // We pin each handler to the "latest ref" pattern: a ref holds the
  // most recent implementation, the exposed callback reads through the
  // ref. The exposed callback never changes identity, but always calls
  // the freshest logic. Effectively free per render — just a ref write.
  const selectFieldRef = useRef<(name: string, source?: "pdf" | "list") => void>(
    () => {}
  );
  const updateMappingRef = useRef<(name: string, patch: Partial<AcroMapping>) => void>(
    () => {}
  );
  const toggleMultiSelectRef = useRef<(name: string) => void>(() => {});
  const startPlaceFieldRef = useRef<(name: string) => void>(() => {});
  const openInspectorRef = useRef<(field: AcroFormField) => void>(() => {});

  const stableOnSelect = useCallback((name: string) => {
    selectFieldRef.current(name, "list");
  }, []);
  const stableOnChange = useCallback(
    (name: string, patch: Partial<AcroMapping>) => {
      updateMappingRef.current(name, patch);
    },
    []
  );
  const stableOnToggleMulti = useCallback((name: string) => {
    toggleMultiSelectRef.current(name);
  }, []);
  const stableOnPlace = useCallback((name: string) => {
    startPlaceFieldRef.current(name);
  }, []);
  const stableOnOpenInspector = useCallback((field: AcroFormField) => {
    openInspectorRef.current(field);
  }, []);

  // Pre-index fields by their page number. The overlay was previously
  // doing `fields.filter(f => f.page === pageNum)` for every rendered
  // page — O(pages × fields) per render pass. With a map lookup it
  // becomes O(1) per page, which matters a lot at 1000 pages × 5000
  // fields where the filter alone was a measurable fraction of each
  // paint.
  const fieldsByPage = useMemo(() => {
    const m = new Map<number, AcroFormField[]>();
    for (const f of localFields) {
      if (!f.rect) continue;
      const arr = m.get(f.page);
      if (arr) arr.push(f);
      else m.set(f.page, [f]);
    }
    return m;
  }, [localFields]);

  // Debounce the inputs to validation so a keystroke in sampleData or a
  // mapping doesn't walk the entire fields list on every character. At
  // 5000 fields the un-debounced version locks the main thread; this
  // keeps typing responsive.
  const debouncedMappings = useDebouncedValue(mappings, 250);
  const debouncedSampleData = useDebouncedValue(sampleData, 250);
  const debouncedCrossValidations = useDebouncedValue(crossValidations, 250);

  // Live validation errors, grouped by field name. Declared BEFORE
  // `grouped` because the "errors-only" filter depends on it.
  const validationErrors = useMemo(
    () =>
      validateAll(
        localFields,
        debouncedMappings,
        debouncedSampleData,
        debouncedCrossValidations
      ),
    [localFields, debouncedMappings, debouncedSampleData, debouncedCrossValidations]
  );
  const errorsByField = useMemo(() => {
    const m: Record<string, typeof validationErrors> = {};
    for (const e of validationErrors) {
      if (!m[e.fieldName]) m[e.fieldName] = [];
      m[e.fieldName].push(e);
    }
    return m;
  }, [validationErrors]);

  // Group fields by section AND sort within each group by page then reading
  // order (top-to-bottom, left-to-right) so the list mirrors the visual PDF.
  // PDF origin is bottom-left → a larger rect.y is visually HIGHER on the
  // page, so we sort by -(y + h) (top edge, DOM-style) ascending.
  //
  // Also applies the search query and status filter so that at very high
  // field counts the list narrows to only matching rows. We keep the
  // section grouping structure so the user has spatial context even
  // while filtering.
  const grouped = useMemo(() => {
    const readingOrder = (a: AcroFormField, b: AcroFormField) => {
      if (a.page !== b.page) return a.page - b.page;
      const aTop = a.rect ? -(a.rect.y + a.rect.h) : 0;
      const bTop = b.rect ? -(b.rect.y + b.rect.h) : 0;
      if (aTop !== bTop) return aTop - bTop;
      return (a.rect?.x ?? 0) - (b.rect?.x ?? 0);
    };
    const q = debouncedSearch.trim().toLowerCase();
    const matches = (f: AcroFormField) => {
      if (onlyCurrentPage && f.page !== currentPage) return false;
      if (q) {
        const m = mappings[f.name];
        const hay = [
          f.name,
          m?.dataKey ?? "",
          f.tooltip ?? "",
          f.type ?? "",
          m?.section ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (statusFilter === "unmapped") {
        const dk = mappings[f.name]?.dataKey;
        if (dk) return false;
      } else if (statusFilter === "errors") {
        if (!errorsByField[f.name]?.length) return false;
      }
      return true;
    };
    const filtered = localFields.filter(matches);
    filtered.sort(readingOrder);
    const m = new Map<string, AcroFormField[]>();
    // Group key strategy. "page" → "Page N" headers; "section" → user
    // section labels; "none" → a single ungrouped bucket so the list
    // is just a flat sorted view (handy when filtering tightly).
    for (const f of filtered) {
      let key: string;
      if (groupBy === "page") {
        key = `Page ${f.page}`;
      } else if (groupBy === "none") {
        key = "";
      } else {
        key = mappings[f.name]?.section || "";
      }
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(f);
    }
    return m;
  }, [
    localFields,
    mappings,
    debouncedSearch,
    statusFilter,
    errorsByField,
    groupBy,
    onlyCurrentPage,
    currentPage,
  ]);

  // Total number of rows that will render after filtering. Used to decide
  // whether to auto-collapse sections (at huge field counts, expanded
  // sections alone would put thousands of rows in the DOM).
  const filteredRowCount = useMemo(() => {
    let n = 0;
    for (const rows of grouped.values()) n += rows.length;
    return n;
  }, [grouped]);

  // Auto-collapse every section once when we cross the 200-row threshold.
  // We only run this on the first oversized load so users can still
  // manually expand individual sections afterward without the effect
  // fighting them on every re-render.
  const autoCollapsedRef = useRef(false);
  useEffect(() => {
    if (autoCollapsedRef.current) return;
    if (filteredRowCount <= 200) return;
    autoCollapsedRef.current = true;
    setCollapsedSections(new Set(grouped.keys()));
  }, [filteredRowCount, grouped]);

  // Design-time QA issue count for the header badge.
  const qaIssues = useMemo(
    () =>
      runAcroQA(
        localFields,
        debouncedMappings,
        debouncedSampleData,
        debouncedCrossValidations
      ),
    [localFields, debouncedMappings, debouncedSampleData, debouncedCrossValidations]
  );
  const qaErrorCount = qaIssues.filter((i) => i.severity === "error").length;
  const qaWarnCount = qaIssues.filter((i) => i.severity === "warning").length;

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

  // selectField — source tells us where the click came from so we can tune
  // which panels scroll:
  //   • "pdf"  — click on a field overlay in the PDF canvas. Only scroll
  //              the mapping row into view when editMode === "off" (Bind).
  //              In Edit/Draw modes the user is mid-gesture and yanking the
  //              right panel breaks the flow.
  //   • "list" — click on a row in the field mapping panel. Always scroll
  //              the PDF canvas to that field's page so the user can see
  //              what they just selected, regardless of mode.
  function selectField(
    name: string,
    source: "pdf" | "list" = "pdf",
    opts?: { additive?: boolean }
  ) {
    // Additive (shift/cmd+click): toggle the name in multiSelected without
    // changing the primary selection. Used in Edit mode for building a
    // multi-selection without going via the rubber-band marquee.
    if (opts?.additive) {
      setMultiSelected((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
      setSelectedField(name);
      return;
    }
    setSelectedField(name);
    if (source === "pdf") {
      if (editMode !== "off") return;
      const el = rowRefs.current[name];
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    // source === "list": jump the PDF to the field's page.
    const field = localFields.find((f) => f.name === name);
    if (field) {
      const pageEl = document.querySelector(
        `[data-page="${field.page}"]`
      ) as HTMLElement | null;
      pageEl?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  // Marquee result → merge into multiSelected. Additive when the user
  // held shift/meta during the drag; otherwise replaces the selection.
  function onMarqueeSelect(
    names: string[],
    opts: { additive: boolean }
  ) {
    setMultiSelected((prev) => {
      if (!opts.additive) return new Set(names);
      const next = new Set(prev);
      for (const n of names) next.add(n);
      return next;
    });
    // If the user rubber-banded a non-empty set, also promote the first
    // hit to the primary selection so drag handles appear on a member
    // of the group.
    if (names.length > 0) setSelectedField(names[0]);
  }

  // Apply an align/distribute/match-size transform to every field in
  // multiSelected. We route through commitRectChange so each change is
  // a proper update-rect patch (and the patch-coalescing logic there
  // keeps the pending list small). Fields on different pages are
  // still handled correctly — commitRectChange takes the page per call.
  function applyAlign(
    op:
      | { kind: "align"; axis: AlignAxis }
      | { kind: "distribute"; axis: DistributeAxis }
      | { kind: "match"; axis: SizeAxis }
  ) {
    const names = Array.from(multiSelected);
    if (names.length < 2) return;
    // Order: anchor first (for match-size, first-selected wins).
    // selectedField, if it's in the set, becomes the anchor so the user
    // controls it explicitly. Otherwise fall back to set order.
    const ordered = selectedField && multiSelected.has(selectedField)
      ? [selectedField, ...names.filter((n) => n !== selectedField)]
      : names;
    const picked = ordered
      .map((n) => localFields.find((f) => f.name === n))
      .filter((f): f is AcroFormField => !!f && !!f.rect);
    if (picked.length < 2) return;
    const rects = picked.map((f) => f.rect!);
    let next: FieldRect[];
    if (op.kind === "align") next = alignRects(rects, op.axis);
    else if (op.kind === "distribute") next = distributeRects(rects, op.axis);
    else next = matchSize(rects, op.axis);
    for (let i = 0; i < picked.length; i++) {
      const r = next[i];
      if (!r) continue;
      // Cheap identity check — skip no-op commits.
      const prev = picked[i].rect!;
      if (
        prev.x === r.x &&
        prev.y === r.y &&
        prev.w === r.w &&
        prev.h === r.h
      ) {
        continue;
      }
      commitRectChange(picked[i].name, r, picked[i].page);
    }
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
    for (const f of localFields) {
      const dk = mappings[f.name]?.dataKey;
      if (dk) skeleton[dk] = sampleData[dk] ?? "";
    }
    setGenJSON(JSON.stringify(skeleton, null, 2));
    setGenErr(null);
    setGenFieldErrors(null);
    setGenOpen(true);
  }

  // ---- Tier C: structure edit handlers ----

  // Snap a rect's four scalars to the grid. Width and height snap
  // independently so a user who's resizing doesn't see the opposite edge
  // jump around: we preserve top/left position and only quantize size.
  // Values below 1pt are clamped to 1pt to avoid collapsing rects.
  const GRID_SIZE = 5;
  function snapRect(r: FieldRect): FieldRect {
    if (!snapToGrid) return r;
    const s = (n: number) => Math.round(n / GRID_SIZE) * GRID_SIZE;
    return {
      x: s(r.x),
      y: s(r.y),
      w: Math.max(1, s(r.w)),
      h: Math.max(1, s(r.h)),
    };
  }

  function commitRectChange(name: string, rect: FieldRect, page: number) {
    const finalRect = snapRect(rect);
    // Clear the draft and push both the rect update (visual) AND a patch.
    setDraftRectsByField((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    setLocalFields((prev) =>
      prev.map((f) => (f.name === name ? { ...f, rect: finalRect, page } : f))
    );
    // Coalesce consecutive update-rect patches for the same field into one —
    // otherwise holding an arrow key fires 40 patches/sec and the "pending
    // changes" counter balloons with redundant entries.
    setPendingPatches((prev) => {
      const last = prev[prev.length - 1];
      if (
        last &&
        last.op === "update-rect" &&
        last.name === name &&
        last.page === page
      ) {
        return [...prev.slice(0, -1), { op: "update-rect", name, page, rect: finalRect }];
      }
      return [...prev, { op: "update-rect", name, page, rect: finalRect }];
    });
  }

  function drawNewField(rawRect: FieldRect, page: number) {
    const rect = snapRect(rawRect);
    // "Place existing field" path: the user clicked "Place on PDF" on a
    // rect-less supplement field and then drew a rectangle. Update that
    // field's rect/page instead of inventing a new one.
    if (placingForField) {
      const name = placingForField;
      const pageSize =
        localFields.find((f) => f.page === page)?.pageSize ?? { w: 612, h: 792 };
      setLocalFields((prev) =>
        prev.map((f) =>
          f.name === name ? { ...f, rect, page, pageSize } : f
        )
      );
      setPendingPatches((prev) => [
        ...prev,
        { op: "update-rect", name, page, rect },
      ]);
      setPlacingForField(null);
      setSelectedField(name);
      // Drop into select mode so the user can immediately nudge/resize.
      setEditMode("select");
      return;
    }

    // Default path: create a new text field. Auto-generated name — user
    // can rename via the inspector later.
    const base = "field";
    let i = 1;
    const existing = new Set(localFields.map((f) => f.name));
    while (existing.has(`${base}_${i}`)) i++;
    const name = `${base}_${i}`;

    const pageSize =
      localFields.find((f) => f.page === page)?.pageSize ?? { w: 612, h: 792 };
    const newField: AcroFormField = {
      name,
      type: "Tx",
      page,
      rect,
      pageSize,
    };
    setLocalFields((prev) => [...prev, newField]);
    setMappings((prev) => ({ ...prev, [name]: { dataKey: name } }));
    setPendingPatches((prev) => [
      ...prev,
      { op: "add-text", name, page, rect },
    ]);
    setSelectedField(name);
    setEditMode("select");
  }

  // Entry point from a rect-less field's "Place on PDF" button. Flips
  // into draw mode with the field name primed so drawNewField knows to
  // patch rather than create.
  function startPlaceField(name: string) {
    setPlacingForField(name);
    setEditMode("draw");
    setSelectedField(name);
  }

  // Refresh the latest-ref handlers on every render. Cheap (5 ref
  // writes) and pays for itself by letting the MappingRow list memoize
  // — without this, every re-render hands MappingRow new closure
  // identities and re-renders all rows even when nothing changed.
  selectFieldRef.current = selectField;
  updateMappingRef.current = updateMapping;
  toggleMultiSelectRef.current = toggleMultiSelect;
  startPlaceFieldRef.current = startPlaceField;
  openInspectorRef.current = setInspectorField;

  // Cancel placement — leaves the field rect-less and drops back to
  // select mode.
  function cancelPlaceField() {
    setPlacingForField(null);
    setEditMode("off");
  }

  function deleteSelectedField() {
    if (!selectedField) return;
    const name = selectedField;
    setLocalFields((prev) => prev.filter((f) => f.name !== name));
    setMappings((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    // If the field was added in this session (has a prior add-text patch),
    // drop the add-text instead of emitting a delete.
    setPendingPatches((prev) => {
      const addIdx = prev.findIndex(
        (p) => p.op === "add-text" && p.name === name
      );
      if (addIdx >= 0) return prev.filter((_, i) => i !== addIdx);
      return [...prev, { op: "delete", name }];
    });
    setSelectedField(null);
  }

  function renameField(oldName: string, newName: string) {
    if (!newName || newName === oldName) return;
    if (localFields.some((f) => f.name === newName)) {
      toast.show("error", `Name "${newName}" already exists`);
      return;
    }
    setLocalFields((prev) =>
      prev.map((f) => (f.name === oldName ? { ...f, name: newName } : f))
    );
    setMappings((prev) => {
      const next = { ...prev };
      if (next[oldName]) {
        next[newName] = next[oldName];
        delete next[oldName];
      }
      return next;
    });
    setPendingPatches((prev) => [
      ...prev,
      { op: "rename", name: oldName, newName },
    ]);
    if (selectedField === oldName) setSelectedField(newName);
  }

  function undoStructurePatch() {
    // Revert the last pending patch. Exact re-hydration of localFields from
    // the original tpl.fields is complex for long patch chains, so we rebuild
    // from tpl.fields and re-apply remaining patches visually.
    if (pendingPatches.length === 0) return;
    const nextPatches = pendingPatches.slice(0, -1);
    setPendingPatches(nextPatches);
    const replayed = replayPatches(tpl.fields, nextPatches);
    setLocalFields(replayed);
  }

  function discardStructure() {
    setPendingPatches([]);
    setLocalFields(tpl.fields);
    setDraftRectsByField({});
    setStructureErr(null);
  }

  async function saveStructure() {
    if (readOnly) return;
    if (pendingPatches.length === 0) return;
    setStructureSaving(true);
    setStructureErr(null);
    try {
      const res = await applyStructurePatches(
        tpl.id,
        pendingPatches,
        localVersion
      );
      setLocalFields(res.fields);
      setLocalVersion(res.version);
      setLocalPreviewUrl(res.previewUrl);
      setPendingPatches([]);
      setDraftRectsByField({});
      toast.show(
        "success",
        `Saved PDF structure (v${res.version}, ${pendingPatches.length} changes)`
      );
    } catch (e: any) {
      setStructureErr(e.message);
      toast.show("error", e.message);
    } finally {
      setStructureSaving(false);
    }
  }

  // Delete-key shortcut in edit mode.
  useEffect(() => {
    if (editMode === "off") return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (!selectedField) return;
      e.preventDefault();
      deleteSelectedField();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode, selectedField, localFields.length]);

  // Arrow-key nudge for the selected field in select mode. Deltas are in
  // PDF points (1pt = 1/72 inch, same space as rect.x / rect.y).
  //   • Arrow        — 1pt
  //   • Shift+Arrow  — 10pt (fast travel)
  //   • Alt+Arrow    — 0.25pt (sub-point precision for fine alignment)
  // PDF origin is bottom-left, so ArrowUp increases y. We stay out of the
  // way when the user is typing in an input.
  useEffect(() => {
    if (editMode !== "select") return;
    if (!selectedField) return;
    function onKey(e: KeyboardEvent) {
      if (
        e.key !== "ArrowUp" &&
        e.key !== "ArrowDown" &&
        e.key !== "ArrowLeft" &&
        e.key !== "ArrowRight"
      ) {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const field = localFields.find((f) => f.name === selectedField);
      if (!field?.rect) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : e.altKey ? 0.25 : 1;
      let dx = 0;
      let dy = 0;
      if (e.key === "ArrowUp") dy = step;
      else if (e.key === "ArrowDown") dy = -step;
      else if (e.key === "ArrowLeft") dx = -step;
      else if (e.key === "ArrowRight") dx = step;
      const next: FieldRect = {
        x: field.rect.x + dx,
        y: field.rect.y + dy,
        w: field.rect.w,
        h: field.rect.h,
      };
      commitRectChange(field.name, next, field.page);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode, selectedField, localFields, snapToGrid]);

  async function runGenerateFlow() {
    setGenBusy(true);
    setGenErr(null);
    setGenFieldErrors(null);
    try {
      let parsed: any;
      try {
        parsed = JSON.parse(genJSON);
      } catch {
        throw new Error("Invalid JSON");
      }
      const result = await runGenerate(tpl.id, {
        data: parsed,
        flatten: genFlatten,
        async: genAsync,
        onProgress: setGenProgress,
      });
      // Replace the old auto-download with an in-app preview. For
      // AcroForm specifically the user often wants to verify the
      // filled-field appearance before downloading or sharing, so
      // popping a blob in a new tab was especially disruptive.
      setGenResult({
        downloadUrl: result.downloadUrl,
        outputFileId: result.outputFileId,
        fileName: `${tplName}.pdf`,
      });
      setGenOpen(false);
    } catch (e: any) {
      // 422 validation_failed carries a structured `fields` list. Render
      // each entry inline in the dialog instead of cramming the whole
      // server message into one toast. Non-validation errors fall
      // through to the string-message path.
      if (e instanceof ApiError && e.code === "validation_failed" && e.fields?.length) {
        setGenFieldErrors(e.fields);
        setGenErr(e.message);
      } else {
        setGenErr(e.message);
      }
    } finally {
      setGenBusy(false);
      setGenProgress(null);
    }
  }

  async function save() {
    if (readOnly) return;
    setSaving(true);
    try {
      const res = await api<{ version: number }>(
        `/v1/templates/${tpl.id}/config`,
        {
          method: "PUT",
          body: JSON.stringify({ config: { mappings, crossValidations } }),
        }
      );
      // Refresh the saved snapshot so the unsaved-changes guard goes
      // clean again until the user's next edit.
      savedSnapshotRef.current = JSON.stringify({ mappings, crossValidations });
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
      <header className="sticky top-0 z-40 border-b bg-background/80 px-4 py-2.5 backdrop-blur md:px-6">
        {/* Three-zone header. The earlier flat row crammed 13 buttons onto
            one line and broke the template name onto two. Now: identity
            on the left, primary mode switch + status in the middle, and
            terminal actions (Save/Generate) pinned to the right. Every
            secondary action lives behind the Tools dropdown — discoverable
            without consuming header real estate. */}
        <div className="flex items-center gap-3">
          {/* Left: back arrow + template identity (single line, truncates). */}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Button variant="ghost" size="sm" className="shrink-0" asChild>
              <Link
                href="/drive"
                onClick={(e) => {
                  // Intercept so the unsaved-changes guard can prompt
                  // before Next.js client navigation runs. We always
                  // preventDefault; confirmNavigate does the push itself.
                  e.preventDefault();
                  confirmNavigate(() => router.push("/drive"));
                }}
              >
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">Drive</span>
              </Link>
            </Button>
            <Separator orientation="vertical" className="h-6 shrink-0" />
            <div className="flex min-w-0 items-center gap-2">
              <InlineRenameTitle
                templateId={tpl.id}
                name={tplName}
                onRenamed={setTplName}
                className="text-sm font-semibold"
              />
              <Badge
                variant="outline"
                className="shrink-0 text-[10px] uppercase"
              >
                {tpl.mode}
              </Badge>
              <span className="shrink-0 text-xs text-muted-foreground">
                v{tpl.version}
              </span>
              {savedMsg && (
                <span className="hidden shrink-0 items-center gap-1 text-xs text-emerald-600 md:inline-flex">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {savedMsg}
                </span>
              )}
            </div>
          </div>

          {/* Right: mode + status + tools + commit actions. */}
          <div className="flex shrink-0 items-center gap-1.5">
            {/* Segmented mode switch. Grouped in a bordered container so
                it reads as a single control rather than three siblings. */}
            <div className="flex items-center gap-0.5 rounded-md border bg-muted/30 p-0.5">
              <Button
                variant={editMode === "off" ? "outline" : "ghost"}
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => {
                  setEditMode("off");
                  setDraftRectsByField({});
                }}
                title="Binding mode: edit data mappings"
              >
                <MousePointer2 className="h-3.5 w-3.5" /> Bind
              </Button>
              <Button
                variant={editMode === "select" ? "outline" : "ghost"}
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => setEditMode("select")}
                title="Edit mode: drag to move/resize fields"
              >
                <PencilRuler className="h-3.5 w-3.5" /> Edit
              </Button>
              <Button
                variant={editMode === "draw" ? "outline" : "ghost"}
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => setEditMode("draw")}
                title="Draw mode: click+drag to create a new text field"
              >
                <PenSquare className="h-3.5 w-3.5" /> Draw
              </Button>
            </div>

            {/* Snap toggle only surfaces in geometric modes where it
                actually does something. */}
            {editMode !== "off" && (
              <Button
                variant={snapToGrid ? "outline" : "ghost"}
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => setSnapToGrid((s) => !s)}
                title={`Snap rects to a ${GRID_SIZE}pt grid on drag/nudge/draw`}
              >
                <Grid3x3 className="h-3.5 w-3.5" /> Snap
              </Button>
            )}

            <Button
              variant={qaErrorCount > 0 ? "destructive" : "ghost"}
              size="sm"
              onClick={() => setQaOpen((o) => !o)}
              className="relative h-8"
              title="Design-time QA"
            >
              <ShieldAlert className="h-4 w-4" />
              <span className="hidden lg:inline">QA</span>
              {qaIssues.length > 0 && (
                <span
                  className={cn(
                    "ml-1 rounded-full px-1.5 text-[10px] font-semibold",
                    qaErrorCount > 0
                      ? "bg-destructive-foreground text-destructive"
                      : qaWarnCount > 0
                      ? "bg-amber-500/20 text-amber-700 dark:text-amber-300"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {qaIssues.length}
                </span>
              )}
            </Button>

            {/* Tools dropdown — home for every secondary action. Auto-map
                and export schema used to sit in the header; they're still
                one click away, but no longer fight Save/Generate for
                attention. Config import/export and navigation to sibling
                pages (Versions, Playground, Batch) live here too. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8"
                  title="More tools"
                >
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="hidden lg:inline">Tools</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Mapping</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => setAutoMapOpen(true)}>
                  <Wand2 className="mr-2 h-4 w-4" />
                  Auto-map fields
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSchemaOpen(true)}>
                  <ScanSearch className="mr-2 h-4 w-4" />
                  Export schema
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Config</DropdownMenuLabel>
                <DropdownMenuItem onClick={configIO.openFilePicker}>
                  <Upload className="mr-2 h-4 w-4" />
                  Import config…
                </DropdownMenuItem>
                <DropdownMenuItem onClick={configIO.download}>
                  <Download className="mr-2 h-4 w-4" />
                  Export config
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Navigate</DropdownMenuLabel>
                <DropdownMenuItem asChild>
                  <Link href={`/templates/${tpl.id}/versions`}>
                    <Layers className="mr-2 h-4 w-4" />
                    Versions
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href={`/templates/${tpl.id}/playground`}>
                    <Sparkles className="mr-2 h-4 w-4" />
                    Playground
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setBatchOpen(true)}>
                  <FileSpreadsheet className="mr-2 h-4 w-4" />
                  Batch generate
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* OCR + AI for the source PDF — drawer-style so the
                designer's PDF preview / field overlay stays in view
                behind them. Useful when mapping fields whose intended
                data keys are described in body text rather than
                AcroForm metadata. */}
            {fileId ? (
              <DocAITools fileId={fileId} fileName={tpl.name} />
            ) : null}

            {/* API integration guide — drawer with endpoint, payload, and
                runnable snippets derived live from this template's schema. */}
            <ApiGuideSheet templateId={tpl.id} templateName={tpl.name} />

            <Separator orientation="vertical" className="mx-0.5 h-6" />

            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={save}
              loading={saving}
              disabled={readOnly}
              title={
                readOnly
                  ? "View-only access — ask the owner for edit access"
                  : undefined
              }
            >
              <Save className="h-4 w-4" /> Save
            </Button>
            <Button size="sm" className="h-8" onClick={openGenerate}>
              <PlayCircle className="h-4 w-4" /> Generate
            </Button>
          </div>
        </div>
      </header>

      {editMode === "select" && multiSelected.size >= 2 && (
        <AlignToolbar
          count={multiSelected.size}
          onAlign={(axis) => applyAlign({ kind: "align", axis })}
          onDistribute={(axis) => applyAlign({ kind: "distribute", axis })}
          onMatchSize={(axis) => applyAlign({ kind: "match", axis })}
          onClear={() => setMultiSelected(new Set())}
        />
      )}

      {placingForField && (
        <div className="flex items-center justify-between gap-3 border-b border-blue-500/40 bg-blue-500/10 px-4 py-2 text-xs md:px-6">
          <div className="flex items-center gap-2">
            <MapPin className="h-3.5 w-3.5 text-blue-700 dark:text-blue-400" />
            <span className="font-medium text-blue-900 dark:text-blue-200">
              Click and drag on the PDF to place{" "}
              <span className="font-mono">{placingForField}</span>
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={cancelPlaceField}
          >
            Cancel
          </Button>
        </div>
      )}

      {pendingPatches.length > 0 && (
        <div className="flex items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs md:px-6">
          <div className="flex items-center gap-2">
            <PencilRuler className="h-3.5 w-3.5 text-amber-700 dark:text-amber-400" />
            <span className="font-medium text-amber-900 dark:text-amber-200">
              {pendingPatches.length} pending structure change
              {pendingPatches.length === 1 ? "" : "s"}
            </span>
            {structureErr && (
              <span className="text-destructive">— {structureErr}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={undoStructurePatch}
              disabled={structureSaving}
            >
              <Undo2 className="h-3.5 w-3.5" /> Undo
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={discardStructure}
              disabled={structureSaving}
            >
              Discard all
            </Button>
            <Button
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={saveStructure}
              loading={structureSaving}
              disabled={readOnly}
              title={
                readOnly
                  ? "View-only access — ask the owner for edit access"
                  : undefined
              }
            >
              <Save className="h-3.5 w-3.5" /> Save structure
            </Button>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <section className="flex-1 border-r">
          <PdfPreview
            url={localPreviewUrl}
            onCurrentPageChange={setCurrentPage}
            onLoadProgress={(loaded, total) => {
              if (total > 0) setPdfProgress(Math.min(1, loaded / total));
              else setPdfProgress(null);
              if (total > 0 && loaded >= total) {
                // Drop the bar once the load completes — keeping it
                // pinned at 100% just adds noise.
                setPdfProgress(null);
              }
            }}
            overlayForPage={(rp) => (
              <FieldOverlay
                page={rp}
                fields={fieldsByPage.get(rp.pageNum) ?? EMPTY_FIELDS}
                mappings={mappings}
                selectedField={selectedField}
                sampleData={sampleData}
                fieldErrors={errorsByField}
                onSelect={(name, opts) =>
                  selectField(name, "pdf", opts)
                }
                editMode={editMode}
                draftRectsByField={draftRectsByField}
                onRectPreview={(name, r) =>
                  setDraftRectsByField((prev) => ({ ...prev, [name]: r }))
                }
                onRectCommit={commitRectChange}
                onDrawNew={drawNewField}
                multiSelected={multiSelected}
                onMarqueeSelect={onMarqueeSelect}
                onClearMultiSelect={() => setMultiSelected(new Set())}
              />
            )}
          />
        </section>

        <aside className="w-[480px] shrink-0 overflow-y-auto bg-background">
          {editMode !== "off" && selectedField && (
            <div className="flex items-center justify-between gap-2 border-b bg-primary/5 px-4 py-2 text-xs">
              <div className="min-w-0">
                <span className="text-muted-foreground">Selected: </span>
                <span className="truncate font-mono font-medium">
                  {selectedField}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => {
                    const next = window.prompt(
                      "Rename field to:",
                      selectedField
                    );
                    if (next && next.trim()) renameField(selectedField, next.trim());
                  }}
                >
                  Rename
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px] text-destructive"
                  onClick={deleteSelectedField}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </Button>
              </div>
            </div>
          )}
          <FixturesPicker fx={fx} onImportCsv={() => setCsvOpen(true)} />
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
              {filteredRowCount === localFields.length
                ? `${localFields.length} field${localFields.length === 1 ? "" : "s"}`
                : `${filteredRowCount} of ${localFields.length} field${localFields.length === 1 ? "" : "s"}`}
              . Click a field in the PDF to jump here; click the checkbox to
              multi-select for bulk actions.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search name, data key, tooltip…"
                  className="h-7 w-full rounded-md border bg-background pl-7 pr-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              {/* Tight status filter — "all" shows every field, the other
                  two narrow to problem cases, which is what users reach
                  for at 1000s of fields. */}
              <div className="flex items-center gap-0.5 rounded-md border p-0.5">
                {(["all", "unmapped", "errors"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setStatusFilter(key)}
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                      statusFilter === key
                        ? "bg-muted font-semibold text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {key}
                  </button>
                ))}
              </div>
            </div>
            {/* Group-by + page-aware filters. The page filter is the
                heaviest hitter at 500-page docs — it caps the visible
                row count to one page's fields no matter how many
                thousand fields the doc has. */}
            <div className="mt-2 flex items-center gap-2 text-[10px]">
              <div className="flex items-center gap-0.5 rounded-md border p-0.5">
                <span className="px-1 uppercase tracking-wide text-muted-foreground">
                  Group
                </span>
                {(
                  [
                    ["section", "Section"],
                    ["page", "Page"],
                    ["none", "None"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setGroupBy(key)}
                    className={cn(
                      "rounded px-1.5 py-0.5",
                      groupBy === key
                        ? "bg-muted font-semibold text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label
                className="flex cursor-pointer items-center gap-1 rounded-md border px-1.5 py-1"
                title="Only show fields on the page currently visible in the PDF preview"
              >
                <input
                  type="checkbox"
                  className="h-3 w-3 accent-primary"
                  checked={onlyCurrentPage}
                  onChange={(e) => setOnlyCurrentPage(e.target.checked)}
                />
                <span className="text-muted-foreground">
                  Page {currentPage} only
                </span>
              </label>
            </div>
            {pdfProgress !== null && (
              <div
                className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted"
                aria-label="PDF download progress"
              >
                <div
                  className="h-full bg-primary transition-[width] duration-150"
                  style={{ width: `${Math.round(pdfProgress * 100)}%` }}
                />
              </div>
            )}
          </div>

          {localFields.length === 0 ? (
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
                              onToggleMultiSelect={stableOnToggleMulti}
                              allFieldDataKeys={allDataKeys}
                              sampleData={sampleData}
                              errors={errorsByField[f.name]}
                              onSelect={stableOnSelect}
                              onChange={stableOnChange}
                              onOpenInspector={stableOnOpenInspector}
                              onPlace={!f.rect ? stableOnPlace : undefined}
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
        fields={localFields}
        onOpenChange={setAutoMapOpen}
        onApply={applyAutoMap}
      />

      <CsvImportDialog
        open={csvOpen}
        onOpenChange={setCsvOpen}
        fx={fx}
        mappingDataKeys={allDataKeys}
      />

      {/* The config import/export hook returns both the hidden file input
          and the import-preview dialog as a single node; render once. */}
      {configIO.dialog}

      <SchemaExportDialog
        open={schemaOpen}
        onOpenChange={setSchemaOpen}
        fields={localFields}
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
            {genFieldErrors && genFieldErrors.length > 0 && (
              <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-2">
                <div className="px-1 text-xs font-semibold text-destructive">
                  {genErr ?? "Validation failed"} — {genFieldErrors.length} field
                  {genFieldErrors.length === 1 ? "" : "s"}
                </div>
                <ul className="max-h-40 space-y-0.5 overflow-y-auto">
                  {genFieldErrors.map((fe, i) => (
                    <li key={`${fe.field}:${i}`}>
                      <button
                        type="button"
                        className="flex w-full items-start gap-2 rounded px-1.5 py-1 text-left text-[11px] hover:bg-destructive/10"
                        onClick={() => {
                          // Close dialog and jump to the failing field in
                          // the mapping panel so the user can fix it.
                          setGenOpen(false);
                          selectField(fe.field, "list");
                        }}
                      >
                        <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
                        <span className="min-w-0 flex-1">
                          <span className="truncate font-mono text-[10px] text-muted-foreground">
                            {fe.field}
                            {fe.dataKey && fe.dataKey !== fe.field
                              ? ` · ${fe.dataKey}`
                              : ""}
                          </span>
                          <span className="block text-destructive">
                            {fe.message}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {genErr && !genFieldErrors && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {genErr}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGenOpen(false)} disabled={genBusy}>
              Cancel
            </Button>
            <Button onClick={runGenerateFlow} loading={genBusy}>
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

      <DesignQAPanel
        open={qaOpen}
        fields={localFields}
        mappings={mappings}
        sampleData={sampleData}
        crossValidations={crossValidations}
        onClose={() => setQaOpen(false)}
        onSelectField={(name) => selectField(name, "list")}
        onChangeCross={setCrossValidations}
      />

      {/* Post-generate preview — replaces the old auto-download with an
          in-app PDF viewer so the user can verify filled fields before
          downloading or sharing. */}
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

function defaultMappings(fields: AcroFormField[]): MappingMap {
  const out: MappingMap = {};
  for (const f of fields) out[f.name] = { dataKey: f.name };
  return out;
}

// replayPatches rebuilds the visual field list by applying a sequence of
// pending patches onto the original fields. Kept purely visual — the server
// is the source of truth once the batch is saved.
function replayPatches(
  base: AcroFormField[],
  patches: StructurePatch[]
): AcroFormField[] {
  let out = base.map((f) => ({ ...f }));
  for (const p of patches) {
    switch (p.op) {
      case "update-rect":
        out = out.map((f) =>
          f.name === p.name ? { ...f, rect: p.rect, page: p.page } : f
        );
        break;
      case "rename":
        out = out.map((f) =>
          f.name === p.name ? { ...f, name: p.newName } : f
        );
        break;
      case "delete":
        out = out.filter((f) => f.name !== p.name);
        break;
      case "add-text": {
        const pageSize =
          out.find((f) => f.page === p.page)?.pageSize ?? { w: 612, h: 792 };
        out.push({
          name: p.name,
          type: "Tx",
          page: p.page,
          rect: p.rect,
          pageSize,
        });
        break;
      }
      case "update-props":
        out = out.map((f) =>
          f.name === p.name
            ? {
                ...f,
                maxLen: p.props.maxLen ?? f.maxLen,
                tooltip: p.props.tooltip ?? f.tooltip,
                readOnly: p.props.readOnly ?? f.readOnly,
                required: p.props.required ?? f.required,
                multiline: p.props.multiline ?? f.multiline,
                password: p.props.password ?? f.password,
                options: p.props.options ?? f.options,
              }
            : f
        );
        break;
    }
  }
  return out;
}
