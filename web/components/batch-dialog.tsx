"use client";

import { useRef, useState } from "react";
import {
  FileSpreadsheet,
  Link2,
  Loader2,
  Upload,
} from "lucide-react";
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
import { Separator } from "@/components/ui/separator";
import { API_URL, api, getToken, pollJob } from "@/lib/api";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  templateId: string;
};

type Tab = "file" | "sheet";

export function BatchDialog({ open, onOpenChange, templateId }: Props) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<Tab>("file");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function runFile(file: File) {
    setBusy(`Uploading ${file.name}…`);
    try {
      const fd = new FormData();
      fd.append("file", file);
      // Manual fetch because api() forces JSON content-type.
      const res = await fetch(`${API_URL}/v1/templates/${templateId}/batch`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken()}` },
        body: fd,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message || "batch failed");
      }
      const j = await res.json();
      await track(j.jobId);
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setBusy(null);
    }
  }

  async function runSheet() {
    if (!url.trim()) {
      toast.show("error", "Paste a Google Sheets URL");
      return;
    }
    setBusy("Fetching sheet…");
    try {
      const j = await api<{ jobId: string }>(
        `/v1/templates/${templateId}/batch-sheet`,
        { method: "POST", body: JSON.stringify({ url: url.trim() }) }
      );
      await track(j.jobId);
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setBusy(null);
    }
  }

  async function track(jobId: string) {
    setBusy("Queued…");
    const done = await pollJob(jobId, (j) => {
      if (j.total > 0) {
        setBusy(`Rendering ${j.done}/${j.total}…`);
      } else {
        setBusy(`${j.status}…`);
      }
    });
    if (done.status === "failed") {
      toast.show("error", done.error || "batch failed");
      return;
    }
    if (done.outputFileId) {
      const dl = await api<{ downloadUrl: string }>(
        `/v1/files/${done.outputFileId}/download`
      );
      toast.show("success", `Batch rendered ${done.total} rows`);
      window.open(dl.downloadUrl, "_blank");
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-primary" />
            Batch generate
          </DialogTitle>
          <DialogDescription>
            Render one PDF per row of a spreadsheet. Header row becomes the
            data-key names.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 rounded-md border bg-muted/30 p-1 text-xs">
          <TabBtn active={tab === "file"} onClick={() => setTab("file")}>
            <Upload className="h-3.5 w-3.5" />
            Upload file
          </TabBtn>
          <TabBtn active={tab === "sheet"} onClick={() => setTab("sheet")}>
            <Link2 className="h-3.5 w-3.5" />
            Google Sheets URL
          </TabBtn>
        </div>

        {tab === "file" ? (
          <div className="space-y-3">
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => e.key === "Enter" && fileRef.current?.click()}
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed bg-card p-8 text-center transition-colors hover:bg-accent",
                busy && "pointer-events-none opacity-60"
              )}
            >
              <FileSpreadsheet className="h-8 w-8 text-primary" />
              <div className="text-sm font-medium">
                Drop a file or click to browse
              </div>
              <div className="text-xs text-muted-foreground">
                CSV, TSV, or XLSX · max 64 MB
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.tsv,.xlsx,.xlsm,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) runFile(f);
                  e.target.value = "";
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              The <strong>first row</strong> must be the header (one column per
              data-key). Placeholders that reference nested paths (e.g.{" "}
              <code className="font-mono text-[11px]">customer.email</code>) read
              from columns with that exact header name.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="sheet-url">Google Sheets URL</Label>
              <Input
                id="sheet-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=0"
              />
              <p className="text-[11px] text-muted-foreground">
                The sheet must be shared as <strong>Anyone with the link</strong>{" "}
                (viewer is fine). Formly fetches the public CSV export — no
                OAuth required.
              </p>
            </div>
            <div className="flex justify-end">
              <Button onClick={runSheet} loading={busy !== null}>
                <Link2 className="h-4 w-4" />
                Render batch
              </Button>
            </div>
          </div>
        )}

        {busy && (
          <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {busy}
          </div>
        )}

        <Separator />
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={!!busy}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
