"use client";

// TemplateViewer — the view-only surface rendered when the current user
// has `role=viewer` on the template's backing file (or on a folder that
// cascades to it). The designer page routes to this component BEFORE
// any mode-specific designer so viewers never see edit controls at all
// — the experience is a clean "preview + metadata + generate" screen,
// not a designer with greyed-out buttons.
//
// Preview strategy by mode:
//   - acroform / static / anything already backed by a PDF: iframe the
//     presigned source URL directly (fast, no server work).
//   - html / markdown / doc: the raw source isn't human-friendly, so
//     we POST to /v1/templates/:id/generate with an empty payload and
//     `preview: true`, then iframe the rendered PDF. The `preview`
//     flag tells the server to return an inline-disposition presigned
//     URL so the browser renders instead of downloading.
//
// Anything that would mutate the template (Save, Save structure, field
// mapping edits, widget drags, source edits, autosave) lives in the
// designer tree and is simply not reachable from here.

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Eye,
  FileCode,
  KeyRound,
  Layers,
  Loader2,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";

// Minimal shape we accept — the designer page already fetches the full
// templateDTO, we just pick out the viewer-relevant bits. Keeping the
// surface narrow means this component can be moved to a standalone page
// later (e.g. /templates/:id/view) without refactoring consumers.
export type ViewerTemplate = {
  id: string;
  // The backing file id — needed for the "request edit access" flow
  // because access_requests are keyed by file, not template.
  fileId: string;
  name: string;
  mode: string;
  version: number;
  fields?: Array<{ name: string; type: string; page?: number }>;
  config?: {
    placeholders?: string[];
    mappings?: Record<string, { dataKey: string; required?: boolean }>;
  };
};

type Props = {
  tpl: ViewerTemplate;
  previewUrl: string | null;
};

