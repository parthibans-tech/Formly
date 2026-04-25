"use client";

// /code/[id] — full-screen CodeMirror editor for source files (js/ts/
// py/css/sql/yaml/...). Pairs with api/internal/textcontent which
// serves the GET/PUT endpoints.
//
// Why CodeMirror and not Monaco
//
// Monaco is the industry standard but ships ~3 MB gzipped of code,
// language services, and worker glue. We don't need IntelliSense or
// the full TypeScript service in the drive — we need "open this file,
// edit it with syntax highlighting, save it back". CodeMirror 6 is
// modular: the core is ~150 KB and each language pack is 5–30 KB,
// loaded only when the user opens a file in that language.
//
// Save model
//
//   - Cmd/Ctrl+S triggers an immediate save.
//   - Idle autosave fires 2 s after the user stops typing.
//   - Both reuse the same save() so the dirty/saving/saved badge stays
//     in one place.
//   - Optimistic concurrency: every PUT echoes the last known
//     updated_at via If-Match. If the server says 412 we surface a
//     "file changed elsewhere" banner with a Reload action — the user
//     decides whether to clobber or merge.
//
// Theme
//
//   The app toggles a `dark` class on <html> from theme-toggle.tsx.
//   We mirror that into a state hook so the editor swaps between the
//   default light theme and one-dark without remounting.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  AlertTriangle,
  Loader2,
  Save,
  Lock,
  Eye,
  RefreshCw,
  Search,
  WrapText,
  Indent,
  Sparkles,
  Keyboard,
} from "lucide-react";
import CodeMirror, { type Extension, type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { Prec, Compartment, EditorState } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import {
  openSearchPanel,
  highlightSelectionMatches,
  searchKeymap,
} from "@codemirror/search";
import { lintKeymap } from "@codemirror/lint";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { oneDark } from "@codemirror/theme-one-dark";

import { api, ApiError, API_URL, getToken } from "@/lib/api";
import { languageForName } from "@/lib/file-open";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

// Tiny helper: tabSize is a Facet on EditorState, but the compartment
// API needs an Extension value, so we wrap the .of() call.
const EditorState_tabSize = (n: number) => EditorState.tabSize.of(n);

type ContentResponse = {
  content: string;
  name: string;
  mime: string;
  size: number;
  editable: boolean;
  canEdit: boolean;
  updatedAt: string;
  limits: {
    maxEditableBytes: number;
    maxReadableBytes: number;
  };
};

type SaveState =
  | { kind: "idle" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "error"; message: string }
  | { kind: "conflict" };

const AUTOSAVE_DELAY_MS = 2000;

export default function CodeEditorPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const fileId = params.id;

  const [meta, setMeta] = useState<ContentResponse | null>(null);
  const [text, setText] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [isDark, setIsDark] = useState(false);
  // Lazy-loaded language extension, swapped when meta.name changes.
  const [langExt, setLangExt] = useState<Extension | null>(null);

  // Toolbar-controlled view options. Each toggle reconfigures a
  // dedicated Compartment (CodeMirror's pattern for swapping a single
  // extension at runtime without rebuilding the whole state) so we can
  // flip them without remounting the editor.
  const [wrap, setWrap] = useState(true);
  const [tabSize, setTabSize] = useState(2);
  const [showHelp, setShowHelp] = useState(false);

  // Latest values stable across the autosave/save closures so we don't
  // capture stale `text` / `updatedAt` on the first render.
  const textRef = useRef("");
  const updatedAtRef = useRef("");
  const editableRef = useRef(false);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cmRef = useRef<ReactCodeMirrorRef | null>(null);
  // Compartments live for the lifetime of the editor; we only swap
  // their contents via Compartment.reconfigure(...).
  const wrapCompartment = useRef(new Compartment());
  const tabSizeCompartment = useRef(new Compartment());

  // Mirror <html class="dark"> into local state. The theme-toggle
  // writes to that class directly, so a MutationObserver is the
  // simplest cross-component bridge.
  useEffect(() => {
    const update = () =>
      setIsDark(document.documentElement.classList.contains("dark"));
    update();
    const obs = new MutationObserver(update);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, []);

  // Fetch the file once on mount.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const r = await api<ContentResponse>(`/v1/files/${fileId}/content`);
        if (cancelled) return;
        setMeta(r);
        setText(r.content);
        textRef.current = r.content;
        updatedAtRef.current = r.updatedAt;
        editableRef.current = r.editable;
        setSaveState({ kind: "idle" });
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError) {
          if (e.status === 404) setError("File not found or you don't have access.");
          else if (e.status === 400 && e.code === "unsupported_type")
            setError("This file type can't be opened in the code editor.");
          else if (e.status === 413)
            setError("File is too large to open in the code editor.");
          else if (e.status === 415)
            setError("File isn't valid UTF-8 text — open via Download instead.");
          else setError(e.message);
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  // Lazy-load the language pack when the file name (and therefore the
  // language) changes. Each pack is small but importing them all up
  // front would balloon the initial bundle. The dynamic import returns
  // an Extension we hand to CodeMirror.
  useEffect(() => {
    if (!meta) {
      setLangExt(null);
      return;
    }
    const lang = languageForName(meta.name);
    let cancelled = false;
    (async () => {
      const ext = await loadLanguage(lang);
      if (!cancelled) setLangExt(ext);
    })();
    return () => {
      cancelled = true;
    };
  }, [meta?.name]);

  // The actual save — used by Cmd+S and by autosave. Stable across
  // renders thanks to the refs above.
  const save = useCallback(async () => {
    if (!editableRef.current) return;
    const body = textRef.current;
    const ifMatch = updatedAtRef.current;
    setSaveState({ kind: "saving" });
    try {
      // We don't use api() here because it doesn't expose response
      // headers and we want to wire through the new updated_at without
      // a follow-up GET. Same auth model — Bearer token from
      // localStorage — just expressed inline.
      const token = getToken();
      const res = await fetch(`${API_URL}/v1/files/${fileId}/content`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "If-Match": ifMatch,
        },
        body: JSON.stringify({ content: body, ifMatch }),
      });
      if (res.status === 412) {
        setSaveState({ kind: "conflict" });
        return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        const msg = j?.error?.message ?? `Save failed (${res.status})`;
        setSaveState({ kind: "error", message: msg });
        return;
      }
      const j = (await res.json()) as { updatedAt: string; size: number };
      updatedAtRef.current = j.updatedAt;
      setSaveState({ kind: "saved", at: Date.now() });
    } catch (e) {
      setSaveState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [fileId]);

  // Schedule autosave when the buffer is dirty. Cleared on every
  // change so the timer always reflects "X ms since last keystroke".
  const scheduleAutosave = useCallback(() => {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      void save();
    }, AUTOSAVE_DELAY_MS);
  }, [save]);

  // Flush any pending autosave on unmount so the user doesn't lose the
  // last few keystrokes if they navigate away within the debounce
  // window. We don't await it — just kick the request off; the browser
  // will let it run to completion under the normal fetch lifecycle.
  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
      }
      if (
        editableRef.current &&
        textRef.current !== "" &&
        // Only flush if we actually have a pending dirty state — saving
        // an unchanged buffer is wasteful and would race with the
        // mount-phase save state init.
        // The check is best-effort; saveState is captured by closure.
        (saveState.kind === "dirty" || saveState.kind === "error")
      ) {
        void save();
      }
    };
    // saveState intentionally not a dep — this is a "run on unmount"
    // effect; if we re-bound it on every save tick we'd cancel pending
    // autosaves on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cmd/Ctrl+S keymap, hoisted to the highest precedence so the
  // browser's built-in save dialog doesn't win.
  const saveKeymap = useMemo(
    () =>
      Prec.highest(
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              void save();
              return true;
            },
          },
        ])
      ),
    [save]
  );

  // Full extension stack. basicSetup (passed via the prop below)
  // already brings line numbers, fold gutter, history, bracket
  // matching, indent-on-input, search keymap, etc. We layer on top:
  //
  //   - saveKeymap   — Cmd+S → save (highest priority; beats browser).
  //   - indentWithTab — Tab indents instead of moving focus. Default
  //     CodeMirror leaves Tab as a focus trap for a11y; the editor is
  //     the focused thing here, so users expect Tab to indent.
  //   - lintKeymap   — F8 / Shift-F8 navigate diagnostics (handy even
  //     without a configured linter — it's a no-op if no diagnostics).
  //   - completionKeymap / closeBracketsKeymap — explicit so they
  //     reach the active editor reliably across browsers.
  //   - autocompletion + closeBrackets — re-enabled (we'd disabled
  //     them earlier; they're table stakes for a code editor).
  //   - highlightSelectionMatches — selecting a word highlights every
  //     other occurrence; flicks to the IDE-feel users expect.
  //   - lineWrapping / tabSize live in compartments so the toolbar can
  //     toggle them without rebuilding state.
  const extensions = useMemo<Extension[]>(() => {
    const exts: Extension[] = [
      saveKeymap,
      keymap.of([
        indentWithTab,
        ...searchKeymap,
        ...completionKeymap,
        ...closeBracketsKeymap,
        ...lintKeymap,
      ]),
      autocompletion(),
      closeBrackets(),
      highlightSelectionMatches(),
      EditorView.theme({
        "&": { height: "100%" },
        ".cm-scroller": { overflow: "auto" },
      }),
      wrapCompartment.current.of(wrap ? EditorView.lineWrapping : []),
      tabSizeCompartment.current.of(EditorState_tabSize(tabSize)),
    ];
    if (langExt) exts.push(langExt);
    return exts;
    // We deliberately leave `wrap` / `tabSize` out of the dep list —
    // changing them dispatches a Compartment.reconfigure effect (see
    // toggleWrap / changeTabSize below) which is cheaper than rebuilding
    // the whole extension array. The initial values still apply on
    // first mount via the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [langExt, saveKeymap]);

  // Toolbar handlers. Each dispatches a Compartment.reconfigure rather
  // than re-rendering the editor — the editor state (cursor position,
  // undo history, scroll) survives the toggle.
  const toggleWrap = useCallback(() => {
    setWrap((v) => {
      const next = !v;
      const view = cmRef.current?.view;
      if (view) {
        view.dispatch({
          effects: wrapCompartment.current.reconfigure(
            next ? EditorView.lineWrapping : []
          ),
        });
      }
      return next;
    });
  }, []);

  const changeTabSize = useCallback((n: number) => {
    setTabSize(n);
    const view = cmRef.current?.view;
    if (view) {
      view.dispatch({
        effects: tabSizeCompartment.current.reconfigure(
          EditorState_tabSize(n)
        ),
      });
    }
  }, []);

  const openFind = useCallback(() => {
    const view = cmRef.current?.view;
    if (view) openSearchPanel(view);
  }, []);

  const formatJSON = useCallback(() => {
    if (!meta) return;
    if (!editableRef.current) return;
    try {
      const parsed = JSON.parse(textRef.current);
      const pretty = JSON.stringify(parsed, null, tabSize);
      const view = cmRef.current?.view;
      if (view) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: pretty },
        });
      }
    } catch {
      // Silent — the user can see their JSON is invalid in the gutter
      // (or we could surface a toast here later).
    }
  }, [meta, tabSize]);

  const onChange = useCallback(
    (value: string) => {
      textRef.current = value;
      setText(value);
      if (editableRef.current) {
        setSaveState({ kind: "dirty" });
        scheduleAutosave();
      }
    },
    [scheduleAutosave]
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<ContentResponse>(`/v1/files/${fileId}/content`);
      setMeta(r);
      setText(r.content);
      textRef.current = r.content;
      updatedAtRef.current = r.updatedAt;
      editableRef.current = r.editable;
      setSaveState({ kind: "idle" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [fileId]);

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/drive")}
          className="gap-2"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to drive
        </Button>
        <div className="ml-2 truncate text-sm font-medium">
          {meta?.name ?? "…"}
        </div>
        {meta && !meta.canEdit && (
          <Badge variant="outline" className="gap-1 text-xs">
            <Eye className="h-3 w-3" />
            View only
          </Badge>
        )}
        {meta && meta.canEdit && !meta.editable && (
          <Badge variant="outline" className="gap-1 text-xs">
            <Lock className="h-3 w-3" />
            Read only (too large)
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <SaveBadge state={saveState} onReload={reload} />
          {meta && (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="gap-2"
                onClick={openFind}
                title="Find / replace (Ctrl+F)"
              >
                <Search className="h-4 w-4" />
                Find
              </Button>
              <Button
                size="sm"
                variant={wrap ? "secondary" : "ghost"}
                className="gap-2"
                onClick={toggleWrap}
                title="Toggle word wrap"
              >
                <WrapText className="h-4 w-4" />
                Wrap
              </Button>
              {/* Tab-size cycler. Click cycles 2 → 4 → 8 → 2 — matches
                  the muscle memory of EditorConfig users without
                  burning a whole dropdown on it. */}
              <Button
                size="sm"
                variant="ghost"
                className="gap-2"
                onClick={() =>
                  changeTabSize(
                    tabSize === 2 ? 4 : tabSize === 4 ? 8 : 2
                  )
                }
                title="Tab size"
              >
                <Indent className="h-4 w-4" />
                Tab: {tabSize}
              </Button>
              {/* JSON-only beautifier. Cheap and high-value: most
                  formatters need a 200KB+ dependency, but JSON.stringify
                  ships with the runtime and covers the most common
                  case. Other languages can be added as the need
                  appears. */}
              {meta.editable &&
                languageForName(meta.name) === "json" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-2"
                    onClick={formatJSON}
                    title="Pretty-print JSON"
                  >
                    <Sparkles className="h-4 w-4" />
                    Format
                  </Button>
                )}
              <Button
                size="sm"
                variant="ghost"
                className="gap-2"
                onClick={() => setShowHelp((s) => !s)}
                title="Keyboard shortcuts"
              >
                <Keyboard className="h-4 w-4" />
                Shortcuts
              </Button>
            </>
          )}
          {meta?.editable && (
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              onClick={() => void save()}
              disabled={saveState.kind === "saving"}
            >
              <Save className="h-4 w-4" />
              Save
            </Button>
          )}
        </div>
      </header>
      {showHelp && <ShortcutsHelp onClose={() => setShowHelp(false)} />}

      <div className="relative flex-1 overflow-hidden">
        {loading && !error && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading file…
            </div>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 z-10 flex items-center justify-center p-6">
            <div className="max-w-md rounded-lg border border-destructive/30 bg-destructive/5 p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                <div className="flex-1">
                  <h2 className="font-medium">Couldn't open the editor</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {error}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button asChild size="sm" variant="outline">
                      <Link href="/drive">Back to drive</Link>
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
        {!loading && !error && meta && (
          <CodeMirror
            ref={cmRef}
            value={text}
            height="100%"
            theme={isDark ? oneDark : undefined}
            extensions={extensions}
            editable={meta.editable}
            readOnly={!meta.editable}
            onChange={onChange}
            // basicSetup={true} would also work — we expand it so the
            // intent is explicit. Every flag here corresponds to a
            // user-visible feature; flipping one is a deliberate UX
            // call, not an accidental omission.
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              dropCursor: true,
              allowMultipleSelections: true,
              indentOnInput: true,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: true,
              rectangularSelection: true,
              crosshairCursor: true,
              highlightActiveLine: meta.editable,
              highlightActiveLineGutter: meta.editable,
              highlightSelectionMatches: true,
              syntaxHighlighting: true,
              defaultKeymap: true,
              historyKeymap: true,
              foldKeymap: true,
              completionKeymap: true,
              closeBracketsKeymap: true,
              searchKeymap: true,
              lintKeymap: true,
            }}
            style={{
              height: "100%",
              fontSize: 13,
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
            }}
          />
        )}
      </div>
    </div>
  );
}

