"use client";

// MergeFilesDialog — pick an order, pick page subsets, hit "Merge" and
// the server stitches the inputs into a new PDF.
//
// Why a dedicated dialog (and not a wizard or a side panel)
//
// Merge is a one-shot intent: the user already has the files selected
// when they open this; everything in here just confirms the details
// (order, page ranges, output name, destination folder). A modal keeps
// focus on that single decision and avoids the visual debt of a panel
// that's empty 99% of the time.
//
// Shape of the interaction
//
//   1. Caller passes a list of source files (already ACL-checked client-side).
//   2. User reorders rows with the ↑/↓ buttons (no DnD lib pulled in
//      just for this — three files is a typical case, four buttons is plenty).
//   3. User can type a per-file page range ("1-3,5,7-9", "all", "odd",
//      "even"). Empty / "all" = whole file.
//   4. On submit we POST /v1/files/merge. Sync replies (small native
//      PDFs) return a fileId immediately; async replies hand back a
//      jobId we poll until status === "done".
//
// Heterogeneous inputs (DOCX + PDF + image) all run through the same
// endpoint; the API does the LibreOffice / image→PDF normalisation.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  FileText,
  Image as ImageIcon,
  Loader2,
  Merge,
  Trash2,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
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
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

// We accept the minimum shape so the caller can pass FileItem-from-anywhere
// without adapting it. Adding fields here would make the dialog refuse
// perfectly valid call sites.
export type MergeFile = {
  id: string;
  name: string;
  mime: string;
  size?: number;
};

type Row = MergeFile & {
  pages: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: MergeFile[];
  // folderId of the destination. We default to the caller's current
  // folder so merged PDFs land next to the inputs; the user can clear
  // this in the UI to drop into root.
  defaultFolderId?: string | null;
  // Suggested output name — usually "Merged - <first file>". We append
  // ".pdf" server-side if the user strips it.
  defaultName?: string;
  // Fired with the new file's id once the merge resolves (sync or
  // async). The parent typically refreshes its file list.
  onMerged?: (fileId: string, name: string) => void;
};

type SyncResp = {
  async: false;
  fileId: string;
  name: string;
  size: number;
};

type AsyncResp = {
  async: true;
  jobId: string;
};

type JobStatus = {
  jobId: string;
  status: "queued" | "running" | "done" | "failed";
  fileId?: string;
  error?: string;
};

