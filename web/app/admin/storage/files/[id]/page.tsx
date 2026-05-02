// File detail — single-file deep view used from the inventory and the
// "largest files" list on the overview. Loads everything needed to
// answer "what is this row, where does it live, and is it safe to
// purge".
//
// Sections:
//
//   1. Header with name + a coloured pill summarizing status/scan/hold.
//   2. Two-column property grid: org, owner, mime, classification,
//      size, storage key, timestamps.
//   3. Object reality check — StatObject result. Mismatched size or
//      a missing object is the smoking gun for orphaned rows.
//   4. Scan history table (last 20 attempts).
//   5. Purge button (disabled when legal_hold is set).

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  FileText,
  Lock,
  RefreshCcw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import { formatBytes } from "@/components/admin-charts";

type FileRow = {
  id: string;
  name: string;
  mime: string;
  size: number;
  status: string;
  scanStatus: string;
  classification: string;
  legalHold: boolean;
  trashed: boolean;
  storageKey: string;
  orgId: string;
  orgName: string;
  ownerId: string;
  ownerEmail?: string;
  createdAt: string;
  updatedAt: string;
  trashedAt?: string;
};

type ScanAttempt = {
  id: string;
  status: string;
  verdict?: string;
  engine?: string;
  signature?: string;
  lastError?: string;
  attempts: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};

type ObjectInfo = {
  exists?: boolean;
  size?: number;
  etag?: string;
  lastModified?: string;
  error?: string;
};

type Detail = {
  file: FileRow;
  scans: ScanAttempt[];
  object: ObjectInfo;
};

