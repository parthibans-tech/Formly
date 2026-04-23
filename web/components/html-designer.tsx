"use client";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  ArrowLeft,
  Blocks,
  Book,
  Calculator,
  Code2,
  Eye,
  Globe,
  Globe2,
  History,
  Mail,
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
import { RichEditor } from "@/components/ui/rich-editor";
import type { BlockEditorRef } from "@/components/ui/block-editor";
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

// BlockNote can't SSR — ProseMirror accesses `window` on import.
const BlockEditor = dynamic(
  () => import("@/components/ui/block-editor").then((m) => m.BlockEditor),
  { ssr: false, loading: () => <div className="p-4 text-xs text-muted-foreground">Loading blocks editor…</div> }
) as unknown as React.ForwardRefExoticComponent<
  { initialHTML?: string; onChange?: (html: string) => void } & React.RefAttributes<BlockEditorRef>
>;

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
type EditorTab = "blocks" | "design" | "code";

export default function HtmlDesigner({ tpl: initialTpl }: Props) {
  const toast = useToast();
  const [tpl, setTpl] = useState(initialTpl);
  const [source, setSource] = useState("");
  const [sampleJSON, setSampleJSON] = useState("{}");
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<EditorTab>("blocks");
  const blockRef = useRef<BlockEditorRef | null>(null);
  const [genOpen, setGenOpen] = useState(false);
  const [genAsync, setGenAsync] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genProgress, setGenProgress] = useState<string | null>(null);
  const [genData, setGenData] = useState("{}");
  const [previewHTML, setPreviewHTML] = useState<string>("");
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [sourceLoaded, setSourceLoaded] = useState(false);
  const [blocksEntry, setBlocksEntry] = useState(0);

  useEffect(() => {
    if (tab === "blocks") setBlocksEntry((n) => n + 1);
  }, [tab]);
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
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    }
  }

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
                  HTML
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
            <Button variant="outline" size="sm" onClick={() => save(false)} loading={saving}>
              <Save className="h-4 w-4" />
              Save
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
        {/* Left rail: placeholders + cheatsheet + helpers + sample data */}
        <aside className="hidden w-72 shrink-0 overflow-y-auto border-r bg-background p-4 lg:block">
          {/* Placeholders */}
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
              Insert <code className="font-mono text-xs">{"{{ .name }}"}</code>{" "}
              from the toolbar, then save to detect them.
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
              <TabButton
                active={tab === "blocks"}
                icon={<Blocks className="h-3.5 w-3.5" />}
                onClick={() => setTab("blocks")}
              >
                Blocks
              </TabButton>
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
              {tab === "blocks" ? (
                sourceLoaded ? (
                  <BlockEditor
                    key={blocksEntry}
                    initialHTML={source}
                    onChange={setSource}
                    ref={blockRef}
                  />
                ) : (
                  <div className="p-4 text-xs text-muted-foreground">
                    Loading template…
                  </div>
                )
              ) : tab === "design" ? (
                <RichEditor
                  value={source}
                  onChange={setSource}
                  placeholders={placeholders}
                />
              ) : (
                <textarea
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  spellCheck={false}
                  className="h-full w-full resize-none bg-background p-4 font-mono text-xs outline-none"
                  placeholder="<!doctype html><html>...</html>"
                />
              )}
            </div>
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
    </div>
  );
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

