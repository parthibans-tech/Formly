"use client";
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  CloudUpload,
  Download,
  ExternalLink,
  FileCode,
  PencilLine,
  PlayCircle,
  Save,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import { api, getToken, pollJob, type JobStatus } from "@/lib/api";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm";
import { usePrompt } from "@/components/ui/prompt";

type Field = { name: string; type: string; page: number };
type Mapping = {
  dataKey: string;
  default?: string;
  required?: boolean;
  transform?: string;
};
type Template = {
  id: string;
  name: string;
  mode: string;
  fields: Field[];
  config: {
    mappings?: Record<string, Mapping>;
    output?: { folderPath?: string; filenameTemplate?: string; flattenDefault?: boolean };
  };
};
type MockSet = { id: string; name: string; data: any; updatedAt: string };

// RunResult is the playground's view of a generate call's outcome —
// either a successful render (with a presigned URL we can iframe and
// hand off to the user via Download / Open / Save to Drive) or a
// structured error from the server. Keeping it as a union lets the
// success/error card render off a single state slot without a tangle
// of separate booleans.
type RunResult =
  | {
      kind: "success";
      url: string;
      // bytes is whatever the server reports — the playground shows
      // it as KiB so the user has a quick sanity check ("did it
      // actually render anything, or did I get a 100-byte stub?").
      bytes?: number;
      // outputFileId is only populated on Save-to-Drive runs (i.e.
      // not preview). The success card uses its presence to flip the
      // CTA from "Save to Drive" to "Open in Drive".
      outputFileId?: string;
      outputName?: string;
      // durationMs is wall-clock time from "click run" to "got URL".
      // Useful for spotting templates that drift toward the chrome
      // headless timeout under heavier payloads.
      durationMs: number;
    }
  | {
      kind: "error";
      // code is the server's `error.code` (e.g. "fill_failed",
      // "validation_failed"). Falls back to "unknown" when the error
      // wasn't a structured API response (network failure, etc.).
      code: string;
      message: string;
      // raw is the full JSON body when the API responded with one.
      // The "view raw" disclosure surfaces it for integrators
      // debugging unfamiliar error codes without forcing them into
      // devtools.
      raw?: string;
    };