export default function StorageFileDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();

  const [data, setData] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    if (!params.id) return;
    setLoading(true);
    try {
      const r = await api<Detail>(`/v1/admin/storage/files/${params.id}`);
      setData(r);
      setForbidden(false);
      setNotFound(false);
    } catch (e: any) {
      if (e?.status === 403) setForbidden(true);
      else if (e?.status === 404) setNotFound(true);
      else toast.show("error", "Couldn't load file", { description: e?.message });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function purge() {
    if (!data || data.file.legalHold) return;
    const ok = await confirm({
      title: "Purge file?",
      description: `Hard-delete "${data.file.name}" (${formatBytes(
        data.file.size,
      )}) from ${data.file.orgName}. This removes the row AND the storage object. Cannot be undone.`,
      confirmLabel: "Purge",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/admin/storage/files/${data.file.id}/purge`, { method: "POST" });
      toast.show("success", "File purged");
      router.push("/admin/storage/inventory");
    } catch (e: any) {
      toast.show("error", "Purge failed", { description: e?.message });
    }
  }

  if (forbidden) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Super-admin only
          </CardTitle>
        </CardHeader>
      </Card>
    );
  }

  if (notFound) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>File not found</CardTitle>
          <CardDescription>It may have been purged already.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link href="/admin/storage/inventory">Back to inventory</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const f = data?.file;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <Button asChild variant="ghost" size="sm" className="-ml-3">
            <Link href="/admin/storage/inventory">
              <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to inventory
            </Link>
          </Button>
          <h1 className="flex items-center gap-2 truncate text-2xl font-semibold">
            <FileText className="h-6 w-6 shrink-0" />
            <span className="truncate">{f?.name ?? "—"}</span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCcw
              className={"mr-1.5 h-4 w-4 " + (loading ? "animate-spin" : "")}
            />
            Refresh
          </Button>
          {f?.legalHold ? (
            <Button variant="outline" size="sm" disabled>
              <Lock className="mr-1.5 h-4 w-4" /> Legal hold
            </Button>
          ) : (
            <Button variant="destructive" size="sm" onClick={purge} disabled={!f}>
              <Trash2 className="mr-1.5 h-4 w-4" /> Purge
            </Button>
          )}
        </div>
      </div>

      {/* Status row */}
      <div className="flex flex-wrap items-center gap-2">
        {!f ? (
          <Skeleton className="h-6 w-64" />
        ) : (
          <>
            <Pill ok={f.status === "active" && !f.trashed}>{f.status}</Pill>
            <Pill
              ok={f.scanStatus === "clean" || f.scanStatus === "skipped"}
              warn={f.scanStatus === "scanning" || f.scanStatus === "pending"}
              err={f.scanStatus === "infected" || f.scanStatus === "error"}
            >
              scan: {f.scanStatus}
            </Pill>
            <Pill>{f.classification}</Pill>
            {f.trashed && <Pill warn>trashed {f.trashedAt && timeAgo(f.trashedAt)}</Pill>}
            {f.legalHold && (
              <Pill warn>
                <Lock className="mr-1 inline h-3 w-3" /> legal hold
              </Pill>
            )}
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Properties */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Properties</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {!f ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <>
                <Row label="Workspace">
                  <Link
                    href={`/admin/orgs/${f.orgId}/analytics`}
                    className="text-blue-600 hover:underline"
                  >
                    {f.orgName || f.orgId.slice(0, 8)}
                  </Link>
                </Row>
                <Row label="Owner">
                  {f.ownerEmail ? (
                    <Link
                      href={`/admin/users/${f.ownerId}/analytics`}
                      className="text-blue-600 hover:underline"
                    >
                      {f.ownerEmail}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </Row>
                <Row label="MIME">
                  <span className="font-mono text-xs">{f.mime}</span>
                </Row>
                <Row label="Size">
                  <span className="tabular-nums">{formatBytes(f.size)}</span>
                  <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                    ({f.size.toLocaleString()} bytes)
                  </span>
                </Row>
                <Row label="Storage key">
                  <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                    {f.storageKey}
                  </code>
                </Row>
                <Row label="Created">{new Date(f.createdAt).toLocaleString()}</Row>
                <Row label="Updated">{new Date(f.updatedAt).toLocaleString()}</Row>
                {f.trashedAt && (
                  <Row label="Trashed">{new Date(f.trashedAt).toLocaleString()}</Row>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Object reality check */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldAlert className="h-4 w-4" /> Object in bucket
            </CardTitle>
            <CardDescription>
              Live StatObject result. Compare against the row above.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {!data ? (
              <Skeleton className="h-32 w-full" />
            ) : data.object.exists ? (
              <>
                <Row label="Exists">
                  <span className="inline-flex items-center gap-1 text-emerald-600">
                    <CheckCircle2 className="h-4 w-4" /> yes
                  </span>
                </Row>
                <Row label="Size">
                  <span className="tabular-nums">{formatBytes(data.object.size ?? 0)}</span>
                  {data.object.size !== f?.size && (
                    <span className="ml-2 inline-flex items-center gap-1 text-amber-600">
                      <AlertTriangle className="h-3 w-3" /> mismatch
                    </span>
                  )}
                </Row>
                <Row label="ETag">
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                    {data.object.etag}
                  </code>
                </Row>
                <Row label="Modified">
                  {data.object.lastModified &&
                    new Date(data.object.lastModified).toLocaleString()}
                </Row>
              </>
            ) : (
              <div className="rounded border border-dashed bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                <div className="font-medium">Object missing in storage.</div>
                <div className="mt-0.5">
                  This row references a key that doesn't resolve: likely an orphan from a failed
                  upload. Safe to purge.
                </div>
                {data.object.error && (
                  <div className="mt-1 font-mono text-[10px] opacity-70">{data.object.error}</div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Scan history */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4" /> Scan history
          </CardTitle>
          <CardDescription>Last 20 attempts.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {!data ? (
            <div className="p-3">
              <Skeleton className="h-24 w-full" />
            </div>
          ) : data.scans.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No scan attempts recorded.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-2 text-left">When</th>
                    <th className="p-2 text-left">Status</th>
                    <th className="p-2 text-left">Verdict</th>
                    <th className="p-2 text-left">Engine</th>
                    <th className="p-2 text-left">Signature</th>
                    <th className="p-2 text-left">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {data.scans.map((s) => (
                    <tr key={s.id} className="border-b">
                      <td className="p-2 text-xs text-muted-foreground">
                        {new Date(s.createdAt).toLocaleString()}
                        {s.attempts > 1 && (
                          <Badge variant="outline" className="ml-1 text-[10px]">
                            ×{s.attempts}
                          </Badge>
                        )}
                      </td>
                      <td className="p-2">{s.status}</td>
                      <td className="p-2">{s.verdict ?? "—"}</td>
                      <td className="p-2 font-mono text-xs">{s.engine ?? "—"}</td>
                      <td className="p-2 font-mono text-xs">{s.signature ?? "—"}</td>
                      <td className="p-2 text-xs text-red-600">{s.lastError ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 items-baseline gap-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="col-span-2 break-words">{children}</div>
    </div>
  );
}

function Pill({
  children,
  ok,
  warn,
  err,
}: {
  children: React.ReactNode;
  ok?: boolean;
  warn?: boolean;
  err?: boolean;
}) {
  const cls = err
    ? "bg-red-500/10 text-red-700 dark:text-red-400"
    : warn
      ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
      : ok
        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
        : "bg-muted text-foreground";
  return (
    <span
      className={
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium " + cls
      }
    >
      {children}
    </span>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(ms / 3600000);
  if (hours >= 1) return `${hours}h ago`;
  const mins = Math.floor(ms / 60000);
  return `${mins}m ago`;
}
