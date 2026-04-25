"use client";

// InsertPagesDialog — splice pages from a source file into an existing
// PDF, in place (target's storage_key is preserved so existing share
// links stay valid).
//
// Two-step picker:
//   1. Pick a source file from the user's drive (search-as-you-type).
//   2. Pick which pages of the source to insert + the splice point in
//      the target ("at start", "at end", or "after page N").
//
// Why not lean on the merge dialog
//
// Insert is conceptually different — there's an existing target PDF
// you're modifying, not a fresh output you're building. Conflating
// them would make either flow feel awkward (the merge dialog has no
// "splice point" concept; the insert dialog has no "drag-to-reorder").

import { useEffect, useMemo, useState } from "react";
import { FileText, Loader2, MoveRight, Search, X } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Target PDF being edited.
  targetId: string;
  targetName: string;
  // Fired after a successful insert. Parent typically refreshes the
  // file list so the row's updated_at / size reflect the change.
  onInserted?: () => void;
};

type FileOption = {
  id: string;
  name: string;
  mime: string;
};

export function InsertPagesDialog({
  open,
  onOpenChange,
  targetId,
  targetName,
  onInserted,
}: Props) {
  const toast = useToast();

  const [search, setSearch] = useState("");
  const [results, setResults] = useState<FileOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<FileOption | null>(null);
  const [pages, setPages] = useState("");
  // "start" / "end" / "after"
  const [where, setWhere] = useState<"start" | "end" | "after">("end");
  const [afterPage, setAfterPage] = useState<string>("1");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setSearch("");
      setResults([]);
      setPicked(null);
      setPages("");
      setWhere("end");
      setAfterPage("1");
      setSubmitting(false);
    }
  }, [open]);

  // Debounced search against the regular file list endpoint. We
  // exclude the target itself so users don't accidentally splice the
  // target into itself; that's a no-op the API would technically
  // accept but it's never what the user means.
  useEffect(() => {
    if (!open) return;
    const q = search.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await api<{ files: FileOption[] }>(
          `/v1/files?q=${encodeURIComponent(q)}`
        );
        if (cancelled) return;
        setResults(r.files.filter((f) => f.id !== targetId).slice(0, 10));
      } catch {
        // search is best-effort — silent failure is fine, the user
        // can retype.
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, open, targetId]);

  const pageErr = useMemo(() => checkPages(pages), [pages]);

  const afterPageNum = useMemo(() => {
    const n = parseInt(afterPage, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }, [afterPage]);

  const canSubmit =
    !submitting &&
    picked !== null &&
    !pageErr &&
    (where !== "after" || afterPageNum !== null);

  async function submit() {
    if (!canSubmit || !picked) return;
    setSubmitting(true);
    try {
      // Translate the UI choice into the API's `afterPage` integer.
      // start = 0; end = -1 (server clamps to total pages).
      let after = -1;
      if (where === "start") after = 0;
      else if (where === "after") after = afterPageNum ?? -1;

      await api(`/v1/files/${targetId}/insert`, {
        method: "POST",
        body: JSON.stringify({
          sourceId: picked.id,
          sourcePages: pages.trim() || undefined,
          afterPage: after,
        }),
      });
      toast.show("success", `Inserted pages into ${targetName}`);
      onInserted?.();
      onOpenChange(false);
    } catch (e: any) {
      toast.show("error", "Insert failed", { description: e.message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (submitting) return;
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MoveRight className="h-5 w-5 text-primary" />
            Insert pages into {truncate(targetName, 40)}
          </DialogTitle>
          <DialogDescription>
            Pick a source file, choose which pages to take from it, and where
            in this PDF they should land. The original keeps its sharing
            links.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="insert-search">Source file</Label>
            {picked ? (
              <div className="flex items-center justify-between rounded-md border bg-muted/40 p-2">
                <div className="flex items-center gap-2 min-w-0">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate text-sm">{picked.name}</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPicked(null);
                    setSearch("");
                  }}
                  disabled={submitting}
                >
                  Change
                </Button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="insert-search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Type to search your drive…"
                    className="pl-8"
                    disabled={submitting}
                  />
                </div>
                {search.trim().length >= 2 && (
                  <div className="max-h-56 overflow-y-auto rounded-md border bg-card">
                    {searching && (
                      <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Searching…
                      </div>
                    )}
                    {!searching && results.length === 0 && (
                      <div className="p-3 text-sm text-muted-foreground">
                        No matches.
                      </div>
                    )}
                    {results.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => setPicked(r)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                      >
                        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="truncate">{r.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="insert-pages">Pages from source</Label>
            <Input
              id="insert-pages"
              value={pages}
              onChange={(e) => setPages(e.target.value)}
              placeholder="all (default), or e.g. 1-3,5,7-9"
              disabled={submitting || !picked}
            />
            {pageErr && (
              <div className="text-xs text-red-500">{pageErr}</div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Insert at</Label>
              <Select
                value={where}
                onValueChange={(v) => setWhere(v as typeof where)}
                disabled={submitting || !picked}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="start">At the start</SelectItem>
                  <SelectItem value="end">At the end</SelectItem>
                  <SelectItem value="after">After page…</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {where === "after" && (
              <div className="space-y-1.5">
                <Label htmlFor="insert-after">Page number</Label>
                <Input
                  id="insert-after"
                  inputMode="numeric"
                  value={afterPage}
                  onChange={(e) => setAfterPage(e.target.value)}
                  disabled={submitting}
                />
              </div>
            )}
          </div>
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
                Inserting…
              </>
            ) : (
              <>
                <MoveRight className="h-4 w-4 mr-1.5" />
                Insert pages
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function truncate(s: string, n: number) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function checkPages(s: string): string | null {
  const v = s.trim();
  if (!v) return null;
  const lower = v.toLowerCase();
  if (lower === "all" || lower === "odd" || lower === "even") return null;
  for (const part of v.split(",")) {
    const p = part.trim();
    if (!p) continue;
    if (!/^\d+(-\d+)?$/.test(p)) return `Unrecognised page range: "${p}"`;
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
