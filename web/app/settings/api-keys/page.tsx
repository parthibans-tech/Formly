"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  KeyRound,
  Plus,
  ShieldCheck,
  Trash2,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type KeyRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revoked: boolean;
};

type ActivityRow = {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  ip?: string;
  createdAt: string;
};

type ActivityResp = {
  requests: ActivityRow[];
  counts: Record<string, number>;
};

// Canonical scope list — must match `apikeys.AllScopes` in the Go backend.
// "*" is special: if it's selected we send it alone for clarity, but the
// server accepts any combination.
const SCOPE_OPTIONS: {
  value: string;
  label: string;
  description: string;
  group: string;
}[] = [
  { value: "*", label: "Full access", description: "All endpoints; equivalent to a legacy unscoped key.", group: "Admin" },
  { value: "files:read", label: "Read files", description: "List, get, download files & folders.", group: "Files" },
  { value: "files:write", label: "Write files", description: "Upload, rename, move, delete files.", group: "Files" },
  { value: "templates:read", label: "Read templates", description: "List and fetch templates.", group: "Templates" },
  { value: "templates:write", label: "Write templates", description: "Create, update, restore templates & versions.", group: "Templates" },
  { value: "generate:write", label: "Generate documents", description: "Run single and batch generation jobs.", group: "Generate" },
  { value: "shares:write", label: "Manage shares", description: "Create, list, revoke share links.", group: "Sharing" },
  { value: "webhooks:read", label: "Read webhooks", description: "Inspect delivery history.", group: "Webhooks" },
  { value: "webhooks:write", label: "Manage webhooks", description: "Create, update, delete, test webhooks.", group: "Webhooks" },
  { value: "audit:read", label: "Read audit log", description: "Admin-only audit event feed.", group: "Security" },
  { value: "ops:read", label: "Read ops", description: "System health, queue state, metrics.", group: "Security" },
];

