"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  BookOpen,
  Check,
  Copy,
  KeyRound,
  Plus,
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
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revoked: boolean;
};

export default function ApiKeysPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<KeyRow[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newExpiry, setNewExpiry] = useState("0");
  const [creating, setCreating] = useState(false);
  const [freshKey, setFreshKey] = useState<{ key: string; name: string } | null>(
    null
  );
  const [copied, setCopied] = useState(false);

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
      const r = await api<{ key: string; name: string; prefix: string }>(
        "/v1/api-keys",
        {
          method: "POST",
          body: JSON.stringify({
            name: newName.trim() || "Untitled key",
            expiresInDays: parseInt(newExpiry, 10) || 0,
          }),
        }
      );
      setFreshKey({ key: r.key, name: r.name });
      setCreateOpen(false);
      setNewName("");
      setNewExpiry("0");
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setCreating(false);
    }
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
            Programmatic access to your Formly workspace. Use a Bearer token in
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
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-medium">Name</th>
                  <th scope="col" className="px-3 py-2 font-medium">Prefix</th>
                  <th scope="col" className="px-3 py-2 font-medium">Created</th>
                  <th scope="col" className="px-3 py-2 font-medium">Last used</th>
                  <th scope="col" className="px-3 py-2 font-medium">Status</th>
                  <th scope="col" className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b last:border-0 align-middle">
                    <td className="px-3 py-2 font-medium">{row.name}</td>
                    <td className="px-3 py-2 font-mono text-xs">{row.prefix}…</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {new Date(row.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {row.lastUsedAt
                        ? new Date(row.lastUsedAt).toLocaleString()
                        : "Never"}
                    </td>
                    <td className="px-3 py-2">
                      {row.revoked ? (
                        <Badge variant="destructive">Revoked</Badge>
                      ) : row.expiresAt && new Date(row.expiresAt) < new Date() ? (
                        <Badge variant="warning">Expired</Badge>
                      ) : (
                        <Badge variant="success">Active</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