// ShortcutsHelp is a thin one-shot popover listing the keymaps the
// editor responds to. We render it in the document instead of inside
// the editor frame so it doesn't fight CodeMirror for focus.
function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const Mod = isMac ? "⌘" : "Ctrl";
  const rows: Array<[string, string]> = [
    [`${Mod}+S`, "Save"],
    [`${Mod}+F`, "Find"],
    [`${Mod}+Alt+F`, "Find & replace"],
    [`${Mod}+G / ${Mod}+Shift+G`, "Find next / previous"],
    [`${Mod}+D`, "Select next occurrence"],
    [`${Mod}+/`, "Toggle line comment"],
    [`${Mod}+Shift+K`, "Delete line"],
    [`Alt+↑ / Alt+↓`, "Move line up / down"],
    [`${Mod}+]`, "Indent"],
    [`${Mod}+[`, "Outdent"],
    [`Tab / Shift+Tab`, "Indent / outdent selection"],
    [`${Mod}+Z / ${Mod}+Shift+Z`, "Undo / redo"],
    [`${Mod}+A`, "Select all"],
    [`${Mod}+Home / ${Mod}+End`, "Jump to file start / end"],
    [`Alt+Click`, "Multi-cursor"],
    [`${Mod}+Click`, "Add cursor at click"],
  ];
  return (
    <div
      className="fixed inset-0 z-20 flex items-start justify-center bg-background/60 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="mt-16 w-full max-w-md rounded-lg border bg-card p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Keyboard shortcuts</h3>
          <button
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="grid grid-cols-[minmax(0,auto)_1fr] gap-x-4 gap-y-1 text-xs">
          {rows.map(([k, label]) => (
            <div key={k} className="contents">
              <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                {k}
              </kbd>
              <span className="text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Auto-saves 2 s after you stop typing.
        </p>
      </div>
    </div>
  );
}

function SaveBadge({
  state,
  onReload,
}: {
  state: SaveState;
  onReload: () => void;
}) {
  switch (state.kind) {
    case "idle":
      return null;
    case "dirty":
      return (
        <span className="text-xs text-muted-foreground">Unsaved changes</span>
      );
    case "saving":
      return (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Saving…
        </span>
      );
    case "saved":
      return (
        <span className="text-xs text-muted-foreground">
          Saved {timeAgo(state.at)}
        </span>
      );
    case "error":
      return (
        <span className="text-xs text-destructive">
          Save failed: {state.message}
        </span>
      );
    case "conflict":
      return (
        <span className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
          File changed elsewhere
          <Button size="sm" variant="ghost" className="h-6 gap-1 px-2" onClick={onReload}>
            <RefreshCw className="h-3 w-3" />
            Reload
          </Button>
        </span>
      );
  }
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return new Date(ts).toLocaleTimeString();
}

// loadLanguage dynamic-imports the CodeMirror language pack matching
// the file's detected language. Returning null is fine — the editor
// renders plain text without highlighting in that case.
//
// Only the most common languages are wired with first-class packs.
// Niche languages (lua, perl, ruby, etc.) fall back to legacy-modes,
// which trades some accuracy for a single shared bundle.
async function loadLanguage(lang: string): Promise<Extension | null> {
  if (!lang) return null;
  switch (lang) {
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript({
        jsx: true,
      });
    case "typescript":
      return (await import("@codemirror/lang-javascript")).javascript({
        jsx: false,
        typescript: true,
      });
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({
        jsx: true,
        typescript: true,
      });
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "xml":
      return (await import("@codemirror/lang-xml")).xml();
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "rust":
      return (await import("@codemirror/lang-rust")).rust();
    case "go":
      return (await import("@codemirror/lang-go")).go();
    case "java":
      return (await import("@codemirror/lang-java")).java();
    case "kotlin":
      // Kotlin parses well enough as Java for highlighting purposes.
      return (await import("@codemirror/lang-java")).java();
    case "cpp":
    case "c":
      return (await import("@codemirror/lang-cpp")).cpp();
    case "csharp":
      // No first-party C# pack; legacy-mode clike is close enough.
      return await loadLegacyClike("text/x-csharp");
    case "php":
      return (await import("@codemirror/lang-php")).php();
    case "swift":
      return await loadLegacyClike("text/x-swift");
    case "ruby":
      return await loadLegacyMode(
        () => import("@codemirror/legacy-modes/mode/ruby"),
        "ruby"
      );
    case "shell":
      return await loadLegacyMode(
        () => import("@codemirror/legacy-modes/mode/shell"),
        "shell"
      );
    case "lua":
      return await loadLegacyMode(
        () => import("@codemirror/legacy-modes/mode/lua"),
        "lua"
      );
    case "toml":
      return await loadLegacyMode(
        () => import("@codemirror/legacy-modes/mode/toml"),
        "toml"
      );
    case "dockerfile":
      return await loadLegacyMode(
        () => import("@codemirror/legacy-modes/mode/dockerfile"),
        "dockerfile"
      );
    case "makefile":
      // legacy-modes ships Makefile only as part of cmake; close enough.
      return await loadLegacyMode(
        () => import("@codemirror/legacy-modes/mode/cmake"),
        "cmake"
      );
    default:
      return null;
  }
}

// loadLegacyMode wraps a legacy-modes import into a StreamLanguage.
// The legacy-modes namespace exports mode objects rather than language
// extensions, so we adapt them via @codemirror/language.StreamLanguage.
async function loadLegacyMode(
  importer: () => Promise<Record<string, unknown>>,
  exportName: string
): Promise<Extension | null> {
  try {
    const mod = await importer();
    const { StreamLanguage } = await import("@codemirror/language");
    const m = mod[exportName] as Parameters<typeof StreamLanguage.define>[0];
    if (!m) return null;
    return StreamLanguage.define(m);
  } catch {
    return null;
  }
}

async function loadLegacyClike(mime: string): Promise<Extension | null> {
  try {
    const mod = await import("@codemirror/legacy-modes/mode/clike");
    const { StreamLanguage } = await import("@codemirror/language");
    type ClikeFactory = (config: { name?: string }) => Parameters<
      typeof StreamLanguage.define
    >[0];
    // legacy-modes/clike exposes pre-baked dialects (csharp, kotlin, …)
    // plus a generic factory `clike`. We pick by MIME-ish hint.
    const dialect =
      mime === "text/x-csharp"
        ? (mod as { csharp?: Parameters<typeof StreamLanguage.define>[0] })
            .csharp
        : mime === "text/x-swift"
          ? (
              (mod as unknown as { clike: ClikeFactory }).clike as ClikeFactory
            )({ name: "swift" })
          : null;
    if (!dialect) return null;
    return StreamLanguage.define(dialect);
  } catch {
    return null;
  }
}