export default function PlaygroundPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();

  const [tpl, setTpl] = useState<Template | null>(null);
  const [sets, setSets] = useState<MockSet[]>([]);
  const [selectedSet, setSelectedSet] = useState<string>("");
  const [jsonText, setJsonText] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  // elapsed is bumped every 100ms while a render is in flight so the
  // progress card can show a live "Rendering… 0.4s" timer. Cheaper
  // than chasing actual page-render progress (the server doesn't
  // stream that) and useful enough for the user to see the request
  // hasn't stalled.
  const [elapsedMs, setElapsedMs] = useState(0);
  // jobStatus is non-null while we're polling an async job. The
  // progress card shows the current status badge ("queued",
  // "running") and the done/total counter when total > 0.
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [showRawError, setShowRawError] = useState(false);
  // useAsync flips the run path through the worker queue. The
  // playground used to always go sync — now we expose it so users
  // testing scheduled / batch flows can see the same status surface
  // their integrators will hit.
  const [useAsync, setUseAsync] = useState(false);
  // tickRef holds the interval handle so we can clear it on unmount
  // / mid-render abort. Keeping it in a ref instead of state avoids
  // re-renders on each tick (the elapsed value lives in state).
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    (async () => {
      try {
        const [t, s] = await Promise.all([
          api<Template>(`/v1/templates/${params.id}`),
          api<{ sets: MockSet[] }>(`/v1/templates/${params.id}/mock-data`),
        ]);
        setTpl(t);
        setSets(s.sets);
        setJsonText(JSON.stringify(skeleton(t), null, 2));
      } catch (e: any) {
        toast.show("error", e.message);
      }
    })();
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [params.id, router]);

  function dataKeys(t: Template) {
    return t.fields.map(
      (f) => t.config?.mappings?.[f.name]?.dataKey || f.name
    );
  }

  function skeleton(t: Template) {
    const out: Record<string, string> = {};
    for (const k of dataKeys(t)) out[k] = "";
    return out;
  }

  function fakeFor(t: Template) {
    const keys = dataKeys(t);
    const out: Record<string, any> = {};
    for (const k of keys) out[k] = fakeValue(k);
    return out;
  }

  // startTimer kicks the live elapsed counter. Resets to 0 first so
  // back-to-back renders don't show stale timing from the previous
  // run. The 100ms cadence is fine-grained enough to read as smooth
  // without flooding React with re-renders.
  function startTimer() {
    setElapsedMs(0);
    const start = Date.now();
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(() => setElapsedMs(Date.now() - start), 100);
  }

  function stopTimer() {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }

  // parseError unwraps the error from the api() helper so the error
  // card can render `error.code` separately from the human message,
  // and offer the raw body for integrators chasing a 422. The api()
  // helper throws Error objects that may carry .code / .body — we
  // duck-type rather than importing a typed shape to stay tolerant
  // of future API client refactors.
  function parseError(e: any): RunResult {
    const code: string =
      typeof e?.code === "string"
        ? e.code
        : typeof e?.error?.code === "string"
          ? e.error.code
          : "unknown";
    const message: string = e?.message || "Render failed";
    // ApiError exposes the parsed JSON body as `.raw`; integrators
    // chasing 422 validation_failed responses want to see the raw
    // `fields` array so they can map keys back to their UI.
    let raw: string | undefined;
    const rawBody = e?.raw ?? e?.body;
    if (rawBody !== undefined && rawBody !== null) {
      try {
        raw =
          typeof rawBody === "string"
            ? rawBody
            : JSON.stringify(rawBody, null, 2);
      } catch {
        raw = undefined;
      }
    }
    return { kind: "error", code, message, raw };
  }

  // resetRun clears the pre-render state so the success/error card
  // doesn't briefly flicker the previous run's outcome before the
  // new one lands. Called at the top of every run() / saveToDrive().
  function resetRun() {
    setResult(null);
    setShowRawError(false);
    setJobStatus(null);
  }

  async function run() {
    if (!tpl) return;
    setRunning(true);
    resetRun();
    startTimer();
    const startedAt = Date.now();
    try {
      const data = JSON.parse(jsonText);
      // `preview: true` flips the server's presigned URL to inline
      // disposition so the PDF renders in the iframe below instead
      // of the browser prompting a download. Async + preview can't
      // both apply (preview is always sync server-side), so we
      // route async runs through the persist path with a status
      // polling loop instead.
      if (useAsync) {
        const res = await api<{ jobId: string; status: string }>(
          `/v1/templates/${tpl.id}/generate`,
          { method: "POST", body: JSON.stringify({ data, async: true }) }
        );
        setJobStatus({
          id: res.jobId,
          kind: "single",
          status: res.status as any,
          total: 1,
          done: 0,
        });
        const done = await pollJob(res.jobId, (j) => setJobStatus(j));
        if (done.status === "failed") {
          throw Object.assign(new Error(done.error || "Job failed"), {
            code: "job_failed",
          });
        }
        if (!done.outputFileId) {
          throw new Error("Job completed without an output file");
        }
        const dl = await api<{ downloadUrl: string }>(
          `/v1/files/${done.outputFileId}/download`
        );
        setPreviewUrl(dl.downloadUrl);
        setResult({
          kind: "success",
          url: dl.downloadUrl,
          outputFileId: done.outputFileId,
          durationMs: Date.now() - startedAt,
        });
      } else {
        const res = await api<{ downloadUrl: string; bytes?: number }>(
          `/v1/templates/${tpl.id}/generate`,
          { method: "POST", body: JSON.stringify({ data, preview: true }) }
        );
        setPreviewUrl(res.downloadUrl);
        setResult({
          kind: "success",
          url: res.downloadUrl,
          bytes: res.bytes,
          durationMs: Date.now() - startedAt,
        });
      }
    } catch (e: any) {
      setResult(parseError(e));
      toast.show("error", e.message || "Render failed");
    } finally {
      stopTimer();
      setRunning(false);
    }
  }

  // saveToDrive is the opt-in "persist this render to my Drive" path
  // — distinct from Run, which intentionally previews without
  // creating a Drive row. We call generate WITHOUT `preview: true`
  // so the server takes the Runner.Run branch (inserts a files row +
  // uploads to the canonical outputs/ key) instead of RunPreview
  // (temp blob, no row). Users who just want to eyeball the output
  // shouldn't have their Drive polluted with dozens of near-
  // identical PDFs.
  async function saveToDrive() {
    if (!tpl) return;
    setSaving(true);
    resetRun();
    startTimer();
    const startedAt = Date.now();
    try {
      const data = JSON.parse(jsonText);
      const res = await api<{
        outputFileId: string;
        outputName: string;
        downloadUrl: string;
        bytes?: number;
      }>(`/v1/templates/${tpl.id}/generate`, {
        method: "POST",
        body: JSON.stringify({ data }),
      });
      setResult({
        kind: "success",
        url: res.downloadUrl,
        bytes: res.bytes,
        outputFileId: res.outputFileId,
        outputName: res.outputName,
        durationMs: Date.now() - startedAt,
      });
      toast.show("success", `Saved "${res.outputName}" to Drive`);
    } catch (e: any) {
      setResult(parseError(e));
      toast.show("error", e.message || "Save failed");
    } finally {
      stopTimer();
      setSaving(false);
    }
  }

  function loadPreset(id: string) {
    setSelectedSet(id);
    const s = sets.find((x) => x.id === id);
    if (s) setJsonText(JSON.stringify(s.data, null, 2));
  }

  async function savePreset() {
    if (!tpl) return;
    const name = await prompt({
      title: "Save preset",
      label: "Preset name",
      placeholder: "e.g. Sample invoice",
      defaultValue: "Sample 1",
      confirmLabel: "Save",
      validate: (v) => (v.trim().length < 1 ? "Name is required" : null),
    });
    if (!name) return;
    try {
      const data = JSON.parse(jsonText);
      await api(`/v1/templates/${tpl.id}/mock-data`, {
        method: "POST",
        body: JSON.stringify({ name, data }),
      });
      const s = await api<{ sets: MockSet[] }>(
        `/v1/templates/${tpl.id}/mock-data`
      );
      setSets(s.sets);
      toast.show("success", `Saved "${name}"`);
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function deletePreset() {
    if (!tpl || !selectedSet) return;
    const ok = await confirm({
      title: "Delete this preset?",
      description: "This can't be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/templates/${tpl.id}/mock-data/${selectedSet}`, {
        method: "DELETE",
      });
      setSets(sets.filter((s) => s.id !== selectedSet));
      setSelectedSet("");
      toast.show("success", "Preset deleted");
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  function fillFake() {
    if (!tpl) return;
    setJsonText(JSON.stringify(fakeFor(tpl), null, 2));
  }

  if (!tpl) {
    return (
      <div className="mx-auto max-w-7xl space-y-4 px-6 py-10">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const inFlight = running || saving;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/80 px-4 md:px-6 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
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
                  <Sparkles className="h-3 w-3" />
                  Playground
                </Badge>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/templates/${tpl.id}/api`}>
                <FileCode className="h-4 w-4" />
                API
              </Link>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/templates/${tpl.id}/designer`}>
                <PencilLine className="h-4 w-4" />
                Open designer
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        <section className="flex w-1/2 flex-col border-r bg-background min-h-0">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm">
            <Select value={selectedSet} onValueChange={loadPreset}>
              <SelectTrigger className="w-[200px] h-8">
                <SelectValue placeholder="Load preset…" />
              </SelectTrigger>
              <SelectContent>
                {sets.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    No presets saved yet
                  </div>
                ) : (
                  sets.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" onClick={savePreset}>
              <Save className="h-4 w-4" />
              Save as…
            </Button>
            {selectedSet && (
              <Button
                size="sm"
                variant="ghost"
                onClick={deletePreset}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={fillFake}>
              <Wand2 className="h-4 w-4" />
              Fake data
            </Button>
            <label className="ml-2 flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-primary"
                checked={useAsync}
                onChange={(e) => setUseAsync(e.target.checked)}
                disabled={inFlight}
              />
              Async (worker queue)
            </label>
            <div className="flex-1" />
            <Button
              size="sm"
              variant="outline"
              onClick={saveToDrive}
              loading={saving}
              disabled={running}
            >
              <CloudUpload className="h-4 w-4" />
              Save to Drive
            </Button>
            <Button size="sm" onClick={run} loading={running} disabled={saving}>
              <PlayCircle className="h-4 w-4" />
              Run
            </Button>
          </div>
          <textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            spellCheck={false}
            className="flex-1 resize-none bg-background p-4 font-mono text-xs outline-none"
            placeholder='{"field": "value"}'
          />
        </section>

        <section className="flex w-1/2 flex-col bg-muted/40 min-h-0">
          {/* The status strip is anchored above the iframe so progress,
              success, and error cards all share the same vertical slot
              — the user's eye doesn't have to hunt for "what just
              happened" after clicking Run. */}
          <StatusStrip
            inFlight={inFlight}
            elapsedMs={elapsedMs}
            jobStatus={jobStatus}
            result={result}
            templateId={tpl.id}
            showRawError={showRawError}
            onToggleRaw={() => setShowRawError((v) => !v)}
          />
          {previewUrl ? (
            <iframe
              src={previewUrl}
              className="flex-1 w-full bg-background"
              title="Preview"
            />
          ) : (
            <div className="grid flex-1 place-items-center px-6 text-center text-sm text-muted-foreground">
              Press{" "}
              <kbd className="mx-1 rounded border bg-background px-1.5 py-0.5">
                Run
              </kbd>{" "}
              to render a preview
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// StatusStrip renders one of three states above the preview iframe:
// 1. in-flight  — a progress card with an elapsed-seconds timer (and
//    job status badge + counter for async runs)
// 2. success    — render duration, byte size, plus Download / Open /
//    Save-to-Drive CTAs targeting the just-rendered URL
// 3. error      — server-reported `error.code`, a human message, and
//    a "view raw" disclosure for the JSON body
//
// Pulled into a sub-component to keep the parent JSX readable; all
// state is owned upstream so callers can reset it on the next run.
function StatusStrip({
  inFlight,
  elapsedMs,
  jobStatus,
  result,
  templateId,
  showRawError,
  onToggleRaw,
}: {
  inFlight: boolean;
  elapsedMs: number;
  jobStatus: JobStatus | null;
  result: RunResult | null;
  templateId: string;
  showRawError: boolean;
  onToggleRaw: () => void;
}) {
  if (inFlight) {
    const seconds = (elapsedMs / 1000).toFixed(1);
    return (
      <div className="border-b bg-background/60 px-4 py-2.5 text-xs">
        <div className="flex items-center gap-3">
          <div className="h-2 w-2 animate-pulse rounded-full bg-primary" />
          <span className="font-medium">
            {jobStatus
              ? jobStatus.status === "queued"
                ? "Waiting in queue…"
                : jobStatus.status === "running"
                  ? "Worker is rendering…"
                  : `Status: ${jobStatus.status}`
              : "Rendering…"}
          </span>
          <span className="text-muted-foreground">{seconds}s elapsed</span>
          {jobStatus && jobStatus.total > 0 && (
            <Badge variant="outline" className="text-[10px]">
              {jobStatus.done} / {jobStatus.total}
            </Badge>
          )}
        </div>
      </div>
    );
  }

  if (result?.kind === "success") {
    const sizeKiB = result.bytes ? (result.bytes / 1024).toFixed(1) : null;
    const seconds = (result.durationMs / 1000).toFixed(2);
    return (
      <div className="border-b border-green-500/30 bg-green-50/60 px-4 py-2.5 text-xs dark:bg-green-500/10">
        <div className="flex flex-wrap items-center gap-3">
          <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
          <span className="font-medium text-green-900 dark:text-green-100">
            {result.outputFileId
              ? `Saved "${result.outputName ?? "render"}" to Drive`
              : "Rendered preview"}
          </span>
          <span className="text-muted-foreground">{seconds}s</span>
          {sizeKiB && (
            <span className="text-muted-foreground">· {sizeKiB} KiB</span>
          )}
          <div className="flex-1" />
          <Button size="sm" variant="ghost" asChild>
            <a href={result.url} download>
              <Download className="h-3.5 w-3.5" />
              Download
            </a>
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <a href={result.url} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" />
              Open
            </a>
          </Button>
          {result.outputFileId && (
            <Button size="sm" variant="ghost" asChild>
              <Link href={`/drive?file=${result.outputFileId}`}>
                <CloudUpload className="h-3.5 w-3.5" />
                Open in Drive
              </Link>
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (result?.kind === "error") {
    return (
      <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2.5 text-xs">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 text-destructive" />
          <div className="flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="font-mono text-[10px]">
                {result.code}
              </Badge>
              <span className="font-medium text-destructive">
                {result.message}
              </span>
            </div>
            <div className="flex gap-3 text-[11px]">
              {result.code === "validation_failed" && (
                <Link
                  href={`/templates/${templateId}/settings`}
                  className="text-muted-foreground underline"
                >
                  Open template settings
                </Link>
              )}
              {result.raw && (
                <button
                  type="button"
                  onClick={onToggleRaw}
                  className="text-muted-foreground underline"
                >
                  {showRawError ? "Hide raw response" : "View raw response"}
                </button>
              )}
            </div>
            {showRawError && result.raw && (
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-background/60 p-2 font-mono text-[10px]">
                {result.raw}
              </pre>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
}

function fakeValue(key: string): any {
  const k = key.toLowerCase();
  if (/name/.test(k)) return "Alice Johnson";
  if (/email/.test(k)) return "alice@example.com";
  if (/phone/.test(k)) return "+1 (555) 123-4567";
  if (/addr|street/.test(k)) return "123 Main Street";
  if (/city/.test(k)) return "Portland";
  if (/state/.test(k)) return "OR";
  if (/zip|postal/.test(k)) return "97201";
  if (/country/.test(k)) return "USA";
  if (/date/.test(k)) return new Date().toISOString().slice(0, 10);
  if (/amount|total|price|cost/.test(k)) return "1,250.00";
  if (/id|number|no$/.test(k)) return "INV-0042";
  if (/company|org/.test(k)) return "Acme Corp";
  return "Sample value";
}
