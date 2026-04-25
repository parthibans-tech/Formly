"use client";

// Merge Recipe builder.
//
// Two halves:
//   • Header — name, description, output_name_template. Plain Inputs;
//     PATCH on Save.
//   • Components — ordered list, drag-free reorder via up/down buttons
//     (we keep the picker simple because most recipes are 2–6
//     components — a real DnD library would be overkill). Each row
//     lets you set pages, dataKey, required, flatten, label.
//
// "Add component" pops a small search dialog that hits /v1/files (with
// `q=`) or /v1/templates (also with `q=`) so the user can pick a
// source without leaving the builder.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CheckCircle2,
  ExternalLink,
  FileText,
  Layers,
  Loader2,
  Play,
  Plug,
  Plus,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { ApiError, api, getToken } from "@/lib/api";
import { useToast } from "@/components/toast";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Component = {
  id?: string;
  position: number;
  kind: "file" | "template";
  fileId?: string;
  templateId?: string;
  pages: string;
  dataKey: string;
  required: boolean;
  flatten: boolean;
  label?: string;
  sourceName?: string;
};

type Recipe = {
  id: string;
  name: string;
  description: string;
  outputNameTemplate: string;
  config: Record<string, any>;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
  components: Component[];
};

export default function RecipeBuilderPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();

  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerKind, setPickerKind] = useState<"file" | "template">("template");
  const [runOutput, setRunOutput] = useState<{
    fileId: string;
    name: string;
  } | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  async function load() {
    setLoading(true);
    try {
      const r = await api<Recipe>(`/v1/merge-recipes/${params.id}`);
      setRecipe(r);
    } catch (e: any) {
      toast.show("error", "Couldn't load recipe", { description: e.message });
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!recipe) return;
    setSaving(true);
    try {
      // Strip read-only enrichment (sourceName) before PATCH so the
      // server's input shape stays clean.
      const components = recipe.components.map((c, i) => ({
        position: i,
        kind: c.kind,
        fileId: c.fileId,
        templateId: c.templateId,
        pages: c.pages,
        dataKey: c.dataKey,
        required: c.required,
        flatten: c.flatten,
        label: c.label,
      }));
      const updated = await api<Recipe>(`/v1/merge-recipes/${params.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: recipe.name,
          description: recipe.description,
          outputNameTemplate: recipe.outputNameTemplate,
          components,
        }),
      });
      setRecipe(updated);
      toast.show("success", "Saved");
    } catch (e: any) {
      toast.show("error", "Save failed", { description: e.message });
    } finally {
      setSaving(false);
    }
  }

  async function run() {
    if (!recipe) return;
    setRunning(true);
    setRunOutput(null);
    try {
      // The builder's "Run" is for smoke-testing — we send an empty
      // data object, which is fine for file-only recipes and is the
      // shape that lets template-component runs surface "missing data"
      // errors so the user sees they need to integrate it from their
      // app. Real runs come from external API calls.
      const r = await api<{ fileId: string; name: string }>(
        `/v1/merge-recipes/${params.id}/run`,
        { method: "POST", body: JSON.stringify({ data: {} }) }
      );
      setRunOutput(r);
      toast.show("success", `Generated ${r.name}`);
    } catch (e: any) {
      const desc =
        e instanceof ApiError && e.code === "missing_data"
          ? `${e.message} — required template data is missing. The recipe is saved and ready; call it from your app with real data.`
          : e.message;
      toast.show("error", "Run failed", { description: desc });
    } finally {
      setRunning(false);
    }
  }

  function patch(p: Partial<Recipe>) {
    setRecipe((r) => (r ? { ...r, ...p } : r));
  }

  function patchComponent(i: number, p: Partial<Component>) {
    setRecipe((r) => {
      if (!r) return r;
      const next = [...r.components];
      next[i] = { ...next[i], ...p };
      return { ...r, components: next };
    });
  }

  function move(i: number, dir: -1 | 1) {
    setRecipe((r) => {
      if (!r) return r;
      const j = i + dir;
      if (j < 0 || j >= r.components.length) return r;
      const next = [...r.components];
      [next[i], next[j]] = [next[j], next[i]];
      next.forEach((c, k) => (c.position = k));
      return { ...r, components: next };
    });
  }

  function removeComponent(i: number) {
    setRecipe((r) => {
      if (!r) return r;
      const next = r.components.filter((_, k) => k !== i);
      next.forEach((c, k) => (c.position = k));
      return { ...r, components: next };
    });
  }

  function addComponent(picked: PickedItem) {
    setRecipe((r) => {
      if (!r) return r;
      const next: Component = {
        position: r.components.length,
        kind: picked.kind,
        fileId: picked.kind === "file" ? picked.id : undefined,
        templateId: picked.kind === "template" ? picked.id : undefined,
        pages: "all",
        dataKey: defaultDataKey(picked.name),
        required: true,
        flatten: false,
        label: "",
        sourceName: picked.name,
      };
      return { ...r, components: [...r.components, next] };
    });
    setPickerOpen(false);
  }

  if (loading) {
    return (
      <AppShell>
        <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6">
          <Skeleton className="h-32 w-full" />
        </div>
      </AppShell>
    );
  }
  if (!recipe) return null;

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6 md:py-8">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/merge-recipes">
                <ArrowLeft className="h-4 w-4" />
                All recipes
              </Link>
            </Button>
            <Separator orientation="vertical" className="h-5" />
            <Layers className="h-5 w-5 text-primary" />
            <h1 className="text-base font-semibold">Edit recipe</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/merge-recipes/${recipe.id}/integrate`}>
                <Plug className="h-4 w-4 mr-1.5" />
                Integrate
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={run}
              disabled={running || recipe.components.length === 0}
            >
              {running ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Play className="h-4 w-4 mr-1.5" />
              )}
              Test run
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-1.5" />
              )}
              Save
            </Button>
          </div>
        </div>

        {runOutput && (
          <Card className="mt-4 border-emerald-500/40 bg-emerald-500/5">
            <CardContent className="flex items-center justify-between gap-4 p-3">
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                <span className="min-w-0 truncate">
                  Test run produced{" "}
                  <strong title={runOutput.name}>{runOutput.name}</strong>
                </span>
              </div>
              <Button asChild size="sm" variant="ghost">
                <Link href={`/drive?file=${runOutput.fileId}`}>
                  <ExternalLink className="h-3.5 w-3.5 mr-1" />
                  Open in drive
                </Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {/* ----- Header card ----- */}
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-base">Recipe details</CardTitle>
            <CardDescription>
              The name appears in the recipe list and is the default
              filename for outputs (override per-call via{" "}
              <code className="text-xs">outputName</code> in the request).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="r-name">Name</Label>
              <Input
                id="r-name"
                value={recipe.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="r-desc">Description</Label>
              <textarea
                id="r-desc"
                value={recipe.description}
                onChange={(e) => patch({ description: e.target.value })}
                rows={2}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="Optional — what this recipe produces"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="r-out">Output filename template</Label>
              <Input
                id="r-out"
                value={recipe.outputNameTemplate}
                onChange={(e) => patch({ outputNameTemplate: e.target.value })}
                placeholder="e.g. {{ candidate.name }} - Offer pack {{ date }}.pdf"
              />
              <p className="text-xs text-muted-foreground">
                Mustache-style placeholders: <code>{"{{ name }}"}</code>,{" "}
                <code>{"{{ date }}"}</code>, and any path into the request
                data, e.g. <code>{"{{ candidate.name }}"}</code>. Empty
                falls back to the recipe name.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ----- Components ----- */}
        <Card className="mt-4">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">Components</CardTitle>
              <CardDescription>
                The output PDF is the concatenation of these components in
                order. Each template component reads only its own slice of
                the request data via <code className="text-xs">dataKey</code>,
                so different files can have different field names without
                colliding.
              </CardDescription>
            </div>
            <div className="flex gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setPickerKind("template");
                  setPickerOpen(true);
                }}
              >
                <Plus className="h-4 w-4 mr-1" />
                Add template
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setPickerKind("file");
                  setPickerOpen(true);
                }}
              >
                <Plus className="h-4 w-4 mr-1" />
                Add file
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {recipe.components.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No components yet. Add a template (rendered with caller
                data) or a static file (PDF / DOCX / image) to start.
              </p>
            )}
            {recipe.components.map((c, i) => (
              <ComponentRow
                key={`${c.kind}-${c.fileId || c.templateId || i}-${i}`}
                index={i}
                total={recipe.components.length}
                cmp={c}
                onChange={(p) => patchComponent(i, p)}
                onMove={(d) => move(i, d)}
                onRemove={() => removeComponent(i)}
              />
            ))}
          </CardContent>
        </Card>
      </div>

      <SourcePicker
        open={pickerOpen}
        kind={pickerKind}
        onOpenChange={setPickerOpen}
        onPick={addComponent}
      />
    </AppShell>
  );
}