export function TemplateViewer({ tpl, previewUrl }: Props) {
  // Pull a flat list of "things the caller can pass in" for the sidebar.
  // AcroForm / static templates carry `fields`; html / markdown expose
  // `config.placeholders`. We show whichever the template has.
  const placeholders = tpl.config?.placeholders || [];
  const mappings = tpl.config?.mappings || {};
  const hasFields = (tpl.fields?.length || 0) > 0;
  const hasPlaceholders = placeholders.length > 0;

  // PDF-backed modes (acroform/static) can iframe the source presigned
  // URL directly. Source-based modes (html/markdown/doc) must be rendered
  // server-side first, so we call Generate with an empty payload and an
  // `inline` disposition — result is a PDF we can iframe.
  const isPdfBacked = tpl.mode === "acroform" || tpl.mode === "static";
  const [renderedPreview, setRenderedPreview] = useState<string | null>(null);
  const [renderLoading, setRenderLoading] = useState(false);
  const [renderErr, setRenderErr] = useState<string | null>(null);

  // Request-access dialog state. `requestSent` flips to true after a
  // successful POST so we can swap the button for a "Pending" affordance
  // without having to round-trip to the server to check inbox state.
  const toast = useToast();
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestRole, setRequestRole] = useState<"editor" | "viewer">("editor");
  const [requestMessage, setRequestMessage] = useState("");
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestSent, setRequestSent] = useState(false);

  async function submitRequest() {
    if (requestBusy) return;
    setRequestBusy(true);
    try {
      await api(`/v1/files/${tpl.fileId}/request-access`, {
        method: "POST",
        body: JSON.stringify({
          role: requestRole,
          message: requestMessage.trim(),
        }),
      });
      setRequestSent(true);
      setRequestOpen(false);
      toast.show("success", "Request sent", {
        description: "The owner will be notified.",
      });
    } catch (e: any) {
      // 409 = there's already a pending request from this user; surface
      // it as "already sent" rather than a failure. Owner self-requesting
      // also comes back as 409.
      if (e?.status === 409) {
        setRequestSent(true);
        setRequestOpen(false);
        toast.show("info", "Already requested", {
          description: "Your previous request is still pending.",
        });
      } else {
        toast.show("error", "Couldn't send request", {
          description: e?.message || "Please try again.",
        });
      }
    } finally {
      setRequestBusy(false);
    }
  }

  useEffect(() => {
    if (isPdfBacked) return;
    let cancelled = false;
    (async () => {
      setRenderLoading(true);
      setRenderErr(null);
      try {
        // Build a skeleton payload where every expected key is blank —
        // the template renders with its defaults / literal text. This
        // gives viewers a realistic preview shape without us having to
        // invent fake data.
        const skeleton: Record<string, string> = {};
        for (const p of placeholders) skeleton[p] = "";
        for (const f of tpl.fields || []) {
          const key = mappings[f.name]?.dataKey || f.name;
          skeleton[key] = "";
        }
        const res = await api<{ downloadUrl: string }>(
          `/v1/templates/${tpl.id}/generate`,
          {
            method: "POST",
            body: JSON.stringify({ data: skeleton, preview: true }),
          }
        );
        if (!cancelled) setRenderedPreview(res.downloadUrl);
      } catch (e: any) {
        if (!cancelled)
          setRenderErr(e.message || "Couldn't render a preview");
      } finally {
        if (!cancelled) setRenderLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally only re-run when the template id changes — the
    // fields / placeholders / mappings come from the same fetch so they
    // move together, and we don't want a render storm on prop-identity
    // churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tpl.id, isPdfBacked]);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Amber strip — loud enough that nobody misses they're viewing,
          quiet enough that it doesn't dominate the screen. */}
      <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 md:px-6 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
        <Eye className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">View-only access.</span>
        <span className="text-amber-800/80 dark:text-amber-200/80">
          You can preview this template and generate PDFs in the playground. To
          edit the design, ask the owner for edit access.
        </span>
      </div>

      {/* Sticky header mirrors the designer's chrome so the navigation
          feels consistent — back to Drive, template identity, primary
          action. No Save / Generate / Batch buttons. */}
      <header className="sticky top-0 z-40 border-b bg-background/80 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:px-6">
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
                <Badge variant="outline" className="text-[10px] uppercase">
                  {tpl.mode}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  v{tpl.version}
                </span>
                <Badge
                  variant="secondary"
                  className="gap-1 text-[10px] uppercase"
                >
                  <Eye className="h-3 w-3" />
                  Viewer
                </Badge>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/templates/${tpl.id}/api`}>
                <FileCode className="h-4 w-4" />
                API
              </Link>
            </Button>
            <Button size="sm" asChild>
              <Link href={`/templates/${tpl.id}/playground`}>
                <Sparkles className="h-4 w-4" />
                Open playground
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Preview pane. PDF-backed modes iframe the source URL (fast,
            no render needed). Source-based modes render on-demand via
            Generate with a blank payload and iframe the result. */}
        <section className="flex-1 border-r bg-muted/40">
          {isPdfBacked ? (
            previewUrl ? (
              <iframe
                src={previewUrl}
                className="h-full w-full"
                title={`${tpl.name} preview`}
              />
            ) : (
              <div className="grid h-full place-items-center text-sm text-muted-foreground">
                No preview available
              </div>
            )
          ) : renderLoading ? (
            <div className="space-y-3 p-6">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-[calc(100vh-12rem)] w-full" />
            </div>
          ) : renderErr ? (
            <div className="grid h-full place-items-center px-6">
              <div className="max-w-md rounded-lg border border-destructive/40 bg-destructive/5 p-5 text-sm text-destructive">
                <p className="font-medium">Couldn&rsquo;t render a preview</p>
                <p className="mt-1 text-xs text-destructive/80">{renderErr}</p>
              </div>
            </div>
          ) : renderedPreview ? (
            <iframe
              src={renderedPreview}
              className="h-full w-full bg-background"
              title={`${tpl.name} preview`}
            />
          ) : (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">
              No preview available
            </div>
          )}
        </section>

        {/* Right column — template info card. Tells viewers what fields
            they need to provide when generating, which is the single
            most useful thing someone with view access actually asks
            ("what keys does this template expect?"). */}
        <aside className="w-[360px] shrink-0 overflow-y-auto bg-background">
          <div className="border-b p-5">
            <h2 className="text-sm font-semibold">About this template</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              You have view access. The sections below describe the shape of
              data this template expects when generating a PDF.
            </p>
          </div>

          {hasFields && (
            <div className="border-b p-5">
              <div className="mb-2 flex items-center gap-2">
                <Layers className="h-3.5 w-3.5 text-muted-foreground" />
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Fields ({tpl.fields!.length})
                </h3>
              </div>
              <ul className="space-y-1.5">
                {tpl.fields!.map((f) => {
                  // The mapping's dataKey is what the *caller* passes
                  // in their JSON payload. If no mapping is defined we
                  // fall back to the raw field name, matching how the
                  // generator resolves keys server-side.
                  const m = mappings[f.name];
                  const key = m?.dataKey || f.name;
                  return (
                    <li
                      key={f.name}
                      className="flex items-start justify-between gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-mono text-[11px]">
                          {key}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {f.type}
                          {f.page ? ` • page ${f.page}` : ""}
                        </div>
                      </div>
                      {m?.required && (
                        <Badge
                          variant="outline"
                          className="h-5 shrink-0 text-[9px] uppercase"
                        >
                          Required
                        </Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {hasPlaceholders && (
            <div className="border-b p-5">
              <div className="mb-2 flex items-center gap-2">
                <Layers className="h-3.5 w-3.5 text-muted-foreground" />
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Placeholders ({placeholders.length})
                </h3>
              </div>
              <ul className="space-y-1.5">
                {placeholders.map((p) => (
                  <li
                    key={p}
                    className="rounded-md border bg-muted/30 px-2.5 py-1.5 font-mono text-[11px]"
                  >
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!hasFields && !hasPlaceholders && (
            <div className="p-5 text-xs text-muted-foreground">
              This template doesn&rsquo;t expose any mappable fields. Open the
              playground to try generating it anyway.
            </div>
          )}

          <div className="p-5">
            <div className="rounded-lg border border-dashed bg-muted/30 p-3 text-xs">
              <p className="font-medium">Need to edit this template?</p>
              <p className="mt-1 text-muted-foreground">
                Send the owner a request — they&rsquo;ll see it in their access
                inbox and can approve with one click.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3 w-full"
                disabled={requestSent}
                onClick={() => setRequestOpen(true)}
              >
                <KeyRound className="h-3.5 w-3.5" />
                {requestSent ? "Request pending" : "Request edit access"}
              </Button>
            </div>
          </div>
        </aside>
      </div>

      <Dialog open={requestOpen} onOpenChange={setRequestOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Request access</DialogTitle>
            <DialogDescription>
              The owner will get a notification in their access inbox. If
              they approve, this template will reload with your new role.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="req-role" className="text-xs">
                Role
              </Label>
              <Select
                value={requestRole}
                onValueChange={(v) =>
                  setRequestRole(v === "viewer" ? "viewer" : "editor")
                }
              >
                <SelectTrigger id="req-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="editor">Editor — can change the template</SelectItem>
                  <SelectItem value="viewer">Viewer — preview only</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="req-msg" className="text-xs">
                Message (optional)
              </Label>
              <textarea
                id="req-msg"
                value={requestMessage}
                onChange={(e) => setRequestMessage(e.target.value)}
                placeholder="Why do you need access?"
                rows={3}
                className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                maxLength={500}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRequestOpen(false)}
              disabled={requestBusy}
            >
              Cancel
            </Button>
            <Button onClick={submitRequest} disabled={requestBusy}>
              {requestBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              Send request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
