"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Book,
  Calculator,
  ChevronDown,
  Code2,
  Eye,
  Globe,
  Globe2,
  History,
  Keyboard,
  LayoutGrid,
  Mail,
  PlayCircle,
  Save,
  Settings2,
  Sparkles,
  Tag,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { api } from "@/lib/api";
import { runGenerate } from "@/lib/generate";
import { GeneratedPreviewDialog } from "@/components/generated-preview-dialog";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RichEditor } from "@/components/ui/rich-editor";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PageLayoutDialog } from "@/components/page-layout-dialog";
import {
  ComputedFieldsDialog,
  type ComputedDef,
} from "@/components/computed-fields-dialog";
import {
  TranslationsDialog,
  type Translations,
} from "@/components/translations-dialog";
import { FormLinksDialog } from "@/components/form-links-dialog";
import { SendEmailDialog } from "@/components/send-email-dialog";
import { CollabDrawer } from "@/components/collab-drawer";
import type { PageLayout } from "@/lib/layout";
import { cn } from "@/lib/utils";
import { MessageSquare } from "lucide-react";
import {
  CommandPalette,
  type Command,
} from "@/components/designer/command-palette";
import { ShortcutHelp, modSymbol } from "@/components/designer/shortcut-help";
import { InlineRenameTitle } from "@/components/designer/inline-rename-title";

type Template = {
  id: string;
  name: string;
  mode: string;
  version: number;
  config: {
    placeholders?: string[];
    pageLayout?: PageLayout;
    computed?: ComputedDef[];
    locale?: string;
    locales?: string[];
    translations?: Record<string, Record<string, string>>;
  };
};

type Props = { tpl: Template };
type EditorTab = "design" | "code";