export function MergeFilesDialog({
  open,
  onOpenChange,
  files,
  defaultFolderId,
  defaultName,
  onMerged,
}: Props) {
  const router = useRouter();
  const toast = useToast();

  // Local copy so reorder / remove / pages-edit don't mutate the
  // caller's list. Re-seeded each time the dialog opens with a fresh
  // input, so a second invocation doesn't carry over a stale half-edit.
  const [rows, setRows] = useState<Row[]>(() =>
    files.map((f) => ({ ...f, pages: "" }))
  );
  const [name, setName] = useState(defaultName ?? "Merged document");
  const [folderId] = useState<string | null>(defaultFolderId ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Re-seed when the prop list changes — typical when the dialog is
  // reopened with a different selection.
  useEffect(() => {
    if (open) {
      setRows(files.map((f) => ({ ...f, pages: "" })));
      setName(defaultName ?? suggestName(files));
      setProgressMsg(null);
      setSubmitting(false);
    }
    // We intentionally don't depend on `files` identity changes when
    // open is false — that would re-seed while the dialog is closed
    // and animate stale rows on next open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function move(idx: number, delta: number) {
    const next = idx + delta;
    if (next < 0 || next >= rows.length) return;
    setRows((xs) => {
      const out = xs.slice();
      const [r] = out.splice(idx, 1);
      out.splice(next, 0, r);
      return out;
    });
  }

  function remove(idx: number) {
    setRows((xs) => xs.filter((_, i) => i !== idx));
  }

  function setPages(idx: number, value: string) {
    setRows((xs) =>
      xs.map((r, i) => (i === idx ? { ...r, pages: value } : r))
    );
  }

  // Quick page-range syntax check so we surface a 400 reason before
  // hitting the network. Mirror of pdfmerge.validatePageRange — kept
  // intentionally lenient (anything matching the grammar; we don't
  // know the actual page count client-side).
  const pageErrors = useMemo(() => {
    const out: Record<number, string> = {};
    for (let i = 0; i < rows.length; i++) {
      const e = checkPages(rows[i].pages);
      if (e) out[i] = e;
    }
    return out;
  }, [rows]);

  const canSubmit =
    !submitting &&
    rows.length >= 2 &&
    Object.keys(pageErrors).length === 0 &&
    name.trim().length > 0;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setProgressMsg("Starting merge…");
    try {
      const res = await api<SyncResp | AsyncResp>(`/v1/files/merge`, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          folderId: folderId ?? "",
          sources: rows.map((r) => ({
            fileId: r.id,
            pages: r.pages.trim() || undefined,
          })),
        }),
      });

      if ("fileId" in res && res.fileId) {
        // Sync path
        toast.show("success", `Merged ${rows.length} files`);
        onMerged?.(res.fileId, res.name ?? name);
        onOpenChange(false);
        return;
      }

      if ("jobId" in res && res.jobId) {
        // Async path — poll until done.
        setProgressMsg(
          "Large or mixed-format merge — running in the background…"
        );
        await pollJob(res.jobId);
        return;
      }

      throw new Error("Unexpected merge response");
    } catch (e: any) {
      toast.show("error", "Merge failed", { description: e.message });
      setProgressMsg(null);
      setSubmitting(false);
    }
  }

  // pollJob hits /v1/merge-jobs/:id at 1.5s intervals (enough for
  // soffice cold-start + a typical merge) until it terminates. We don't
  // give up — the API row is durable, so the dialog stays open and the
  // user can leave it running. They can also close the dialog and the
  // merge keeps going on the server; the file just appears in their
  // drive when ready.
  async function pollJob(jobId: string): Promise<void> {
    return new Promise((resolve) => {
      const tick = async () => {
        try {
          const j = await api<JobStatus>(`/v1/merge-jobs/${jobId}`);
          if (j.status === "done" && j.fileId) {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            toast.show("success", "Merge completed");
            onMerged?.(j.fileId, name);
            onOpenChange(false);
            resolve();
            return;
          }
          if (j.status === "failed") {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            toast.show("error", "Merge failed", { description: j.error });
            setProgressMsg(null);
            setSubmitting(false);
            resolve();
            return;
          }
          setProgressMsg(
            j.status === "running"
              ? "Working on it…"
              : "Queued — waiting for a worker…"
          );
        } catch (e: any) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          toast.show("error", "Lost contact with the merge job", {
            description: e.message,
          });
          setProgressMsg(null);
          setSubmitting(false);
          resolve();
        }
      };
      // First poll immediately so a fast worker doesn't sit at "Queued".
      void tick();
      pollRef.current = setInterval(tick, 1500);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (submitting) return; // don't close mid-merge
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Merge className="h-5 w-5 text-primary" />
            Merge into a single PDF
          </DialogTitle>
          <DialogDescription>
            Drag-free reorder with the arrows, optionally pick which pages of
            each source to include, and we&apos;ll stitch them into a new PDF.
            Word, RTF, ODT, and image inputs are converted automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="merge-name">Output file name</Label>
            <Input
              id="merge-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Merged document.pdf"
              disabled={submitting}
            />
            <p className="text-xs text-muted-foreground">
              <code className="rounded bg-muted px-1 py-0.5">.pdf</code> is
              added automatically if you leave it off.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Sources (in order)</Label>
            <div className="rounded-lg border bg-card divide-y">
              {rows.length === 0 && (
                <div className="p-4 text-center text-sm text-muted-foreground">
                  Add at least two files to merge.
                </div>
              )}
              {rows.map((r, i) => (
                // Two-line layout per row:
                //   line 1 — sequence badge + icon + filename (truncates) + hint
                //   line 2 — pages input (gets ~half the width) + reorder/remove buttons
                // This stops long filenames from squeezing the input down to
                // a placeholder-truncating sliver, and keeps the icon buttons
                // big enough to actually hit.
                <div key={r.id + ":" + i} className="flex flex-col gap-2 p-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge
                      variant="secondary"
                      className="h-6 w-6 shrink-0 justify-center rounded-full p-0 text-xs"
                    >
                      {i + 1}
                    </Badge>
                    <FileIcon mime={r.mime} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium" title={r.name}>
                        {r.name}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {sourceHint(r.mime, r.name)}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pl-8">
                    <div className="min-w-0 flex-1">
                      <Input
                        value={r.pages}
                        onChange={(e) => setPages(i, e.target.value)}
                        placeholder="Pages — leave empty for all"
                        disabled={submitting}
                        className="h-9 text-sm"
                      />
                      {pageErrors[i] && (
                        <div className="mt-1 text-xs text-red-500">
                          {pageErrors[i]}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => move(i, -1)}
                        disabled={submitting || i === 0}
                        title="Move up"
                      >
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => move(i, 1)}
                        disabled={submitting || i === rows.length - 1}
                        title="Move down"
                      >
                        <ArrowDown className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => remove(i)}
                        disabled={submitting || rows.length <= 2}
                        title="Remove from merge"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Page syntax: <code className="rounded bg-muted px-1">all</code>{" "}
              (default), <code className="rounded bg-muted px-1">1-3,5,7-9</code>,{" "}
              <code className="rounded bg-muted px-1">odd</code>,{" "}
              <code className="rounded bg-muted px-1">even</code>.
            </p>
          </div>

          {progressMsg && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-3 text-sm">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span>{progressMsg}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            <X className="h-4 w-4 mr-1.5" />
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                Merging…
              </>
            ) : (
              <>
                <Merge className="h-4 w-4 mr-1.5" />
                Merge {rows.length} files
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// =====================================================================
//   Helpers
// =====================================================================

function FileIcon({ mime }: { mime: string }) {
  if (mime?.startsWith("image/")) {
    return <ImageIcon className="h-4 w-4 text-muted-foreground shrink-0" />;
  }
  return <FileText className="h-4 w-4 text-muted-foreground shrink-0" />;
}

function sourceHint(mime: string, name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (mime === "application/pdf" || ext === "pdf") return "PDF — used as-is";
  if (mime.startsWith("image/") || imageExt(ext))
    return "Image — wrapped as a one-page PDF";
  if (officeExt(ext) || officeMime(mime))
    return "Office doc — converted to PDF first";
  return "Will be converted to PDF if possible";
}

function officeExt(ext: string) {
  return ["doc", "docx", "docm", "rtf", "odt", "ott"].includes(ext);
}
function imageExt(ext: string) {
  return ["jpg", "jpeg", "png", "tif", "tiff", "gif", "bmp", "webp"].includes(
    ext
  );
}
function officeMime(m: string) {
  return (
    m === "application/msword" ||
    m === "application/rtf" ||
    m === "text/rtf" ||
    m.startsWith(
      "application/vnd.openxmlformats-officedocument.wordprocessingml"
    ) ||
    m === "application/vnd.oasis.opendocument.text"
  );
}

function suggestName(files: MergeFile[]): string {
  if (!files.length) return "Merged document";
  const first = files[0].name.replace(/\.[^.]+$/, "");
  return `Merged - ${first}`;
}

function checkPages(s: string): string | null {
  const v = s.trim();
  if (!v) return null;
  const lower = v.toLowerCase();
  if (lower === "all" || lower === "odd" || lower === "even") return null;
  for (const part of v.split(",")) {
    const p = part.trim();
    if (!p) continue;
    if (!/^\d+(-\d+)?$/.test(p)) {
      return `Unrecognised page range: "${p}"`;
    }
    if (p.includes("-")) {
      const [a, b] = p.split("-").map((x) => parseInt(x, 10));
      if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < a) {
        return `Bad range: "${p}"`;
      }
    } else if (parseInt(p, 10) < 1) {
      return "Pages start at 1";
    }
  }
  return null;
}
