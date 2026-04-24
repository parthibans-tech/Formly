"use client";

/**
 * DocDesigner — the top-level shell for doc-mode templates.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ Header: name, save, preview toggle                                │
 *   ├──────────────────────────────────────────────────────────────────┤
 *   │ Toolbar                                                          │
 *   ├───────────────────────┬──────────────────────┬───────────────────┤
 *   │ Schema panel (fields) │ Editor               │ Preview iframe    │
 *   │                       │                      │                   │
 *   └───────────────────────┴──────────────────────┴───────────────────┘
 *
 * Contract with the server:
 *   GET  /v1/templates/:id/source       → { source: string }  (JSON bytes)
 *   PUT  /v1/templates/:id/source       ← { source, expectedVersion }
 *   POST /v1/templates/:id/preview      ← { data, source }    → { html }
 *
 * For doc mode the `source` bytes are a `StoredDoc` envelope (see
 * lib/doc/ast.ts).  We parse on load, stringify on save, and use the
 * in-memory Doc as the editor's input/output.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Code2,
  Eye,
  FileJson2,
  Palette,
  Save,
  TriangleAlert,
  X,
} from "lucide-react";

import { api, ApiError } from "@/lib/api";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

import {
  type Doc,
  type FieldFormat,
  type StoredDoc,
  emptyDoc,
  validateStoredDoc,
  wrapStoredDoc,
} from "@/lib/doc/ast";
import { renderDoc, wrapInDocument } from "@/lib/doc/render";
import { InlineRenameTitle } from "@/components/designer/inline-rename-title";
import { DocEditor, type FieldRequest } from "./editor";
import { DocToolbar } from "./toolbar";
import { SchemaPanel } from "./schema-panel";
import type { Editor } from "@tiptap/react";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DocDesignerTemplate {
  id: string;
  name: string;
  mode: string;
  version: number;
  config: {
    placeholders?: string[];
    sampleData?: Record<string, unknown>;
    locale?: string;
  };
}

export interface DocDesignerProps {
  tpl: DocDesignerTemplate;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DocDesigner({ tpl: initialTpl }: DocDesignerProps) {
  const toast = useToast();
  const [tpl, setTpl] = useState(initialTpl);
  const [doc, setDoc] = useState<Doc>(emptyDoc());
  // Per-template CSS. Lives alongside the AST (StoredDoc.themeCss) — see
  // the Theme drawer below. Empty string = no author-supplied theme, the
  // shell's base styles apply.
  const [themeCss, setThemeCss] = useState<string>("");
  const [sampleJSON, setSampleJSON] = useState<string>(() =>
    JSON.stringify(initialTpl.config.sampleData ?? {}, null, 2),
  );
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastSavedVersion, setLastSavedVersion] = useState(initialTpl.version);
  const [previewMode, setPreviewMode] = useState<"live" | "source">("live");
  const [themeDrawerOpen, setThemeDrawerOpen] = useState(false);
  const editorRef = useRef<Editor | null>(null);

  // -------------------------------------------------------------------------
  // Load on mount
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api<{ source: string }>(
          `/v1/templates/${tpl.id}/source`,
        );
        if (cancelled) return;
        const parsed = parseStoredDoc(r.source);
        setDoc(parsed.doc);
        setThemeCss(parsed.themeCss);
      } catch (e) {
        if (cancelled) return;
        toast.show("error", (e as Error).message || "Failed to load template");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tpl.id]);

  // -------------------------------------------------------------------------
  // Live preview — rendered on the client so typing never blocks on a
  // network call.  We also kick a server preview in the background to
  // surface any divergence, but the visible HTML always comes from the
  // client renderer for latency.
  // -------------------------------------------------------------------------
  const sampleData = useMemo<Record<string, unknown>>(() => {
    try {
      const parsed = JSON.parse(sampleJSON);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }, [sampleJSON]);

  const rendered = useMemo(
    () => renderDoc(doc, { data: sampleData, locale: tpl.config.locale }),
    [doc, sampleData, tpl.config.locale],
  );
  const previewHtml = useMemo(
    () => wrapInDocument(rendered.html, themeCss),
    [rendered.html, themeCss],
  );

  // -------------------------------------------------------------------------
  // Save
  // -------------------------------------------------------------------------
  const save = useCallback(
    async (forceOverwrite = false): Promise<void> => {
      setSaving(true);
      try {
        const body: Record<string, unknown> = {
          source: JSON.stringify(wrapStoredDoc(doc, themeCss)),
        };
        if (!forceOverwrite) body.expectedVersion = lastSavedVersion;
        const r = await api<{ version: number; placeholders: string[] }>(
          `/v1/templates/${tpl.id}/source`,
          { method: "PUT", body: JSON.stringify(body) },
        );
        setLastSavedVersion(r.version);
        setTpl((prev) => ({
          ...prev,
          version: r.version,
          config: { ...prev.config, placeholders: r.placeholders },
        }));
        toast.show("success", `Saved v${r.version}`);
      } catch (e) {
        const err = e as ApiError;
        if (err.code === "version_conflict" || err.status === 409) {
          const overwrite = window.confirm(
            "Another collaborator saved this template while you were editing. Overwrite?\n\n" +
              "OK to overwrite, Cancel to discard your changes.",
          );
          if (overwrite) {
            await save(true);
            return;
          }
        }
        toast.show("error", err.message || "Save failed");
      } finally {
        setSaving(false);
      }
    },
    [doc, themeCss, lastSavedVersion, tpl.id, toast],
  );

  // -------------------------------------------------------------------------
  // Cmd-S shortcut
  // -------------------------------------------------------------------------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // -------------------------------------------------------------------------
  // Picker: the shell's version of onRequestField.  Today it's a plain
  // prompt — Phase 2 UX can replace this with a richer modal.
  // -------------------------------------------------------------------------
  const handlePickField = useCallback(async (): Promise<FieldRequest | null> => {
    const path = window.prompt("Field path (e.g. invoice.total)");
    if (!path) return null;
    const format = promptFormat();
    return { path, ...(format ? { format } : {}) };
  }, []);

  // Fields used in the current doc — drives the "used" badges in the panel.
  const usedPaths = useMemo(() => collectPaths(doc), [doc]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="relative flex flex-col h-screen bg-background text-foreground">
      {/* Header */}
      <header className="flex items-center gap-3 border-b px-3 py-2">
        <Link
          href="/drive/templates"
          className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={14} className="mr-1" />
          Back
        </Link>
        <Separator orientation="vertical" className="h-5" />
        <div className="flex-1 min-w-0">
          <InlineRenameTitle
            templateId={tpl.id}
            name={tpl.name}
            onRenamed={(n) => setTpl((prev) => ({ ...prev, name: n }))}
            className="text-sm font-medium"
          />
          <div className="text-[11px] text-muted-foreground">
            doc · v{tpl.version}
          </div>
        </div>
        {rendered.diagnostics.length > 0 ? (
          <Badge variant="secondary" className="gap-1">
            <TriangleAlert size={12} />
            {rendered.diagnostics.length} issue
            {rendered.diagnostics.length === 1 ? "" : "s"}
          </Badge>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setThemeDrawerOpen((v) => !v)}
          title="Edit per-template CSS"
        >
          <Palette size={14} className="mr-1" />
          Theme
          {themeCss.trim() !== "" ? (
            <span className="ml-1 h-1.5 w-1.5 rounded-full bg-teal-500" />
          ) : null}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            setPreviewMode((m) => (m === "live" ? "source" : "live"))
          }
          title="Toggle preview mode"
        >
          {previewMode === "live" ? (
            <>
              <Code2 size={14} className="mr-1" />
              HTML
            </>
          ) : (
            <>
              <Eye size={14} className="mr-1" />
              Preview
            </>
          )}
        </Button>
        <Button size="sm" onClick={() => save()} disabled={saving || loading}>
          <Save size={14} className="mr-1" />
          {saving ? "Saving…" : "Save"}
        </Button>
      </header>

      {/* Toolbar */}
      <DocToolbar editor={editorRef.current} onRequestField={handlePickField} />

      {/* Theme drawer — overlays the body when open. Saving the theme is
          deferred to the main Save button so edits show up in preview
          immediately but aren't persisted until the author commits. */}
      {themeDrawerOpen ? (
        <ThemeDrawer
          value={themeCss}
          onChange={setThemeCss}
          onClose={() => setThemeDrawerOpen(false)}
        />
      ) : null}

      {/* Body: three columns */}
      <div className="flex-1 min-h-0 grid grid-cols-[220px_minmax(0,1fr)_minmax(0,1fr)]">
        {/* Left: schema panel */}
        <SchemaPanel
          sample={sampleData}
          usedPaths={usedPaths}
          onInsert={(req) => {
            const ed = editorRef.current;
            if (!ed) return;
            ed.chain()
              .focus()
              .insertContent({
                type: "field",
                attrs: {
                  path: req.path,
                  format: req.format
                    ? JSON.stringify(req.format)
                    : undefined,
                  default: req.default,
                },
              })
              .run();
          }}
        />

        {/* Middle: editor */}
        <div className="flex flex-col min-w-0 border-r bg-background">
          <div className="flex-1 min-h-0 overflow-auto">
            {loading ? (
              <div className="px-6 py-8 text-sm text-muted-foreground">
                Loading…
              </div>
            ) : (
              <DocEditor
                value={doc}
                onChange={setDoc}
                editorRef={editorRef}
                onPickField={handlePickField}
              />
            )}
          </div>
          <SampleDataPane
            value={sampleJSON}
            onChange={setSampleJSON}
          />
        </div>

        {/* Right: preview */}
        <div className="flex flex-col min-w-0 min-h-0 bg-muted/20">
          {previewMode === "live" ? (
            <iframe
              title="Preview"
              className="w-full h-full bg-white"
              srcDoc={previewHtml}
              sandbox=""
            />
          ) : (
            <pre className="flex-1 overflow-auto bg-background text-xs font-mono p-3 whitespace-pre-wrap break-words">
              {rendered.html}
            </pre>
          )}
          {rendered.diagnostics.length > 0 ? (
            <DiagnosticsStrip diagnostics={rendered.diagnostics} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sample-data pane (bottom of editor column)
// ---------------------------------------------------------------------------

function SampleDataPane({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  let valid = true;
  try {
    JSON.parse(value);
  } catch {
    valid = false;
  }
  return (
    <div className="border-t bg-muted/20 text-xs">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-accent/40"
        onClick={() => setOpen((v) => !v)}
      >
        <FileJson2 size={13} className="text-muted-foreground" />
        <span className="font-semibold text-muted-foreground">Sample data</span>
        {!valid ? (
          <span className="text-destructive text-[10px]">invalid JSON</span>
        ) : null}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {open ? "hide" : "show"}
        </span>
      </button>
      {open ? (
        <textarea
          className="w-full min-h-[160px] max-h-[320px] px-3 py-2 bg-background border-t font-mono text-[11px] focus:outline-none"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Theme drawer — per-template CSS editor
// ---------------------------------------------------------------------------
//
// The drawer docks over the preview column so authors can watch their CSS
// take effect as they type.  We intentionally keep it a plain textarea for
// now — starters capture their branded styles into themeCss at import
// time, so the common path is "tweak an existing stylesheet" rather than
// "write CSS from scratch".  A future iteration can upgrade this to Monaco
// for autocomplete, but the wire shape (raw CSS text) won't change.
function ThemeDrawer({
  value,
  onChange,
  onClose,
}: {
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute right-0 top-[88px] z-40 w-[440px] max-h-[70vh] flex flex-col border-l border-b border-border bg-background shadow-lg">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Palette size={14} className="text-muted-foreground" />
        <div className="text-sm font-semibold">Template theme</div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground ml-auto">
          saves with the doc
        </div>
        <button
          type="button"
          className="ml-1 rounded hover:bg-accent/40 p-1"
          onClick={onClose}
          aria-label="Close theme drawer"
        >
          <X size={14} />
        </button>
      </div>
      <div className="px-3 py-1.5 text-[11px] text-muted-foreground border-b">
        CSS prepended to the preview iframe and the rendered PDF. Starters
        bring their own styles; edit here to re-brand.
      </div>
      <textarea
        className="flex-1 min-h-0 px-3 py-2 font-mono text-[11px] bg-background focus:outline-none resize-none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        placeholder={`body { font-family: "Helvetica", sans-serif; color: #222; }\nh1 { color: #0d9488; }\n`}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diagnostics strip
// ---------------------------------------------------------------------------

function DiagnosticsStrip({
  diagnostics,
}: {
  diagnostics: { severity: string; message: string }[];
}) {
  return (
    <div className="max-h-32 overflow-auto border-t bg-amber-50/70 text-[11px] text-amber-900 px-3 py-1.5 space-y-0.5">
      {diagnostics.map((d, i) => (
        <div key={i} className="flex gap-2">
          <span className="uppercase font-semibold">{d.severity}</span>
          <span className="flex-1">{d.message}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseStoredDoc(raw: string): { doc: Doc; themeCss: string } {
  if (!raw || raw.trim() === "") return { doc: emptyDoc(), themeCss: "" };
  try {
    const parsed = JSON.parse(raw) as StoredDoc;
    const err = validateStoredDoc(parsed);
    if (err) throw new Error(err);
    return { doc: parsed.doc, themeCss: parsed.themeCss ?? "" };
  } catch {
    // Corrupt template — start fresh rather than show a broken editor.
    return { doc: emptyDoc(), themeCss: "" };
  }
}

/** Walk the doc collecting every path referenced by a Field inline.  Used
 *  to annotate the schema panel — aliases declared by Repeat blocks are
 *  prefixed with "<alias>." so panel rows still match even when the doc
 *  is viewed outside the loop. */
function collectPaths(doc: Doc): Set<string> {
  const out = new Set<string>();
  function walkBlocks(blocks: unknown): void {
    if (!Array.isArray(blocks)) return;
    for (const b of blocks as Record<string, unknown>[]) {
      switch (b.type) {
        case "heading":
        case "paragraph":
          walkInlines(b.content);
          break;
        case "bulletList":
        case "orderedList":
          for (const item of (b.items as { content: unknown }[]) ?? []) {
            walkBlocks(item.content);
          }
          break;
        case "table":
          for (const row of (b.rows as { cells: { content: unknown }[] }[]) ?? []) {
            for (const c of row.cells) walkInlines(c.content);
          }
          break;
        case "repeat":
          walkBlocks(b.children);
          break;
        case "if":
          walkBlocks(b.children);
          walkBlocks(b.else);
          break;
      }
    }
  }
  function walkInlines(inlines: unknown): void {
    if (!Array.isArray(inlines)) return;
    for (const i of inlines as Record<string, unknown>[]) {
      if (i.type === "field" && typeof i.path === "string") out.add(i.path);
    }
  }
  walkBlocks(doc.content);
  return out;
}

/** Simple modal-less format picker.  A richer UI can replace this; for now
 *  a prompt-based flow keeps the designer fully usable. */
function promptFormat(): FieldFormat | undefined {
  const kind = (
    window.prompt(
      "Format? one of: text, number, currency, percent, date (blank = text)",
    ) ?? ""
  )
    .trim()
    .toLowerCase();
  if (!kind || kind === "text") return undefined;
  switch (kind) {
    case "number": {
      const dp = parseInt(window.prompt("Decimals?", "0") || "0", 10);
      return { kind: "number", decimals: isFinite(dp) ? dp : 0 };
    }
    case "currency": {
      const code = (window.prompt("Currency code?", "USD") || "USD")
        .toUpperCase();
      return { kind: "currency", code };
    }
    case "percent": {
      const dp = parseInt(window.prompt("Decimals?", "0") || "0", 10);
      return { kind: "percent", decimals: isFinite(dp) ? dp : 0 };
    }
    case "date": {
      const pattern =
        window.prompt(
          "Date pattern (Go-style, e.g. 'Jan 2, 2006')",
          "Jan 2, 2006",
        ) || "Jan 2, 2006";
      return { kind: "date", pattern };
    }
    default:
      return undefined;
  }
}