export default function HtmlDesigner({ tpl: initialTpl }: Props) {
  const toast = useToast();
  const [tpl, setTpl] = useState(initialTpl);
  const [source, setSource] = useState("");
  const [sampleJSON, setSampleJSON] = useState("{}");
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<EditorTab>("design");
  const [genOpen, setGenOpen] = useState(false);
  const [genAsync, setGenAsync] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genProgress, setGenProgress] = useState<string | null>(null);
  const [genData, setGenData] = useState("{}");
  // Post-generate preview — replaces the old `window.open(downloadUrl)`
  // auto-download. The dialog shows the rendered PDF and gives the user
  // explicit Download / Share / Open-in-Drive choices.
  const [genResult, setGenResult] = useState<{
    downloadUrl: string;
    outputFileId?: string;
    fileName: string;
  } | null>(null);
  const [previewHTML, setPreviewHTML] = useState<string>("");
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [sourceLoaded, setSourceLoaded] = useState(false);
  // Default the syntax cheatsheet closed — it's intimidating code for
  // non-technical users. Advanced users can still expand it with one click.
  const [cheatOpen, setCheatOpen] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [savingLayout, setSavingLayout] = useState(false);
  const [computedOpen, setComputedOpen] = useState(false);
  const [savingComputed, setSavingComputed] = useState(false);
  const [i18nOpen, setI18nOpen] = useState(false);
  const [savingI18n, setSavingI18n] = useState(false);
  const [formLinksOpen, setFormLinksOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [collabOpen, setCollabOpen] = useState(false);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [autoSave, setAutoSave] = useState(true);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const codeTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await api<{ source: string }>(
          `/v1/templates/${tpl.id}/source`
        );
        setSource(r.source);
        setSourceLoaded(true);
        setSampleJSON(
          JSON.stringify(skeleton(tpl.config.placeholders || []), null, 2)
        );
      } catch (e: any) {
        toast.show("error", e.message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tpl.id]);

  // Debounced server-side preview: POSTs to /v1/templates/{id}/preview with the
  // current source + parsed sample data. The server runs the full Go template
  // engine, so {{if}}/{{range}}/{{with}} render correctly.
  useEffect(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(async () => {
      let data: any = {};
      try {
        data = JSON.parse(sampleJSON);
      } catch {
        setPreviewErr("Sample data is not valid JSON");
        return;
      }
      try {
        const r = await api<{ html: string; error?: string }>(
          `/v1/templates/${tpl.id}/preview`,
          { method: "POST", body: JSON.stringify({ data, source }) }
        );
        if (r.error) {
          setPreviewErr(r.error);
        } else {
          setPreviewErr(null);
        }
        setPreviewHTML(r.html);
      } catch (e: any) {
        setPreviewErr(e.message);
      }
    }, 400);
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [source, sampleJSON, tpl.id]);

  async function saveI18n(next: Translations) {
    setSavingI18n(true);
    try {
      const merged = {
        ...(tpl.config || {}),
        locale: next.locale,
        locales: next.locales,
        translations: next.translations,
      };
      const r = await api<{ version: number }>(
        `/v1/templates/${tpl.id}/config`,
        { method: "PUT", body: JSON.stringify({ config: merged }) }
      );
      setTpl({ ...tpl, version: r.version, config: merged });
      toast.show("success", "Translations saved");
      setI18nOpen(false);
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setSavingI18n(false);
    }
  }

  async function saveComputed(defs: ComputedDef[]) {
    setSavingComputed(true);
    try {
      const merged = { ...(tpl.config || {}), computed: defs };
      const r = await api<{ version: number }>(
        `/v1/templates/${tpl.id}/config`,
        { method: "PUT", body: JSON.stringify({ config: merged }) }
      );
      setTpl({ ...tpl, version: r.version, config: merged });
      toast.show("success", "Computed fields saved");
      setComputedOpen(false);
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setSavingComputed(false);
    }
  }

  async function savePageLayout(next: PageLayout) {
    setSavingLayout(true);
    try {
      const merged = { ...(tpl.config || {}), pageLayout: next };
      const r = await api<{ version: number }>(
        `/v1/templates/${tpl.id}/config`,
        { method: "PUT", body: JSON.stringify({ config: merged }) }
      );
      setTpl({ ...tpl, version: r.version, config: merged });
      toast.show("success", "Page layout saved");
      setLayoutOpen(false);
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setSavingLayout(false);
    }
  }

  async function save(forceOverwrite = false) {
    setSaving(true);
    try {
      const body: any = { source };
      if (!forceOverwrite) body.expectedVersion = tpl.version;
      const r = await api<{ version: number; placeholders: string[] }>(
        `/v1/templates/${tpl.id}/source`,
        { method: "PUT", body: JSON.stringify(body) }
      );
      setTpl({
        ...tpl,
        version: r.version,
        config: { ...tpl.config, placeholders: r.placeholders },
      });
      toast.show("success", `Saved v${r.version}`);
    } catch (e: any) {
      if (/version_conflict|409/.test(e.message || "")) {
        const overwrite = window.confirm(
          "Another collaborator saved this template while you were editing. Overwrite their changes?\n\n" +
            "Click OK to overwrite, or Cancel to reload their version (you'll need to re-apply your edits)."
        );
        if (overwrite) {
          await save(true);
        } else {
          // reload source from server
          try {
            const r = await api<{ source: string }>(
              `/v1/templates/${tpl.id}/source`
            );
            setSource(r.source);
            toast.show("info", "Reloaded latest version");
          } catch {}
        }
      } else {
        toast.show("error", e.message);
      }
    } finally {
      setSaving(false);
      setLastSavedAt(new Date());
    }
  }

  // Insert a placeholder / snippet into whichever editor the user is in.
  // Previously this always forced a switch to the HTML tab, which was
  // jarring for non-technical users who live in the Design view.  Now:
  //   • Design tab → append to source so TinyMCE reconciles via its
  //     controlled `value` prop
  //   • HTML tab   → splice into the textarea at the caret
  function insertAtCursor(text: string) {
    if (tab === "code") {
      doInsert(text);
      return;
    }
    // Design tab (TinyMCE): no imperative handle currently wired, so
    // append to source. The rich editor reads `value` via controlled
    // prop and will reconcile.
    setSource((s) => s + text);
  }
  function doInsert(text: string) {
    const ta = codeTextareaRef.current;
    if (!ta) {
      setSource((s) => s + text);
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const next = source.slice(0, start) + text + source.slice(end);
    setSource(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = start + text.length;
    });
  }

  // Human-friendly label for a dotted placeholder path. Shared with the
  // Data fields sidebar so non-technical users see "Merchant › Name"
  // instead of "merchant.name".
  function friendlyFieldLabel(path: string): string {
    return path
      .split(".")
      .map((s) =>
        s
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .replace(/^./, (c) => c.toUpperCase())
      )
      .join(" › ");
  }

  // Autosave — debounced 2s after the last edit. Skips the first render
  // (freshly-loaded source) so we don't save immediately on mount.
  const firstSaveRender = useRef(true);
  useEffect(() => {
    if (firstSaveRender.current) {
      firstSaveRender.current = false;
      return;
    }
    if (!autoSave) return;
    if (!sourceLoaded) return;
    const t = setTimeout(() => {
      save(false);
    }, 2000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, autoSave, sourceLoaded]);

  // Keyboard: Cmd+S save, Cmd+K palette, ? help. Suppress when typing
  // inside inputs unless it's the modifier-based shortcut itself.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save(false);
        return;
      }
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      const t = e.target as HTMLElement | null;
      const inField =
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable);
      if (!inField && e.key === "?") {
        e.preventDefault();
        setHelpOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openGenerate() {
    setGenData(
      JSON.stringify(skeleton(tpl.config.placeholders || []), null, 2)
    );
    setGenOpen(true);
  }

  async function runGenerateFlow() {
    setGenBusy(true);
    setGenProgress(null);
    try {
      const data = JSON.parse(genData);
      const result = await runGenerate(tpl.id, {
        data,
        async: genAsync,
        onProgress: setGenProgress,
      });
      // Replace the old auto-download with an in-app preview. The file
      // is already persisted to Drive as `outputFileId`, so Share /
      // Open-in-Drive work from the preview dialog.
      setGenResult({
        downloadUrl: result.downloadUrl,
        outputFileId: result.outputFileId,
        fileName: `${tpl.name}.pdf`,
      });
      setGenOpen(false);
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setGenBusy(false);
      setGenProgress(null);
    }
  }

  const placeholders = tpl.config.placeholders || [];

  return (
    <div className="flex min-h-screen flex-col">
      <TooltipProvider delayDuration={200}>
        <header className="sticky top-0 z-40 border-b bg-background/80 px-3 md:px-5 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="flex items-center gap-3">
            {/* Left: back + title --------------------------------------- */}
            <div className="flex min-w-0 items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    asChild
                  >
                    <Link href="/drive" aria-label="Back to Drive">
                      <ArrowLeft className="h-4 w-4" />
                    </Link>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Back to Drive</TooltipContent>
              </Tooltip>
              <Separator orientation="vertical" className="h-6" />
              <div className="min-w-0">
                <InlineRenameTitle
                  templateId={tpl.id}
                  name={tpl.name}
                  onRenamed={(n) =>
                    setTpl((prev) => ({ ...prev, name: n }))
                  }
                  className="text-sm font-semibold leading-tight"
                />
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Badge
                    variant="outline"
                    className="h-4 px-1.5 uppercase text-[9px] font-semibold tracking-wide"
                  >
                    HTML
                  </Badge>
                  <span>v{tpl.version}</span>
                  {autoSave && lastSavedAt ? (
                    <>
                      <span aria-hidden>·</span>
                      <span className="text-emerald-600 dark:text-emerald-400">
                        Saved
                      </span>
                    </>
                  ) : null}
                </div>
              </div>
            </div>

            {/* Right: action groups ------------------------------------- */}
            <div className="ml-auto flex items-center gap-1">
              {/* Utility (icon-only; always visible, labels live in tooltips) */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setPaletteOpen(true)}
                  >
                    <LayoutGrid className="h-4 w-4" />
                    <span className="sr-only">Command palette</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Command palette ({modSymbol()}K)
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setHelpOpen(true)}
                  >
                    <Keyboard className="h-4 w-4" />
                    <span className="sr-only">Keyboard shortcuts</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Keyboard shortcuts (?)</TooltipContent>
              </Tooltip>

              <Separator orientation="vertical" className="mx-1 h-6" />

              {/* Configure dropdown — all template-level settings live here */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="gap-1.5">
                    <Settings2 className="h-4 w-4" />
                    <span className="hidden sm:inline">Configure</span>
                    {(tpl.config?.computed?.length ?? 0) +
                      ((tpl.config?.locales?.length ?? 1) > 1
                        ? tpl.config!.locales!.length
                        : 0) >
                    0 ? (
                      <Badge
                        variant="secondary"
                        className="ml-0.5 h-4 px-1.5 text-[10px]"
                      >
                        {(tpl.config?.computed?.length ?? 0) +
                          ((tpl.config?.locales?.length ?? 1) > 1
                            ? tpl.config!.locales!.length
                            : 0)}
                      </Badge>
                    ) : null}
                    <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>Template</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => setLayoutOpen(true)}>
                    <Settings2 className="mr-2 h-4 w-4" />
                    Page layout
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setComputedOpen(true)}>
                    <Calculator className="mr-2 h-4 w-4" />
                    Computed fields
                    {tpl.config?.computed && tpl.config.computed.length > 0 ? (
                      <Badge
                        variant="secondary"
                        className="ml-auto h-4 px-1.5 text-[10px]"
                      >
                        {tpl.config.computed.length}
                      </Badge>
                    ) : null}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setI18nOpen(true)}>
                    <Globe className="mr-2 h-4 w-4" />
                    Translations
                    {tpl.config?.locales && tpl.config.locales.length > 1 ? (
                      <Badge
                        variant="secondary"
                        className="ml-auto h-4 px-1.5 text-[10px]"
                      >
                        {tpl.config.locales.length}
                      </Badge>
                    ) : null}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Distribution</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => setFormLinksOpen(true)}>
                    <Globe2 className="mr-2 h-4 w-4" />
                    Share form
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href={`/templates/${tpl.id}/versions`}>
                      <History className="mr-2 h-4 w-4" />
                      Version history
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href={`/templates/${tpl.id}/playground`}>
                      <Sparkles className="mr-2 h-4 w-4" />
                      Playground
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Collaborate — kept outside the menu because it's social/live */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => setCollabOpen(true)}
                  >
                    <MessageSquare className="h-4 w-4" />
                    <span className="hidden md:inline">Collaborate</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="md:hidden">
                  Collaborate
                </TooltipContent>
              </Tooltip>

              <Separator orientation="vertical" className="mx-1 h-6" />

              {/* Primary actions: Save → Send → Generate (visual weight ↑) */}
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => save(false)}
                loading={saving}
              >
                <Save className="h-4 w-4" />
                <span className="hidden sm:inline">
                  {autoSave && lastSavedAt ? "Saved" : "Save"}
                </span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setSendOpen(true)}
              >
                <Mail className="h-4 w-4" />
                <span className="hidden sm:inline">Send</span>
              </Button>
              <Button size="sm" className="gap-1.5" onClick={openGenerate}>
                <PlayCircle className="h-4 w-4" />
                Generate
              </Button>
            </div>
          </div>
        </header>
      </TooltipProvider>

      <div className="flex flex-1 min-h-0">
        {/* Left rail: placeholders + cheatsheet + helpers + sample data */}
        <aside className="hidden w-72 shrink-0 overflow-y-auto border-r bg-background p-4 lg:block">
          {/* Data fields — clickable inserts for non-technical users.
              Click to drop {{ .field }} at the cursor in the current tab. */}
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Tag className="mr-1 inline h-3 w-3" />
              Data fields
            </div>
            <Badge variant="secondary" className="text-[10px]">
              {placeholders.length}
            </Badge>
          </div>
          <p className="mb-3 text-[11px] leading-snug text-muted-foreground">
            Click a field to insert it where you're typing.
          </p>
          {placeholders.length === 0 ? (
            <p className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
              No fields yet. Add sample data below, then save — fields show up
              here automatically.
            </p>
          ) : (
            <ul className="space-y-1">
              {placeholders.map((p) => (
                <li key={p}>
                  <button
                    type="button"
                    onClick={() => insertAtCursor("{{ ." + p + " }}")}
                    title={`Insert {{ .${p} }}`}
                    className="group flex w-full items-center justify-between gap-2 rounded-md border bg-card px-2 py-1.5 text-left text-xs transition hover:border-primary/50 hover:bg-accent hover:text-accent-foreground"
                  >
                    <span className="truncate font-medium">
                      {friendlyFieldLabel(p)}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground group-hover:text-foreground">
                      {"{{ ." + p + " }}"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <Separator className="my-5" />

          {/* Cheatsheet */}
          <button
            type="button"
            onClick={() => setCheatOpen((o) => !o)}
            className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
          >
            <span className="inline-flex items-center">
              <Book className="mr-1 inline h-3 w-3" />
              Syntax cheatsheet
            </span>
            <span className="text-[10px]">{cheatOpen ? "−" : "+"}</span>
          </button>
          {cheatOpen && (
            <dl className="mt-2 space-y-1.5 text-[11px] leading-relaxed">
              {CHEATS.map((c) => (
                <div key={c.title}>
                  <dt className="font-medium text-foreground">{c.title}</dt>
                  <dd className="font-mono text-[10px] text-muted-foreground">
                    {c.example}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          <Separator className="my-5" />

          {/* Helper functions */}
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Wrench className="mr-1 inline h-3 w-3" />
            Helpers
          </div>
          <div className="flex flex-wrap gap-1">
            {HELPERS.map((h) => (
              <Badge
                key={h.name}
                variant="outline"
                className="font-mono text-[10px]"
                title={h.hint}
              >
                {h.name}
              </Badge>
            ))}
          </div>

          <Separator className="my-5" />

          <Label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Sample data (JSON)
          </Label>
          <textarea
            className="h-44 w-full resize-none rounded-md border bg-background p-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={sampleJSON}
            onChange={(e) => setSampleJSON(e.target.value)}
            spellCheck={false}
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            Drives the live preview on the right.
          </p>
        </aside>

        {/* Editor + preview */}
        <div className="flex flex-1 min-h-0">
          <section className="flex w-1/2 flex-col border-r bg-background min-h-0">
            <div className="flex items-center gap-1 border-b bg-background px-3 py-1.5">
              <span className="mr-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Editor
              </span>
              <TabButton
                active={tab === "design"}
                icon={<Sparkles className="h-3.5 w-3.5" />}
                onClick={() => setTab("design")}
              >
                Design
              </TabButton>
              <TabButton
                active={tab === "code"}
                icon={<Code2 className="h-3.5 w-3.5" />}
                onClick={() => setTab("code")}
              >
                HTML
              </TabButton>
              <span className="ml-auto text-xs text-muted-foreground">
                {source.length.toLocaleString()} chars
              </span>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              {tab === "design" ? (
                sourceLoaded ? (
                  <RichEditor
                    value={source}
                    onChange={setSource}
                    placeholders={placeholders}
                  />
                ) : (
                  <div className="p-4 text-xs text-muted-foreground">
                    Loading template…
                  </div>
                )
              ) : (
                <textarea
                  ref={codeTextareaRef}
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  spellCheck={false}
                  className="h-full w-full resize-none bg-background p-4 font-mono text-xs outline-none"
                  placeholder="<!doctype html><html>...</html>"
                />
              )}
            </div>
          </section>

          {/* Live preview — deliberately styled to look DIFFERENT from
              the Design tab so users know which pane is editable vs
              read-only. Design tab = raw document surface with {{ }}
              visible; preview = a paper-mockup with the sample data
              already filled in. The gray gutter + drop shadow + "PDF
              preview" banner signal "this is what the output will look
              like", not "this is where I type". */}
          <section className="flex w-1/2 flex-col bg-muted/40 min-h-0">
            <div className="flex items-center gap-1.5 border-b bg-background px-3 py-2 text-xs font-medium">
              <Eye className="h-3.5 w-3.5 text-primary" />
              <span className="text-foreground">PDF preview</span>
              <Badge variant="secondary" className="ml-1 h-5 text-[10px]">
                with sample data
              </Badge>
              {previewErr && (
                <span className="ml-2 inline-flex items-center gap-1 text-[10px] text-warning-foreground">
                  <TriangleAlert className="h-3 w-3" />
                  {previewErr}
                </span>
              )}
              <span className="ml-auto text-[10px] text-muted-foreground">
                Read-only · updates as you edit
              </span>
            </div>
            <div className="relative flex-1 min-h-0 overflow-auto bg-[repeating-linear-gradient(45deg,theme(colors.muted.DEFAULT)_0_12px,theme(colors.muted.DEFAULT/.6)_12px_24px)] p-6">
              <div className="mx-auto max-w-[850px] overflow-hidden rounded-md border bg-white shadow-[0_8px_24px_rgba(0,0,0,0.08),0_2px_4px_rgba(0,0,0,0.04)] dark:bg-zinc-50">
                <iframe
                  srcDoc={previewHTML}
                  className="block h-[1100px] w-full bg-white"
                  sandbox="allow-same-origin"
                  title="PDF preview"
                />
              </div>
              <p className="mx-auto mt-4 max-w-[850px] text-center text-[11px] text-muted-foreground">
                This is how your PDF will look when generated.
                Edit the left panel to make changes.
              </p>
            </div>
          </section>
        </div>
      </div>

      <Dialog open={genOpen} onOpenChange={(o) => !genBusy && setGenOpen(o)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Generate filled document</DialogTitle>
            <DialogDescription>
              Provide a JSON payload. Keys should match the placeholders used
              in the HTML.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <textarea
              className="h-64 w-full rounded-md border bg-background p-3 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={genData}
              onChange={(e) => setGenData(e.target.value)}
            />
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={genAsync}
                onChange={(e) => setGenAsync(e.target.checked)}
              />
              Run asynchronously (via worker queue)
            </label>
            {genProgress && (
              <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                Job: {genProgress}
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
            <Button onClick={runGenerateFlow} loading={genBusy}>
              <PlayCircle className="h-4 w-4" />
              Generate &amp; download
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PageLayoutDialog
        open={layoutOpen}
        onOpenChange={setLayoutOpen}
        value={tpl.config?.pageLayout}
        onSave={savePageLayout}
        busy={savingLayout}
      />

      <ComputedFieldsDialog
        open={computedOpen}
        onOpenChange={setComputedOpen}
        value={tpl.config?.computed}
        onSave={saveComputed}
        busy={savingComputed}
      />

      <TranslationsDialog
        open={i18nOpen}
        onOpenChange={setI18nOpen}
        value={{
          locale: tpl.config?.locale,
          locales: tpl.config?.locales,
          translations: tpl.config?.translations,
        }}
        onSave={saveI18n}
        busy={savingI18n}
      />

      <FormLinksDialog
        open={formLinksOpen}
        onOpenChange={setFormLinksOpen}
        templateId={tpl.id}
        templateName={tpl.name}
      />

      <SendEmailDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        templateId={tpl.id}
        templateName={tpl.name}
        placeholders={placeholders}
      />

      <CollabDrawer
        open={collabOpen}
        onOpenChange={setCollabOpen}
        templateId={tpl.id}
        templateName={tpl.name}
      />

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        commands={buildHtmlCommands({
          placeholders,
          insertAtCursor,
          setTab,
          setLayoutOpen,
          setI18nOpen,
          setComputedOpen,
          setFormLinksOpen,
          setSendOpen,
          setCollabOpen,
          setGenOpen,
          save,
          autoSave,
          setAutoSave,
          setHelpOpen,
        })}
      />
      <ShortcutHelp
        open={helpOpen}
        onOpenChange={setHelpOpen}
        shortcuts={[
          { keys: `${modSymbol()}K`, label: "Command palette", group: "General" },
          { keys: `${modSymbol()}S`, label: "Save now", group: "General" },
          { keys: "?", label: "Show shortcuts", group: "General" },
        ]}
      />
      {/* Post-generate preview — renders the freshly-generated PDF in
          an in-app dialog so the user can review, download, share, or
          jump to Drive without a surprise browser download. */}
      <GeneratedPreviewDialog
        open={!!genResult}
        onOpenChange={(o) => !o && setGenResult(null)}
        downloadUrl={genResult?.downloadUrl ?? null}
        outputFileId={genResult?.outputFileId}
        fileName={genResult?.fileName ?? `${tpl.name}.pdf`}
      />
    </div>
  );
}

// Commands exposed to the HTML designer palette. Kept out of the
// component body so the JSX stays readable.
function buildHtmlCommands(p: {
  placeholders: string[];
  insertAtCursor: (text: string) => void;
  setTab: (t: EditorTab) => void;
  setLayoutOpen: (o: boolean) => void;
  setI18nOpen: (o: boolean) => void;
  setComputedOpen: (o: boolean) => void;
  setFormLinksOpen: (o: boolean) => void;
  setSendOpen: (o: boolean) => void;
  setCollabOpen: (o: boolean) => void;
  setGenOpen: (o: boolean) => void;
  save: (force?: boolean) => void;
  autoSave: boolean;
  setAutoSave: React.Dispatch<React.SetStateAction<boolean>>;
  setHelpOpen: (o: boolean) => void;
}): Command[] {
  const M = modSymbol();
  const insertSnippets = [
    { label: "Insert if block", text: "{{ if .field }}\n  \n{{ end }}\n" },
    { label: "Insert range block", text: "{{ range .items }}\n  {{ . }}\n{{ end }}\n" },
    { label: "Insert with block", text: "{{ with .obj }}\n  {{ .field }}\n{{ end }}\n" },
    { label: "Insert comment", text: "{{/* comment */}}" },
  ];
  return [
    { id: "tab:design", label: "Switch to Design editor", group: "View", run: () => p.setTab("design") },
    { id: "tab:code", label: "Switch to HTML editor", group: "View", run: () => p.setTab("code") },
    { id: "file:save", label: "Save now", hint: `${M}S`, group: "File", run: () => p.save(false) },
    { id: "file:generate", label: "Generate document", group: "File", run: () => p.setGenOpen(true) },
    {
      id: "view:autosave",
      label: p.autoSave ? "Disable auto-save" : "Enable auto-save",
      group: "File",
      run: () => p.setAutoSave((v) => !v),
    },
    { id: "view:layout", label: "Page layout", group: "Settings", run: () => p.setLayoutOpen(true) },
    { id: "view:i18n", label: "Translations", group: "Settings", run: () => p.setI18nOpen(true) },
    { id: "view:computed", label: "Computed fields", group: "Settings", run: () => p.setComputedOpen(true) },
    { id: "view:formlinks", label: "Public form links", group: "Share", run: () => p.setFormLinksOpen(true) },
    { id: "view:send", label: "Send via email", group: "Share", run: () => p.setSendOpen(true) },
    { id: "view:collab", label: "Open collaboration drawer", group: "Share", run: () => p.setCollabOpen(true) },
    ...p.placeholders.map((ph) => ({
      id: "ph:" + ph,
      label: "Insert placeholder: " + ph,
      group: "Insert placeholder",
      keywords: [ph],
      run: () => p.insertAtCursor(`{{ .${ph} }}`),
    })),
    ...insertSnippets.map((s) => ({
      id: "snip:" + s.label,
      label: s.label,
      group: "Insert snippet",
      run: () => p.insertAtCursor(s.text),
    })),
    { id: "help:shortcuts", label: "Keyboard shortcuts", hint: "?", group: "Help", run: () => p.setHelpOpen(true) },
  ];
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      {icon}
      {children}
    </button>
  );
}

const CHEATS: Array<{ title: string; example: string }> = [
  { title: "Placeholder", example: "{{ .name }}" },
  { title: "Dotted path", example: "{{ .customer.email }}" },
  { title: "Condition", example: "{{ if .paid }}Paid{{ end }}" },
  { title: "If / else", example: "{{ if .paid }}Paid{{ else }}Due{{ end }}" },
  { title: "Compare", example: '{{ if eq .status "active" }}…{{ end }}' },
  { title: "Loop", example: "{{ range .items }}{{ .name }}{{ end }}" },
  { title: "Indexed loop", example: "{{ range $i, $it := .items }}…{{ end }}" },
  { title: "Scope", example: "{{ with .customer }}{{ .name }}{{ end }}" },
  { title: "Pipe to helper", example: '{{ .amount | formatCurrency "USD" }}' },
];

const HELPERS: Array<{ name: string; hint: string }> = [
  { name: "upper", hint: "{{ .name | upper }} — uppercase a string" },
  { name: "lower", hint: "{{ .name | lower }} — lowercase a string" },
  { name: "formatDate", hint: '{{ .dob | formatDate "2006-01-02" }}' },
  { name: "formatCurrency", hint: '{{ .amount | formatCurrency "USD" }}' },
  { name: "formatNumber", hint: "{{ formatNumber .qty 2 }}" },
  { name: "default", hint: "{{ default \"N/A\" .maybe }}" },
  { name: "sum", hint: '{{ sum .items "amount" }} — sum a field across a slice' },
  { name: "join", hint: '{{ join .tags ", " }}' },
  { name: "contains", hint: '{{ if contains "admin" .roles }}…{{ end }}' },
  { name: "len", hint: "{{ len .items }}" },
  { name: "now", hint: '{{ now | formatDate "2006-01-02" }}' },
  { name: "t", hint: '{{ t "invoice.title" }} — locale translation lookup' },
  { name: "qrcode", hint: "{{ qrcode .url 200 }} — inline QR code" },
  { name: "barcode", hint: '{{ barcode .sku "code128" 300 80 }}' },
  { name: "signature", hint: "{{ signature .sig.image }} — sig image" },
  { name: "image", hint: "{{ image .photo.url }} — generic image helper" },
  { name: "chart", hint: '{{ chart .series "line" 480 280 }} — line / bar / pie / doughnut' },
];

// skeleton — build a realistic sample-data JSON so the live preview
// actually shows rendered output on first open instead of a stream of
// raw `{{ .merchant.name }}` placeholders. The old version seeded every
// placeholder with an empty string ("") which made the preview look
// broken to non-technical users: scalars rendered as blank, loops over
// unset arrays rendered as nothing, and because BlockNote sometimes
// round-trips `{{` as HTML entities the raw template text survived all
// the way to the iframe. Giving every known field a non-empty,
// type-appropriate default makes the preview legible out of the box
// and — crucially — demonstrates to the user what each placeholder
// *does*, so they don't have to read Go template syntax to understand
// their own template.
//
// The value heuristic is name-based (last path segment, lowercased).
// This is deliberately shallow — guessing from the path is better than
// empty strings and cheap enough that template authors just tweak the
// JSON if they want different samples. Anything not matched falls
// through to a generic "Sample …" string.
function skeleton(placeholders: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const p of placeholders) setDeep(out, p, sampleFor(p));
  return out;
}

// Plural heuristic → array. We don't have loop info from the extractor
// on this path (see ExtractSchema) so we guess from the final segment.
const PLURAL_HINTS = new Set([
  "items",
  "lines",
  "rows",
  "records",
  "entries",
  "products",
  "orders",
  "invoices",
  "customers",
  "users",
  "tags",
  "attachments",
  "photos",
  "files",
  "shipments",
  "payments",
  "transactions",
  "notes",
  "comments",
]);

function sampleFor(path: string): any {
  const leaf = (path.split(".").pop() || "").toLowerCase();

  // Array-like field names — seed with two sample rows so `range` blocks
  // produce visible output. The per-row shape is intentionally broad:
  // common names (.name, .qty, .amount) cover most receipt/invoice
  // layouts without hand-tuning.
  //
  // IMPORTANT: only the explicit PLURAL_HINTS set qualifies as an array.
  // The previous `/s$/` heuristic misfired on common singulars ("address",
  // "status", "business", "process", "success") → they got seeded as
  // arrays, and Go's template then dumped `[map[amount:19.99 …]]` into
  // the preview. A small whitelist is safer than a clever regex.
  if (PLURAL_HINTS.has(leaf)) {
    return [
      { name: "Sample item A", qty: 2, amount: 19.99, sku: "SKU-001" },
      { name: "Sample item B", qty: 1, amount: 29.99, sku: "SKU-002" },
    ];
  }

  // Date-ish
  if (/(at|date|on|time|expires|due|issued|paid|created|updated)$/.test(leaf)) {
    return new Date().toISOString();
  }

  // Money-ish
  if (/(amount|total|subtotal|price|cost|fee|tax|balance|due|paid)$/.test(leaf)) {
    return 49.99;
  }

  // Count-ish
  if (/(qty|quantity|count|number|num)$/.test(leaf)) return 1;

  // Known scalar patterns
  if (leaf === "email" || leaf.endsWith("email")) return "jane@example.com";
  if (leaf === "phone" || leaf.includes("phone")) return "+1 555 0100";
  if (leaf === "url" || leaf.endsWith("url") || leaf === "link") {
    return "https://example.com";
  }
  if (leaf === "id" || leaf.endsWith("id")) return "ORD-12345";
  if (leaf === "sku") return "SKU-001";
  if (leaf === "status") return "paid";
  if (leaf === "currency") return "USD";
  if (leaf === "method") return "Credit card";
  if (leaf === "cardlast4" || leaf === "last4") return "4242";
  if (leaf === "auth" || leaf === "authcode") return "AUTH-0001";
  if (leaf === "address") return "123 Main St, Springfield";
  if (leaf === "name" || leaf.endsWith("name")) return "Jane Doe";
  if (leaf === "description" || leaf === "notes" || leaf === "message") {
    return "Sample description text.";
  }
  if (leaf === "image" || leaf === "photo" || leaf === "logo") {
    return "https://via.placeholder.com/200";
  }

  // Generic fallback — a visible, readable label so nothing in the
  // preview ever looks like an unfilled slot.
  return `Sample ${leaf || "value"}`;
}

function setDeep(obj: Record<string, any>, path: string, value: any) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null)
      cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

