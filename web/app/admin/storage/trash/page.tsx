// Storage trash & orphan cleanup.
//
// Two distinct cleanup workflows live on this page because they share a
// "preview impact, then bulk-delete" mental model:
//
//   1. Trash sweep — soft-deleted rows older than N days, optionally
//      scoped to one org. Preview shows count + bytes that will be
//      freed. Legal-hold rows are silently excluded by the API.
//
//   2. Orphan reconcile — files that have been status='pending' (i.e.
//      presigned but never completed) for more than N hours. These eat
//      no real bytes but pile up rows; the operator usually wants them
//      gone in one shot.
//
// The page is dry-run-first: every destructive action runs the request
// with dryRun:true so the operator sees the exact impact before
// confirming.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  FileWarning,
  Hourglass,
  Lock,
  RefreshCcw,
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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/ui/confirm";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import { BarChart, formatBytes, formatCount } from "@/components/admin-charts";

type AgeBucket = { bucket: string; files: number; bytes: number };
type OrgTrash = { orgId: string; orgName: string; files: number; bytes: number };

type TrashStats = {
  totals: {
    files: number;
    bytes: number;
    legalHoldFiles: number;
    purgeableFiles: number;
  };
  ageBuckets: AgeBucket[];
  topOrgs: OrgTrash[];
};

type PurgeResp = {
  dryRun: boolean;
  matched: number;
  capped: boolean;
  freedBytes: number;
  purged: number;
  storageErrs: number;
};

