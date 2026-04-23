"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Book,
  Calculator,
  Eye,
  Globe,
  Globe2,
  Keyboard,
  LayoutGrid,
  Mail,
  History,
  PlayCircle,
  Save,
  Settings2,
  Sparkles,
  Tag,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { api, pollJob } from "@/lib/api";
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
import { MessageSquare } from "lucide-react";
import type { PageLayout } from "@/lib/layout";
import {
  CommandPalette,
  type Command,
} from "@/components/designer/command-palette";
import { ShortcutHelp, modSymbol } from "@/components/designer/shortcut-help";

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

export default function MarkdownDesigner({ tpl: initialTpl }: Props) {
  const toast = useToast();
  const [tpl, setTpl] = useState(initialTpl);
  const [source, setSource] = useState("");
  const [sampleJSON, setSampleJSON] = useState("{}");
  const [saving, setSaving] = useState(false);
  const [previewHTML, setPreviewHTML] = useState("");
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [cheatOpen, setCheatOpen] = useState(true);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [savingLayout, setSavingLayout] = useState(false);
  const [computedOpen, setComputedOpen] = useState(false);
  const [savingComputed, setSavingComputed] = useState(false);
  const [i18nOpen, setI18nOpen] = useState(false);
  const [savingI18n, setSavingI18n] = useState(false);
  const [formLinksOpen, setFormLinksOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [collabOpen, setCollabOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [genAsync, setGenAsync] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genProgress, setGenProgress] = useState<string | null>(null);
  const [genData, setGenData] = useState("{}");
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [autoSave, setAutoSave] = useState(true);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const sourceRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await api<{ source: string }>(
          `/v1/templates/${tpl.id}/source`
        );
        setSource(r.source);
        setSampleJSON(
          JSON.stringify(skeleton(tpl.config.placeholders || []), null, 2)
        );
      } catch (e: any) {
        toast.show("error", e.message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tpl.id]);

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
        setPreviewErr(r.error ?? null);
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
            "Click OK to overwrite, or Cancel to reload their version."
        );
        if (overwrite) {
          await save(true);
        } else {
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

  function insertAtCursor(text: string) {
    const ta = sourceRef.current;
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

  // Wrap the current selection in `before`/`after` — used for **bold**,
  // _italic_, and [link](url) shortcuts.
  function wrapSelection(before: string, after: string) {
    const ta = sourceRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const mid = source.slice(start, end);
    const next = source.slice(0, start) + before + mid + after + source.slice(end);
    setSource(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = start + before.length;
      ta.selectionEnd = start + before.length + mid.length;
    });
  }

  // Autosave — debounced 2s after the last edit.
  const firstSaveRender = useRef(true);
  useEffect(() => {
    if (firstSaveRender.current) {
      firstSaveRender.current = false;
      return;
    }
    if (!autoSave) return;
    const t = setTimeout(() => save(false), 2000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, autoSave]);

  // Keyboard: Cmd+S save, Cmd+K palette, ? help, Cmd+B bold, Cmd+I italic.
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
      // Markdown text shortcuts only apply when the editor textarea is
      // focused — otherwise don't steal Cmd+B from the browser.
      const active = document.activeElement;
      const inMd = active === sourceRef.current;
      if (inMd && mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        wrapSelection("**", "**");
        return;
      }
      if (inMd && mod && e.key.toLowerCase() === "i") {
        e.preventDefault();
        wrapSelection("_", "_");
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
  }, [source]);

  function openGenerate() {
    setGenData(
      JSON.stringify(skeleton(tpl.config.placeholders || []), null, 2)
    );
    setGenOpen(true);
  }

  async function runGenerate() {
    setGenBusy(true);
    setGenProgress(null);
    try {
      const data = JSON.parse(genData);
      const res = await api<{
        downloadUrl?: string;
        jobId?: string;
        outputFileId?: string;
      }>(`/v1/templates/${tpl.id}/generate`, {
        method: "POST",
        body: JSON.stringify({ data, async: genAsync }),
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
      toast.show("error", e.message);
    } finally {
      setGenBusy(false);
      setGenProgress(null);
    }
  }

  const placeholders = tpl.config.placeholders || [];

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
                  Markdown
                </Badge>
                <span className="text-xs text-muted-foreground">
                  v{tpl.version}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/templates/${tpl.id}/versions`}>
                <History className="h-4 w-4" />
                Versions
              </Link>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/templates/${tpl.id}/playground`}>
                <Sparkles className="h-4 w-4" />
                Playground
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFormLinksOpen(true)}
            >
              <Globe2 className="h-4 w-4" />
              Share form
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setI18nOpen(true)}
            >
              <Globe className="h-4 w-4" />
              i18n
              {tpl.config?.locales && tpl.config.locales.length > 1 ? (
                <Badge variant="secondary" className="text-[10px]">
                  {tpl.config.locales.length}
                </Badge>
              ) : null}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setComputedOpen(true)}
            >
              <Calculator className="h-4 w-4" />
              Computed
              {tpl.config?.computed && tpl.config.computed.length > 0 ? (
                <Badge variant="secondary" className="text-[10px]">
                  {tpl.config.computed.length}
                </Badge>
              ) : null}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLayoutOpen(true)}
            >
              <Settings2 className="h-4 w-4" />
              Layout
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPaletteOpen(true)}
              title={`Command palette (${modSymbol()}K)`}
            >
              <LayoutGrid className="h-4 w-4" />
              Commands
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHelpOpen(true)}
              title="Keyboard shortcuts (?)"
            >
              <Keyboard className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => save(false)} loading={saving}>
              <Save className="h-4 w-4" />
              {autoSave && lastSavedAt ? "Saved" : "Save"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCollabOpen(true)}
            >
              <MessageSquare className="h-4 w-4" />
              Collaborate
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSendOpen(true)}
            >
              <Mail className="h-4 w-4" />
              Send
            </Button>
            <Button size="sm" onClick={openGenerate}>
              <PlayCircle className="h-4 w-4" />
              Generate
            </Button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        <aside className="hidden w-72 shrink-0 overflow-y-auto border-r bg-background p-4 lg:block">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Tag className="mr-1 inline h-3 w-3" />
              Placeholders
            </div>
            <Badge variant="secondary" className="text-[10px]">
              {placeholders.length}
            </Badge>
          </div>
          {placeholders.length === 0 ? (
            <p className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
              Type <code className="font-mono text-xs">{"{{ .name }}"}</code>{" "}
              anywhere in the Markdown source, then save.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {placeholders.map((p) => (
                <li
                  key={p}
                  className="cursor-default rounded-md border bg-card px-2 py-1 font-mono text-xs"
                >
                  {"{{ ." + p + " }}"}
                </li>
              ))}
            </ul>
          )}

          <Separator className="my-5" />

          <button
            type="button"
            onClick={() => setCheatOpen((o) => !o)}
            className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
          >
            <span className="inline-flex items-center">
              <Book className="mr-1 inline h-3 w-3" />
              Markdown cheatsheet
            </span>
            <span className="text-[10px]">{cheatOpen ? "−" : "+"}</span>
          </button>
          {cheatOpen && (
            <dl className="mt-2 space-y-1.5 text-[11px] leading-relaxed">
              {MD_CHEATS.map((c) => (
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

          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Wrench className="mr-1 inline h-3 w-3" />
            Template helpers
          </div>
          <div className="flex flex-wrap gap-1">
            {HELPERS.map((name) => (
              <Badge
                key={name}
                variant="outline"
                className="font-mono text-[10px]"
              >
                {name}
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
        </aside>

        <div className="flex flex-1 min-h-0">
          <section className="flex w-1/2 flex-col border-r bg-background min-h-0">
            <div className="flex items-center gap-1.5 border-b bg-background px-3 py-2 text-xs font-medium text-muted-foreground">
              <span>Markdown source</span>
              <span className="ml-auto text-[10px]">
                {source.length.toLocaleString()} chars
              </span>
            </div>
            <textarea
              ref={sourceRef}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              spellCheck={false}
              className="flex-1 resize-none bg-background p-4 font-mono text-xs outline-none"
              placeholder="# Write in Markdown…"
            />
          </section>

          <section className="flex w-1/2 flex-col bg-muted/40 min-h-0">
            <div className="flex items-center gap-1.5 border-b bg-background px-3 py-2 text-xs font-medium text-muted-foreground">
              <Eye className="h-3.5 w-3.5" />
              Live preview
              {previewErr && (
                <span className="ml-2 inline-flex items-center gap-1 text-[10px] text-warning-foreground">
                  <TriangleAlert className="h-3 w-3" />
                  {previewErr}
                </span>
              )}
              <span className="ml-auto text-[10px]">server rendered</span>
            </div>
            <iframe
              srcDoc={previewHTML}
              className="flex-1 w-full bg-background"
              sandbox="allow-same-origin"
              title="Preview"
            />
          </section>
        </div>
      </div>

      <Dialog open={genOpen} onOpenChange={(o) => !genBusy && setGenOpen(o)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Generate PDF from Markdown</DialogTitle>
            <DialogDescription>
              Provide a JSON payload. Keys should match the placeholders used in
              the source.
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
            <Button onClick={runGenerate} loading={genBusy}>
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
        commands={buildMarkdownCommands({
          placeholders,
          insertAtCursor,
          wrapSelection,
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
          { keys: `${modSymbol()}B`, label: "Bold selection", group: "Markdown" },
          { keys: `${modSymbol()}I`, label: "Italic selection", group: "Markdown" },
        ]}
      />
    </div>
  );
}

function buildMarkdownCommands(p: {
  placeholders: string[];
  insertAtCursor: (text: string) => void;
  wrapSelection: (before: string, after: string) => void;
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
  return [
    { id: "file:save", label: "Save now", hint: `${M}S`, group: "File", run: () => p.save(false) },
    { id: "file:generate", label: "Generate document", group: "File", run: () => p.setGenOpen(true) },
    {
      id: "view:autosave",
      label: p.autoSave ? "Disable auto-save" : "Enable auto-save",
      group: "File",
      run: () => p.setAutoSave((v) => !v),
    },
    { id: "md:bold", label: "Bold", hint: `${M}B`, group: "Formatting", run: () => p.wrapSelection("**", "**") },
    { id: "md:italic", label: "Italic", hint: `${M}I`, group: "Formatting", run: () => p.wrapSelection("_", "_") },
    { id: "md:code", label: "Inline code", group: "Formatting", run: () => p.wrapSelection("`", "`") },
    { id: "md:link", label: "Link", group: "Formatting", run: () => p.wrapSelection("[", "](https://)") },
    { id: "md:h1", label: "Heading 1", group: "Block", run: () => p.insertAtCursor("\n# Heading\n") },
    { id: "md:h2", label: "Heading 2", group: "Block", run: () => p.insertAtCursor("\n## Heading\n") },
    { id: "md:ul", label: "Bulleted list", group: "Block", run: () => p.insertAtCursor("\n- Item\n- Item\n") },
    { id: "md:ol", label: "Numbered list", group: "Block", run: () => p.insertAtCursor("\n1. Item\n2. Item\n") },
    { id: "md:quote", label: "Block quote", group: "Block", run: () => p.insertAtCursor("\n> Quote\n") },
    { id: "md:codeblock", label: "Code block", group: "Block", run: () => p.insertAtCursor("\n```\n\n```\n") },
    { id: "md:table", label: "Table", group: "Block", run: () => p.insertAtCursor("\n| Col | Col |\n| --- | --- |\n| A   | B   |\n") },
    ...p.placeholders.map((ph) => ({
      id: "ph:" + ph,
      label: "Insert placeholder: " + ph,
      group: "Insert placeholder",
      keywords: [ph],
      run: () => p.insertAtCursor(`{{ .${ph} }}`),
    })),
    { id: "view:layout", label: "Page layout", group: "Settings", run: () => p.setLayoutOpen(true) },
    { id: "view:i18n", label: "Translations", group: "Settings", run: () => p.setI18nOpen(true) },
    { id: "view:computed", label: "Computed fields", group: "Settings", run: () => p.setComputedOpen(true) },
    { id: "view:formlinks", label: "Public form links", group: "Share", run: () => p.setFormLinksOpen(true) },
    { id: "view:send", label: "Send via email", group: "Share", run: () => p.setSendOpen(true) },
    { id: "view:collab", label: "Open collaboration", group: "Share", run: () => p.setCollabOpen(true) },
    { id: "help:shortcuts", label: "Keyboard shortcuts", hint: "?", group: "Help", run: () => p.setHelpOpen(true) },
  ];
}

const MD_CHEATS = [
  { title: "Heading", example: "# H1  ## H2  ### H3" },
  { title: "Bold / italic", example: "**bold**  *italic*" },
  { title: "Link", example: "[text](https://…)" },
  { title: "List", example: "- item   1. item" },
  { title: "Code block", example: "```lang\\ncode\\n```" },
  { title: "Table (GFM)", example: "| a | b |\\n|---|---|\\n| 1 | 2 |" },
  { title: "Placeholder", example: "{{ .name }}" },
  { title: "Loop", example: "{{ range .items }}- {{ .name }}{{ end }}" },
  { title: "Condition", example: "{{ if .paid }}Paid{{ end }}" },
  { title: "QR code", example: "{{ qrcode .url 200 }}" },
  { title: "Barcode", example: '{{ barcode .sku "code128" }}' },
  { title: "Signature", example: "{{ signature .sig.image }}" },
  { title: "Chart", example: '{{ chart .series "line" 480 280 }}' },
];

const HELPERS = [
  "upper",
  "lower",
  "formatDate",
  "formatCurrency",
  "formatNumber",
  "default",
  "sum",
  "join",
  "contains",
  "len",
  "now",
  "qrcode",
  "barcode",
  "signature",
  "image",
  "chart",
  "t",
];

function skeleton(placeholders: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const p of placeholders) setDeep(out, p, "");
  return out;
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
