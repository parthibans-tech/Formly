"use client";

/**
 * Share-link modal.
 *
 * Creates / revokes / copies share links for a file. Originally lived inline
 * in `app/drive/page.tsx`; extracted so other surfaces (generated-PDF
 * preview, template detail pages, upcoming collaborator views) can reuse
 * the same UI without forking logic.
 *
 * Intentionally takes `fileId` + `fileName` rather than a full FileItem so
 * callers don't need to shape a synthetic FileItem just to share. The only
 * dependency on the backend is `/v1/files/:id/shares` and
 * `/v1/files/:id/share` — both work for any file the caller's org owns,
 * including generated PDFs from a template run.
 */
import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  KeyRound,
  Link2,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useConfirm } from "@/components/ui/confirm";

export type ShareLink = {
  id: string;
  token: string;
  role: string;
  expiresAt?: string;
  createdAt: string;
  passwordProtected?: boolean;
  oneTime?: boolean;
  downloadLimit?: number | null;
  downloadCount?: number;
};

export interface ShareModalProps {
  fileId: string;
  fileName: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

export function ShareModal({
  fileId,
  fileName,
  open,
  onOpenChange,
}: ShareModalProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState("viewer");
  const [expiry, setExpiry] = useState("0");
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [oneTime, setOneTime] = useState(false);
  const [downloadLimit, setDownloadLimit] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (!open) return;
    (async () => {
      setLoading(true);
      try {
        const r = await api<{ shares: ShareLink[] }>(
          `/v1/files/${fileId}/shares`,
        );
        setShares(r.shares);
      } finally {
        setLoading(false);
      }
    })();
  }, [fileId, open]);

  async function create() {
    setCreating(true);
    try {
      const r = await api<ShareLink>(`/v1/files/${fileId}/share`, {
        method: "POST",
        body: JSON.stringify({
          role,
          expiresIn: parseInt(expiry, 10),
          password: password || undefined,
          oneTime,
          downloadLimit: downloadLimit ? parseInt(downloadLimit, 10) : 0,
        }),
      });
      setShares((prev) => [r, ...prev]);
      setPassword("");
      setOneTime(false);
      setDownloadLimit("");
      toast.show("success", "Share link created");
    } catch (e) {
      toast.show("error", (e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    const ok = await confirm({
      title: "Revoke share link?",
      description:
        "Anyone with this link will no longer be able to access the file.",
      confirmLabel: "Revoke",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/shares/${id}`, { method: "DELETE" });
      setShares((prev) => prev.filter((s) => s.id !== id));
      toast.show("success", "Link revoked");
    } catch (e) {
      toast.show("error", (e as Error).message);
    }
  }

  async function copyLink(s: ShareLink) {
    const url = `${window.location.origin}/share/${s.token}`;
    await navigator.clipboard.writeText(url);
    setCopiedId(s.id);
    toast.show("success", "Link copied");
    setTimeout(() => setCopiedId((c) => (c === s.id ? null : c)), 2000);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-primary" />
            Share &quot;{fileName}&quot;
          </DialogTitle>
          <DialogDescription>
            Create a public link with access and expiry controls.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="share-role">Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id="share-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">Viewer</SelectItem>
                  <SelectItem value="downloader">Downloader</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="share-expiry">Expires</Label>
              <Select value={expiry} onValueChange={setExpiry}>
                <SelectTrigger id="share-expiry">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Never</SelectItem>
                  <SelectItem value="3600">1 hour</SelectItem>
                  <SelectItem value="86400">1 day</SelectItem>
                  <SelectItem value="604800">7 days</SelectItem>
                  <SelectItem value="2592000">30 days</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={create} loading={creating}>
              <Link2 className="h-4 w-4" />
              Create link
            </Button>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((s) => !s)}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {showAdvanced ? "Hide" : "Show"} advanced options
            </button>
            {showAdvanced && (
              <div className="mt-2 space-y-3 rounded-md border bg-muted/20 p-3">
                <div className="space-y-1.5">
                  <Label htmlFor="share-password">Password (optional)</Label>
                  <Input
                    id="share-password"
                    type="text"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Recipients will be prompted for this"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="share-dl-limit">
                    Download limit (optional)
                  </Label>
                  <Input
                    id="share-dl-limit"
                    type="number"
                    min={0}
                    value={downloadLimit}
                    onChange={(e) => setDownloadLimit(e.target.value)}
                    placeholder="e.g. 3 — leave empty for unlimited"
                  />
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={oneTime}
                    onChange={(e) => setOneTime(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border accent-primary"
                  />
                  <span>
                    <span className="font-medium">One-time link</span>
                    <span className="block text-xs text-muted-foreground">
                      Expires immediately after the first download.
                    </span>
                  </span>
                </label>
              </div>
            )}
          </div>

          <Separator />

          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Active links
            </div>
            {loading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : shares.length === 0 ? (
              <p className="rounded-md border border-dashed bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
                No share links yet. Create one above.
              </p>
            ) : (
              <ul className="space-y-2">
                {shares.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center gap-2 rounded-md border bg-card px-3 py-2"
                  >
                    <code className="flex-1 truncate text-xs text-muted-foreground">
                      /share/{s.token}
                    </code>
                    <Badge variant="secondary" className="capitalize">
                      {s.role}
                    </Badge>
                    {s.passwordProtected && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="outline"
                            className="gap-1 border-amber-500/40 text-amber-600"
                          >
                            <KeyRound className="h-3 w-3" />
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>Password protected</TooltipContent>
                      </Tooltip>
                    )}
                    {s.oneTime && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="outline"
                            className="border-sky-500/40 text-sky-600"
                          >
                            1×
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>One-time use</TooltipContent>
                      </Tooltip>
                    )}
                    {s.downloadLimit != null && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="outline"
                            className="font-mono text-[10px]"
                          >
                            {s.downloadCount ?? 0}/{s.downloadLimit}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>
                          Downloads used / limit
                        </TooltipContent>
                      </Tooltip>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => copyLink(s)}
                          aria-label="Copy link"
                        >
                          {copiedId === s.id ? (
                            <Check className="h-4 w-4 text-success" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {copiedId === s.id ? "Copied!" : "Copy link"}
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => revoke(s.id)}
                          aria-label="Revoke link"
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Revoke</TooltipContent>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