export default function StorageTrashPage() {
  const toast = useToast();
  const confirm = useConfirm();

  const [stats, setStats] = useState<TrashStats | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  // Trash sweep form
  const [orgId, setOrgId] = useState("");
  const [days, setDays] = useState(30);
  const [trashBusy, setTrashBusy] = useState(false);

  // Orphan reconcile form
  const [orphanHours, setOrphanHours] = useState(24);
  const [orphanBusy, setOrphanBusy] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await api<TrashStats>("/v1/admin/storage/trash/stats");
      setStats(r);
      setForbidden(false);
    } catch (e: any) {
      if (e?.status === 403) setForbidden(true);
      else toast.show("error", "Couldn't load trash stats", { description: e?.message });
    } finally {
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function runTrashPurge() {
    if (!orgId && !days) {
      toast.show(
        "error",
        "Add a filter",
        { description: "Set an org and/or older-than-days. Refusing to purge all trash." },
      );
      return;
    }
    setTrashBusy(true);
    try {
      // Dry-run preview
      const dry = await api<PurgeResp>("/v1/admin/storage/trash/purge", {
        method: "POST",
        body: JSON.stringify({
          orgId: orgId || undefined,
          olderThanDays: days || undefined,
          dryRun: true,
        }),
      });
      if (dry.matched === 0) {
        toast.show("info", "Nothing to purge", {
          description: "No trashed files match this filter.",
        });
        return;
      }
      const note = dry.capped
        ? `\n\n⚠ Capped at ${dry.matched} per call — re-run after this completes to drain the rest.`
        : "";
      const ok = await confirm({
        title: `Purge ${dry.matched} trashed file(s)?`,
        description: `Will free ${formatBytes(dry.freedBytes)} permanently. Legal-hold files are skipped automatically.${note}`,
        confirmLabel: `Purge ${dry.matched}`,
        destructive: true,
      });
      if (!ok) return;
      const res = await api<PurgeResp>("/v1/admin/storage/trash/purge", {
        method: "POST",
        body: JSON.stringify({
          orgId: orgId || undefined,
          olderThanDays: days || undefined,
          dryRun: false,
        }),
      });
      toast.show("success", "Trash purged", {
        description: `${res.purged} file(s) · ${formatBytes(res.freedBytes)} freed${
          res.storageErrs ? ` · ${res.storageErrs} storage errors` : ""
        }`,
      });
      load();
    } catch (e: any) {
      toast.show("error", "Trash purge failed", { description: e?.message });
    } finally {
      setTrashBusy(false);
    }
  }

  async function runOrphanPurge() {
    setOrphanBusy(true);
    try {
      const dry = await api<PurgeResp>("/v1/admin/storage/orphans/purge", {
        method: "POST",
        body: JSON.stringify({ olderThanHours: orphanHours, dryRun: true }),
      });
      if (dry.matched === 0) {
        toast.show("info", "No orphans found", {
          description: `No 'pending' files older than ${orphanHours}h.`,
        });
        return;
      }
      const ok = await confirm({
        title: `Purge ${dry.matched} stuck upload(s)?`,
        description: `Files left in 'pending' for > ${orphanHours}h almost always mean the upload never completed. They consume DB rows but typically no real bytes. This cannot be undone.`,
        confirmLabel: `Purge ${dry.matched}`,
        destructive: true,
      });
      if (!ok) return;
      const res = await api<PurgeResp>("/v1/admin/storage/orphans/purge", {
        method: "POST",
        body: JSON.stringify({ olderThanHours: orphanHours, dryRun: false }),
      });
      toast.show("success", "Orphans cleared", {
        description: `${res.purged} stuck file(s) removed${
          res.storageErrs ? ` · ${res.storageErrs} storage 404s (expected)` : ""
        }`,
      });
      load();
    } catch (e: any) {
      toast.show("error", "Orphan purge failed", { description: e?.message });
    } finally {
      setOrphanBusy(false);
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
          <CardDescription>
            Trash management is restricted to platform operators.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Button asChild variant="ghost" size="sm" className="-ml-3">
            <Link href="/admin/storage">
              <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to overview
            </Link>
          </Button>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Trash2 className="h-6 w-6" /> Trash & orphans
          </h1>
          <p className="text-sm text-muted-foreground">
            Bulk hard-delete with a dry-run preview before every action.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={refreshing}>
          <RefreshCcw className={"mr-1.5 h-4 w-4 " + (refreshing ? "animate-spin" : "")} />
          Refresh
        </Button>
      </div>

      {/* Headline cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {!stats ? (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 rounded-md" />)
        ) : (
          <>
            <Card>
              <CardContent className="p-3">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Trashed files
                </div>
                <div className="mt-1 text-2xl font-semibold tabular-nums">
                  {formatCount(stats.totals.files)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Trashed bytes
                </div>
                <div className="mt-1 text-2xl font-semibold tabular-nums">
                  {formatBytes(stats.totals.bytes)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Purgeable
                </div>
                <div className="mt-1 text-2xl font-semibold tabular-nums text-emerald-600">
                  {formatCount(stats.totals.purgeableFiles)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Lock className="h-3 w-3" /> Legal hold
                  </span>
                </div>
                <div className="mt-1 text-2xl font-semibold tabular-nums text-blue-600">
                  {formatCount(stats.totals.legalHoldFiles)}
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Age histogram */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Hourglass className="h-4 w-4" /> Trash age distribution
          </CardTitle>
          <CardDescription>
            Bytes trashed by age bucket. Old buckets are the cheapest to purge.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BarChart
            data={(stats?.ageBuckets ?? []).map((b) => ({ label: b.bucket, value: b.bytes }))}
            formatV={formatBytes}
            height={180}
          />
        </CardContent>
      </Card>

      {/* Trash purge form */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Sweep trash</CardTitle>
          <CardDescription>
            Hard-delete soft-deleted rows. Specify an org and/or an
            older-than threshold. Legal-hold files are always skipped.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Org ID (optional)
            </label>
            <Input
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              placeholder="leave blank for all orgs"
              className="font-mono text-xs"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Older than (days)
            </label>
            <Input
              type="number"
              min={0}
              value={days}
              onChange={(e) => setDays(parseInt(e.target.value || "0", 10))}
            />
          </div>
          <div className="flex items-end">
            <Button
              variant="destructive"
              className="w-full"
              onClick={runTrashPurge}
              disabled={trashBusy || (!orgId && !days)}
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              Preview & purge
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Per-org leaderboard */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="h-4 w-4" /> Workspaces with most trash
          </CardTitle>
          <CardDescription>Where the cleanup wins are.</CardDescription>
        </CardHeader>
        <CardContent>
          {!stats ? (
            <Skeleton className="h-40 w-full" />
          ) : stats.topOrgs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No orgs have trashed files.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-2 text-left">Workspace</th>
                    <th className="p-2 text-right">Files</th>
                    <th className="p-2 text-right">Bytes</th>
                    <th className="p-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.topOrgs.map((o) => (
                    <tr key={o.orgId} className="border-b">
                      <td className="p-2">
                        <Link
                          href={`/admin/orgs/${o.orgId}/analytics`}
                          className="text-blue-600 hover:underline"
                        >
                          {o.orgName || o.orgId.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="p-2 text-right tabular-nums">{formatCount(o.files)}</td>
                      <td className="p-2 text-right tabular-nums">{formatBytes(o.bytes)}</td>
                      <td className="p-2 text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setOrgId(o.orgId);
                            window.scrollTo({ top: 0, behavior: "smooth" });
                          }}
                        >
                          Target
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Orphan reconcile */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileWarning className="h-4 w-4" /> Orphan reconcile
          </CardTitle>
          <CardDescription>
            Files stuck in <code className="rounded bg-muted px-1 text-[11px]">pending</code>{" "}
            past the threshold below. These almost always mean a presign was issued but the
            client never completed the upload.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Older than (hours)
            </label>
            <Input
              type="number"
              min={1}
              value={orphanHours}
              onChange={(e) => setOrphanHours(parseInt(e.target.value || "1", 10))}
            />
          </div>
          <div className="sm:col-span-2 flex items-end gap-2">
            <Button asChild variant="outline">
              <Link href={`/admin/storage/inventory?status=pending`}>
                <FileWarning className="mr-1.5 h-4 w-4" /> Inspect first
              </Link>
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              onClick={runOrphanPurge}
              disabled={orphanBusy}
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              Preview & purge orphans
            </Button>
          </div>
        </CardContent>
      </Card>

      <Badge variant="outline" className="text-xs">
        Bulk operations are capped at 1000 rows per call. Re-run if a sweep is reported as capped.
      </Badge>
    </div>
  );
}
