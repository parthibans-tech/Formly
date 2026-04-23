"use client";

import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  Globe2,
  Link2,
  PauseCircle,
  PlayCircle,
  Plus,
  Trash2,
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
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { EmptyState } from "@/components/ui/empty-state";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/ui/confirm";

export type FormLink = {
  id: string;
  token: string;
  templateId: string;
  title?: string | null;
  description?: string | null;
  submitLabel?: string | null;
  successMessage?: string | null;
  active: boolean;
  createdAt: string;
  expiresAt?: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templateId: string;
  templateName: string;
};

export function FormLinksDialog({
  open,
  onOpenChange,
  templateId,
  templateName,
}: Props) {
  const toast = useToast();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<FormLink[]>([]);
  const [createMode, setCreateMode] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [submitLabel, setSubmitLabel] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, templateId]);

  async function load() {
    setLoading(true);
    try {
      const r = await api<{ links: FormLink[] }>(
        `/v1/templates/${templateId}/form-links`
      );
      setRows(r.links);
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setLoading(false);
    }
  }

  function publicURL(token: string) {
    if (typeof window === "undefined") return `/form/${token}`;
    return `${window.location.origin}/form/${token}`;
  }

  async function create() {
    setCreating(true);
    try {
      await api(`/v1/templates/${templateId}/form-links`, {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          submitLabel: submitLabel.trim(),
          successMessage: successMessage.trim(),
        }),
      });
      toast.show("success", "Form link created");
      setCreateMode(false);
      setTitle("");
      setDescription("");
      setSubmitLabel("");
      setSuccessMessage("");
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setCreating(false);
    }
  }

  async function toggle(row: FormLink) {
    try {
      await api(`/v1/form-links/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !row.active }),
      });
      toast.show(
        "success",
        row.active ? "Form link paused" : "Form link activated"
      );
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function remove(row: FormLink) {
    const ok = await confirm({
      title: `Revoke this form link?`,
      description: `Anyone who has the URL will see "form not found" afterward.`,
      confirmLabel: "Revoke",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/form-links/${row.id}`, { method: "DELETE" });
      toast.show("success", "Form link revoked");
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function copyLink(row: FormLink) {
    await navigator.clipboard.writeText(publicURL(row.token));
    setCopiedId(row.id);
    toast.show("success", "URL copied");
    setTimeout(() => setCopiedId((c) => (c === row.id ? null : c)), 2000);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe2 className="h-5 w-5 text-primary" />
            Public form links
          </DialogTitle>
          <DialogDescription>
            A shareable URL that renders a web form from this template&apos;s
            placeholders. End-users submit the form, get a PDF back — no
            Formly account required.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-1">
          {!createMode ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                {loading ? " " : `${rows.length} link${rows.length === 1 ? "" : "s"} for ${templateName}`}
              </span>
              <Button size="sm" onClick={() => setCreateMode(true)}>
                <Plus className="h-4 w-4" />
                New form link
              </Button>
            </div>
          ) : (
            <div className="rounded-md border bg-card p-3 space-y-3">
              <div className="text-sm font-semibold">New form link</div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Title</Label>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={templateName}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Submit button label</Label>
                  <Input
                    value={submitLabel}
                    onChange={(e) => setSubmitLabel(e.target.value)}
                    placeholder="Submit"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Description (optional)</Label>
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Short instructions shown above the form"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Thank-you message (optional)</Label>
                <Input
                  value={successMessage}
                  onChange={(e) => setSuccessMessage(e.target.value)}
                  placeholder="Your document is ready"
                />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCreateMode(false)}
                  disabled={creating}
                >
                  Cancel
                </Button>
                <Button size="sm" onClick={create} loading={creating}>
                  <Link2 className="h-4 w-4" />
                  Create
                </Button>
              </div>
            </div>
          )}

          <Separator />

          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Globe2}
              title="No form links yet"
              description="Share a link so non-Formly users can fill this template on the web."
              className="border-0"
            />
          ) : (
            <ul className="space-y-2">
              {rows.map((row) => {
                const url = publicURL(row.token);
                return (
                  <li
                    key={row.id}
                    className="rounded-md border bg-card p-3"
                  >
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold">
                            {row.title || templateName}
                          </span>
                          {row.active ? (
                            <Badge variant="success">Active</Badge>
                          ) : (
                            <Badge variant="secondary">Paused</Badge>
                          )}
                        </div>
                        <div className="mt-0.5">
                          <code className="truncate font-mono text-xs text-muted-foreground">
                            {url}
                          </code>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => copyLink(row)}
                        >
                          {copiedId === row.id ? (
                            <>
                              <Check className="h-4 w-4 text-success" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy className="h-4 w-4" />
                              Copy
                            </>
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggle(row)}
                        >
                          {row.active ? (
                            <>
                              <PauseCircle className="h-4 w-4" />
                              Pause
                            </>
                          ) : (
                            <>
                              <PlayCircle className="h-4 w-4" />
                              Resume
                            </>
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => remove(row)}
                          aria-label="Delete form link"
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