// ----- Component row ---------------------------------------------------

function ComponentRow({
  index,
  total,
  cmp,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  total: number;
  cmp: Component;
  onChange: (p: Partial<Component>) => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-start gap-3">
        <div className="flex flex-col gap-1 pt-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            disabled={index === 0}
            onClick={() => onMove(-1)}
            title="Move up"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
            title="Move down"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px] uppercase">
              #{index + 1}
            </Badge>
            <Badge
              variant={cmp.kind === "template" ? "default" : "secondary"}
              className="text-[10px] uppercase"
            >
              {cmp.kind}
            </Badge>
            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
            <span
              className="min-w-0 flex-1 truncate text-sm font-medium"
              title={cmp.sourceName}
            >
              {cmp.sourceName ||
                (cmp.kind === "template" ? cmp.templateId : cmp.fileId) ||
                "(missing source)"}
            </span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Pages</Label>
              <Input
                value={cmp.pages}
                onChange={(e) => onChange({ pages: e.target.value })}
                placeholder="all (default), e.g. 1-3,5,7-9"
                className="h-8 text-xs"
              />
            </div>
            {cmp.kind === "template" && (
              <div className="space-y-1">
                <Label className="text-xs">Data key</Label>
                <Input
                  value={cmp.dataKey}
                  onChange={(e) => onChange({ dataKey: e.target.value })}
                  placeholder="e.g. candidate, company"
                  className="h-8 text-xs"
                />
              </div>
            )}
            <div className="space-y-1">
              <Label className="text-xs">Label</Label>
              <Input
                value={cmp.label || ""}
                onChange={(e) => onChange({ label: e.target.value })}
                placeholder="Optional"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Required</Label>
              <Select
                value={cmp.required ? "yes" : "no"}
                onValueChange={(v) => onChange({ required: v === "yes" })}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="yes">
                    Required — fail if missing
                  </SelectItem>
                  <SelectItem value="no">
                    Optional — skip if missing
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {cmp.kind === "template" && (
              <div className="space-y-1">
                <Label className="text-xs">Flatten</Label>
                <Select
                  value={cmp.flatten ? "yes" : "no"}
                  onValueChange={(v) => onChange({ flatten: v === "yes" })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="no">
                      Keep form fields fillable
                    </SelectItem>
                    <SelectItem value="yes">
                      Flatten (read-only PDF)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          title="Remove component"
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>
    </div>
  );
}

// ----- Source picker dialog -------------------------------------------

type PickedItem = { id: string; name: string; kind: "file" | "template" };

function SourcePicker({
  open,
  kind,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  kind: "file" | "template";
  onOpenChange: (v: boolean) => void;
  onPick: (p: PickedItem) => void;
}) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<PickedItem[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!open) {
      setQ("");
      setItems([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        if (kind === "file") {
          const r = await api<{ files: any[] }>(
            `/v1/files?q=${encodeURIComponent(q.trim())}`
          );
          if (cancelled) return;
          setItems(
            (r.files || [])
              .slice(0, 20)
              .map((f) => ({ id: f.id, name: f.name, kind: "file" as const }))
          );
        } else {
          const r = await api<{ templates: any[] }>(
            `/v1/templates?q=${encodeURIComponent(q.trim())}`
          );
          if (cancelled) return;
          setItems(
            (r.templates || [])
              .slice(0, 20)
              .map((t) => ({
                id: t.id,
                name: t.name,
                kind: "template" as const,
              }))
          );
        }
      } catch {
        // best-effort search
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, open, kind]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Search className="h-4 w-4" />
            Pick a {kind}
          </DialogTitle>
          <DialogDescription>
            {kind === "template"
              ? "Templates are rendered with the caller's data, then merged. Pick one and set its data namespace below."
              : "Static files (PDF, DOCX, images) are merged as-is. DOCX/RTF/ODT are auto-converted via LibreOffice."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Type to search…"
              className="pl-8"
              autoFocus
            />
          </div>
          <div className="max-h-72 overflow-y-auto rounded-md border bg-card">
            {searching && (
              <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Searching…
              </div>
            )}
            {!searching && items.length === 0 && (
              <div className="p-3 text-sm text-muted-foreground">
                {q ? "No matches." : "Start typing to search."}
              </div>
            )}
            {items.map((it) => (
              <button
                key={`${it.kind}:${it.id}`}
                type="button"
                onClick={() => onPick(it)}
                title={it.name}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
              >
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="min-w-0 flex-1 truncate">{it.name}</span>
              </button>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// defaultDataKey turns "Offer Letter Template" into "offerLetter" so the
// builder doesn't ship with empty data keys for new template components.
// Users typically want a per-component namespace; this saves them a
// step. They can still clear it (empty = read whole `data` object).
function defaultDataKey(name: string): string {
  if (!name) return "";
  const cleaned = name
    .replace(/\.[a-z0-9]+$/i, "") // strip ext
    .replace(/template/i, "")
    .trim();
  const parts = cleaned.split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 0) return "";
  return parts
    .map((p, i) =>
      i === 0
        ? p.charAt(0).toLowerCase() + p.slice(1)
        : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()
    )
    .join("");
}
