"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  History,
  Link2,
  Plus,
  RefreshCcw,
  Send,
  Trash2,
  Webhook as WebhookIcon,
  XCircle,
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/ui/confirm";
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
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Webhook = {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

type Delivery = {
  id: string;
  event: string;
  status: "success" | "failed" | "pending";
  attempt: number;
  responseCode?: number | null;
  responseBody?: string | null;
  error?: string | null;
  durationMs?: number | null;
  createdAt: string;
};

const ALL_EVENTS: { value: string; label: string; hint: string }[] = [
  {
    value: "generate.completed",
    label: "generate.completed",
    hint: "A PDF was rendered successfully.",
  },
  {
    value: "generate.failed",
    label: "generate.failed",
    hint: "A generation job errored.",
  },
  {
    value: "share.accessed",
    label: "share.accessed",
    hint: "Someone opened a share link.",
  },
  {
    value: "template.updated",
    label: "template.updated",
    hint: "Config or source changed.",
  },
  {
    value: "file.uploaded",
    label: "file.uploaded",
    hint: "A new file finished uploading.",
  },
];

export default function WebhooksPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Webhook[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newURL, setNewURL] = useState("");
  const [newEvents, setNewEvents] = useState<string[]>([
    "generate.completed",
  ]);
  const [creating, setCreating] = useState(false);
  const [freshSecret, setFreshSecret] = useState<{
    secret: string;
    name: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [drawer, setDrawer] = useState<Webhook | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await api<{ webhooks: Webhook[] }>("/v1/webhooks");
      setRows(r.webhooks);
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createWebhook() {
    setCreating(true);
    try {
      const r = await api<{ secret: string; name: string }>("/v1/webhooks", {
        method: "POST",
        body: JSON.stringify({
          name: newName.trim() || "Untitled webhook",
          url: newURL.trim(),
          events: newEvents,
        }),
      });
      setFreshSecret({ secret: r.secret, name: r.name });
      setCreateOpen(false);
      setNewName("");
      setNewURL("");
      setNewEvents(["generate.completed"]);
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setCreating(false);
    }
  }

  async function toggle(row: Webhook) {
    try {
      await api(`/v1/webhooks/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !row.active }),
      });
      toast.show("success", row.active ? "Webhook paused" : "Webhook enabled");
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function remove(row: Webhook) {
    const ok = await confirm({
      title: `Delete "${row.name}"?`,
      description:
        "Queued deliveries for this webhook will still attempt to fire, but no new events will be dispatched.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/webhooks/${row.id}`, { method: "DELETE" });
      toast.show("success", "Webhook deleted");
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function sendTest(row: Webhook) {
    try {
      await api(`/v1/webhooks/${row.id}/test`, { method: "POST" });
      toast.show("success", "Test ping queued", {
        description: "Open the deliveries panel to see the result.",
      });
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function retryDelivery(webhookId: string, deliveryId: string) {
    try {
      await api(
        `/v1/webhooks/${webhookId}/deliveries/${deliveryId}/retry`,
        { method: "POST" }
      );
      toast.show("success", "Retry queued", {
        description: "The event will redeliver; refresh deliveries shortly.",
      });
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function openDeliveries(row: Webhook) {
    setDrawer(row);
    setDeliveriesLoading(true);
    try {
      const r = await api<{ deliveries: Delivery[] }>(
        `/v1/webhooks/${row.id}/deliveries`
      );
      setDeliveries(r.deliveries);
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setDeliveriesLoading(false);
    }
  }

  async function copySecret() {
    if (!freshSecret) return;
    await navigator.clipboard.writeText(freshSecret.secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function toggleEvent(ev: string) {
    setNewEvents((arr) =>
      arr.includes(ev) ? arr.filter((e) => e !== ev) : [...arr, ev]
    );
  }

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Webhooks</h1>
          <p className="text-sm text-muted-foreground">
            Fire HTTP POSTs to your services when things happen in Formly.
            Each request is HMAC-signed so your receiver can verify
            authenticity.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          New webhook
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <WebhookIcon className="h-5 w-5 text-primary" />
            Active subscriptions
          </CardTitle>
          <CardDescription>
            Requests send a JSON body with the event name and payload. Retries
            use exponential backoff up to ~12h on non-2xx responses.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={WebhookIcon}
              title="No webhooks yet"
              description="Subscribe your services to Formly events so you can react to generations, shares, uploads, and more."
              action={
                <Button onClick={() => setCreateOpen(true)} size="sm">
                  <Plus className="h-4 w-4" />
                  Create your first webhook
                </Button>
              }
              className="border-0"
            />
          ) : (
            <ul className="space-y-2">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="rounded-md border bg-card p-3"
                >
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold">{row.name}</span>
                        {row.active ? (
                          <Badge variant="success">Active</Badge>
                        ) : (
                          <Badge variant="secondary">Paused</Badge>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <Link2 className="h-3 w-3" />
                        <code className="truncate font-mono">{row.url}</code>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {row.events.map((e) => (
                          <Badge
                            key={e}
                            variant="outline"
                            className="font-mono text-[10px]"
                          >
                            {e}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openDeliveries(row)}
                      >
                        <History className="h-4 w-4" />
                        Deliveries
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => sendTest(row)}
                      >
                        <Send className="h-4 w-4" />
                        Test
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggle(row)}
                      >
                        {row.active ? "Pause" : "Resume"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => remove(row)}
                        aria-label="Delete webhook"
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Verifying signatures</CardTitle>
          <CardDescription>
            Each POST includes a{" "}
            <code className="font-mono">Formly-Signature</code> header. Split
            the timestamp from the signature and recompute the HMAC using your
            webhook&apos;s secret.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px]">
{`Formly-Signature: t=1713876543,v1=2b1c7…8f42

// Node.js verification
import crypto from "node:crypto";
const [tPart, sigPart] = header.split(",");
const t = tPart.split("=")[1];
const sig = sigPart.split("=")[1];
const expected = crypto
  .createHmac("sha256", process.env.FORMLY_WEBHOOK_SECRET)
  .update(\`\${t}.\${rawBody}\`)
  .digest("hex");
if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
  return res.status(401).end("bad signature");
}`}
          </pre>
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <WebhookIcon className="h-5 w-5 text-primary" />
              New webhook
            </DialogTitle>
            <DialogDescription>
              Point this at a receiver you control. The signing secret will be
              revealed once after creation.
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              createWebhook();
            }}
            className="space-y-3"
          >
            <div className="space-y-1.5">
              <Label htmlFor="wh-name">Name</Label>
              <Input
                id="wh-name"
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. CRM sync"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wh-url">Endpoint URL</Label>
              <Input
                id="wh-url"
                value={newURL}
                onChange={(e) => setNewURL(e.target.value)}
                placeholder="https://hooks.example.com/formly"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Events</Label>
              <div className="space-y-1">
                {ALL_EVENTS.map((ev) => {
                  const on = newEvents.includes(ev.value);
                  return (
                    <label
                      key={ev.value}
                      className={cn(
                        "flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs transition-colors",
                        on
                          ? "border-primary bg-primary/5"
                          : "hover:bg-accent"
                      )}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 accent-primary"
                        checked={on}
                        onChange={() => toggleEvent(ev.value)}
                      />
                      <div>
                        <div className="font-mono text-[11px]">{ev.label}</div>
                        <div className="text-muted-foreground">{ev.hint}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          </form>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button onClick={createWebhook} loading={creating}>
              <WebhookIcon className="h-4 w-4" />
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Fresh-secret dialog */}
      <Dialog
        open={!!freshSecret}
        onOpenChange={(o) => !o && setFreshSecret(null)}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <WebhookIcon className="h-5 w-5 text-primary" />
              Signing secret
            </DialogTitle>
            <DialogDescription>
              Store this in your receiver as{" "}
              <code className="font-mono">FORMLY_WEBHOOK_SECRET</code>. You
              won&apos;t be able to view it again after closing this dialog.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                Losing this secret means creating a new webhook — we can&apos;t
                show it again.
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Webhook</Label>
              <Input readOnly value={freshSecret?.name || ""} />
            </div>
            <div className="space-y-1.5">
              <Label>Secret</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={freshSecret?.secret || ""}
                  className="font-mono text-xs"
                />
                <Button onClick={copySecret} variant="outline">
                  {copied ? (
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
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button onClick={() => setFreshSecret(null)}>
              I&apos;ve saved it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deliveries drawer */}
      <Dialog open={!!drawer} onOpenChange={(o) => !o && setDrawer(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="h-5 w-5 text-primary" />
              Recent deliveries
            </DialogTitle>
            <DialogDescription>
              Latest 50 attempts for <strong>{drawer?.name}</strong>.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[60vh] overflow-y-auto">
            {deliveriesLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : deliveries.length === 0 ? (
              <p className="rounded-md border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
                No deliveries yet. Use the <strong>Test</strong> button to fire
                a ping.
              </p>
            ) : (
              <ul className="divide-y">
                {deliveries.map((d) => (
                  <li key={d.id} className="py-2">
                    <div className="flex items-start gap-2">
                      {d.status === "success" ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" />
                      ) : d.status === "failed" ? (
                        <XCircle className="mt-0.5 h-4 w-4 text-destructive" />
                      ) : (
                        <ChevronRight className="mt-0.5 h-4 w-4" />
                      )}
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex items-center gap-2 text-xs">
                          <Badge
                            variant="outline"
                            className="font-mono text-[10px]"
                          >
                            {d.event}
                          </Badge>
                          {d.responseCode ? (
                            <Badge
                              variant={
                                d.status === "success"
                                  ? "success"
                                  : "destructive"
                              }
                              className="text-[10px]"
                            >
                              HTTP {d.responseCode}
                            </Badge>
                          ) : null}
                          <span className="text-muted-foreground">
                            attempt #{d.attempt}
                          </span>
                          {d.durationMs != null && (
                            <span className="text-muted-foreground">
                              · {d.durationMs}ms
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {new Date(d.createdAt).toLocaleString()}
                        </div>
                        {(d.error || d.responseBody) && (
                          <pre className="mt-1 max-h-24 overflow-auto rounded bg-muted/50 p-2 font-mono text-[10px] text-muted-foreground">
                            {d.error || d.responseBody}
                          </pre>
                        )}
                      </div>
                      {drawer && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => retryDelivery(drawer.id, d.id)}
                          aria-label="Retry delivery"
                          title="Re-enqueue this delivery"
                          className="text-muted-foreground hover:text-primary"
                        >
                          <RefreshCcw className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Separator />

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => drawer && openDeliveries(drawer)}
            >
              <History className="h-4 w-4" />
              Refresh
            </Button>
            <Button onClick={() => setDrawer(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