export default function ApiKeysPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<KeyRow[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newExpiry, setNewExpiry] = useState("0");
  const [newScopes, setNewScopes] = useState<string[]>(["*"]);
  const [creating, setCreating] = useState(false);
  const [freshKey, setFreshKey] = useState<
    { key: string; name: string; scopes: string[] } | null
  >(null);
  const [copied, setCopied] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activity, setActivity] = useState<Record<string, ActivityResp>>({});
  const [activityLoading, setActivityLoading] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = await api<{ keys: KeyRow[] }>("/v1/api-keys");
      setRows(r.keys);
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

  async function createKey() {
    setCreating(true);
    try {
      // If "*" is selected alongside narrower scopes, send just "*" — the
      // server would collapse it anyway but this keeps the wire cleaner.
      const scopes = newScopes.includes("*") ? ["*"] : newScopes;
      const r = await api<{
        key: string;
        name: string;
        prefix: string;
        scopes: string[];
      }>("/v1/api-keys", {
        method: "POST",
        body: JSON.stringify({
          name: newName.trim() || "Untitled key",
          expiresInDays: parseInt(newExpiry, 10) || 0,
          scopes,
        }),
      });
      setFreshKey({ key: r.key, name: r.name, scopes: r.scopes });
      setCreateOpen(false);
      setNewName("");
      setNewExpiry("0");
      setNewScopes(["*"]);
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setCreating(false);
    }
  }

  async function toggleActivity(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (activity[id]) return;
    setActivityLoading(id);
    try {
      const r = await api<ActivityResp>(`/v1/api-keys/${id}/activity`);
      setActivity((a) => ({ ...a, [id]: r }));
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setActivityLoading(null);
    }
  }

  function toggleScope(s: string) {
    setNewScopes((cur) => {
      if (s === "*") return cur.includes("*") ? [] : ["*"];
      const next = cur.includes(s)
        ? cur.filter((x) => x !== s)
        : [...cur.filter((x) => x !== "*"), s];
      return next.length === 0 ? ["*"] : next;
    });
  }

  async function revokeKey(row: KeyRow) {
    const ok = await confirm({
      title: `Revoke "${row.name}"?`,
      description:
        "Anyone still using this key will get a 401. The key can't be restored.",
      confirmLabel: "Revoke",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/api-keys/${row.id}`, { method: "DELETE" });
      toast.show("success", "Key revoked");
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function copyFresh() {
    if (!freshKey) return;
    await navigator.clipboard.writeText(freshKey.key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
          <p className="text-sm text-muted-foreground">
            Programmatic access to your Drive360 workspace. Use a Bearer token in
            the <code className="font-mono text-xs">Authorization</code> header
            to hit any <code className="font-mono text-xs">/v1/*</code>{" "}
            endpoint.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          New key
        </Button>
      </div>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" />
              Active keys
            </CardTitle>
            <CardDescription>
              Keys are hashed at rest — we can never show the full value after
              creation. Revoke and re-issue if you lose one.
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/docs/api">
              <BookOpen className="h-4 w-4" />
              API docs
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title="No API keys yet"
              description="Create a key to start automating. Keys are scoped to your organization."
              action={
                <Button onClick={() => setCreateOpen(true)} size="sm">
                  <Plus className="h-4 w-4" />
                  Create your first key
                </Button>
              }
              className="border-0"
            />
          ) : (
            <div className="divide-y">
              {rows.map((row) => {
                const isOpen = expandedId === row.id;
                const act = activity[row.id];
                return (
                  <div key={row.id} className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={() => toggleActivity(row.id)}
                        className="flex items-center gap-2 font-medium hover:text-primary"
                      >
                        {isOpen ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                        {row.name}
                      </button>
                      <code className="font-mono text-xs text-muted-foreground">
                        {row.prefix}…
                      </code>
                      {row.revoked ? (
                        <Badge variant="destructive">Revoked</Badge>
                      ) : row.expiresAt &&
                        new Date(row.expiresAt) < new Date() ? (
                        <Badge variant="warning">Expired</Badge>
                      ) : (
                        <Badge variant="success">Active</Badge>
                      )}
                      <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
                        <span>
                          Created{" "}
                          {new Date(row.createdAt).toLocaleDateString()}
                        </span>
                        <span>
                          {row.lastUsedAt
                            ? `Used ${new Date(
                                row.lastUsedAt
                              ).toLocaleDateString()}`
                            : "Never used"}
                        </span>
                        {!row.revoked && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => revokeKey(row)}
                            aria-label={`Revoke ${row.name}`}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
                      {(row.scopes?.length ? row.scopes : ["*"]).map((s) => (
                        <Badge
                          key={s}
                          variant="outline"
                          className="font-mono text-[10px]"
                        >
                          {s}
                        </Badge>
                      ))}
                    </div>

                    {isOpen && (
                      <div className="mt-3 rounded-md border bg-muted/30 p-3">
                        {activityLoading === row.id && !act ? (
                          <div className="space-y-1">
                            {Array.from({ length: 3 }).map((_, i) => (
                              <Skeleton key={i} className="h-6 w-full" />
                            ))}
                          </div>
                        ) : !act || act.requests.length === 0 ? (
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Activity className="h-4 w-4" />
                            No requests yet for this key.
                          </div>
                        ) : (
                          <>
                            <div className="mb-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                              <span className="font-medium">Last 24h</span>
                              {(["2xx", "3xx", "4xx", "5xx"] as const).map(
                                (b) => (
                                  <span key={b}>
                                    {b}:{" "}
                                    <span className="font-mono tabular-nums text-foreground">
                                      {act.counts[b] || 0}
                                    </span>
                                  </span>
                                )
                              )}
                            </div>
                            <ul className="space-y-0.5 text-xs">
                              {act.requests.slice(0, 50).map((r, i) => (
                                <li
                                  key={i}
                                  className="flex items-center gap-2 font-mono"
                                >
                                  <Badge
                                    variant="outline"
                                    className="w-14 justify-center text-[10px]"
                                  >
                                    {r.method}
                                  </Badge>
                                  <span
                                    className={
                                      r.status >= 500
                                        ? "text-destructive"
                                        : r.status >= 400
                                        ? "text-amber-600"
                                        : "text-muted-foreground"
                                    }
                                  >
                                    {r.status}
                                  </span>
                                  <span className="flex-1 truncate">
                                    {r.path}
                                  </span>
                                  <span className="tabular-nums text-muted-foreground">
                                    {r.durationMs}ms
                                  </span>
                                  <span className="tabular-nums text-muted-foreground">
                                    {new Date(
                                      r.createdAt
                                    ).toLocaleTimeString()}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" />
              Create API key
            </DialogTitle>
            <DialogDescription>
              Give your key a descriptive name so you can recognize it later.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              createKey();
            }}
            className="space-y-3"
          >
            <div className="space-y-1.5">
              <Label htmlFor="key-name">Name</Label>
              <Input
                id="key-name"
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Invoice automation"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="key-expiry">Expires in</Label>
              <Select value={newExpiry} onValueChange={setNewExpiry}>
                <SelectTrigger id="key-expiry">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Never</SelectItem>
                  <SelectItem value="30">30 days</SelectItem>
                  <SelectItem value="90">90 days</SelectItem>
                  <SelectItem value="180">180 days</SelectItem>
                  <SelectItem value="365">1 year</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Scopes</Label>
              <p className="text-[11px] text-muted-foreground">
                Pick the narrowest set that still lets the integration do its
                job. Selecting <b>Full access</b> overrides everything else.
              </p>
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
                {SCOPE_OPTIONS.map((opt) => {
                  const checked =
                    newScopes.includes(opt.value) ||
                    (newScopes.includes("*") && opt.value !== "*");
                  const disabled =
                    newScopes.includes("*") && opt.value !== "*";
                  return (
                    <label
                      key={opt.value}
                      className={`flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/60 ${
                        disabled ? "opacity-60" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggleScope(opt.value)}
                        className="mt-0.5"
                      />
                      <span className="flex-1">
                        <span className="font-medium">{opt.label}</span>{" "}
                        <code className="font-mono text-[10px] text-muted-foreground">
                          {opt.value}
                        </code>
                        <div className="text-[11px] text-muted-foreground">
                          {opt.description}
                        </div>
                      </span>
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
            <Button onClick={createKey} loading={creating}>
              <KeyRound className="h-4 w-4" />
              Generate key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Fresh-key reveal dialog */}
      <Dialog
        open={!!freshKey}
        onOpenChange={(o) => !o && setFreshKey(null)}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" />
              Copy your key
            </DialogTitle>
            <DialogDescription>
              This is the only time you&apos;ll see the full value. Store it
              somewhere secure (password manager, secret store, CI env var).
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                You won&apos;t be able to view this key again after closing this
                dialog. Losing it means creating a new one.
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Key name</Label>
              <Input readOnly value={freshKey?.name || ""} />
            </div>

            {freshKey?.scopes?.length ? (
              <div className="space-y-1.5">
                <Label className="text-xs">Scopes</Label>
                <div className="flex flex-wrap gap-1.5">
                  {freshKey.scopes.map((s) => (
                    <Badge
                      key={s}
                      variant="outline"
                      className="font-mono text-[10px]"
                    >
                      {s}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label>API key</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={freshKey?.key || ""}
                  className="font-mono text-xs"
                />
                <Button onClick={copyFresh} variant="outline">
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

            <Separator />

            <div className="space-y-1.5">
              <Label className="text-xs">Example usage</Label>
              <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px]">
{`curl https://your-api.example/v1/templates \\
  -H "Authorization: Bearer ${freshKey?.key || "<YOUR_KEY>"}"`}
              </pre>
            </div>
          </div>

          <DialogFooter>
            <Button onClick={() => setFreshKey(null)}>I&apos;ve saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
