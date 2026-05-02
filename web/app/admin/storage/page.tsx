// Storage overview — the landing surface for the super-admin Storage
// console. Single round-trip to /v1/admin/storage/overview powers the
// whole page so operators get a sub-second snapshot instead of waiting
// for a fan-out.
//
// Layout:
//
//   1. KPI strip — total / active / trashed / pending / infected /
//      legal-hold / active bytes / trashed bytes / orgs.
//   2. Backend health card — bucket name, ping latency, ok/err pill.
//   3. Distribution donuts — status, scan_status, classification.
//   4. MIME + extension bars (count and bytes available; we display
//      the bytes view since "biggest blob types" is the operator's
//      decision input).
//   5. Trash age histogram bars.
//   6. Top orgs table → links to /admin/orgs/{id}/analytics.
//   7. Top files table → links to /admin/storage/files/{id} via the
//      detail dialog.
//
// The page is read-only. Action affordances (purge, bulk-delete) live
// on the inventory and trash sub-pages, kept off this dashboard so a
// stray click doesn't nuke a row at a glance.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  Archive,
  Database,
  FileWarning,
  HardDrive,
  RefreshCcw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import {
  BarChart,
  Donut,
  KpiTile,
  TopList,
  formatBytes,
  formatCount,
  type LabelValue,
} from "@/components/admin-charts";
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
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";

// API response shape — mirrors platformstorage.Overview.
type KV = { label: string; value: number; bytes?: number };

type OrgUsage = {
  orgId: string;
  orgName: string;
  activeFiles: number;
  activeBytes: number;
  trashedFiles: number;
  trashedBytes: number;
  legalHoldRows: number;
};

type TopFile = {
  id: string;
  name: string;
  mime: string;
  size: number;
  orgId: string;
  orgName: string;
  ownerEmail?: string;
  status: string;
  scanStatus: string;
  legalHold: boolean;
  trashed: boolean;
  classification: string;
  createdAt: string;
};

type TrashAge = { bucket: string; files: number; bytes: number };

type Backend = {
  ok?: boolean;
  bucket?: string;
  latencyMs?: number;
  error?: string;
};

type Overview = {
  generated: string;
  bucket: string;
  totals: {
    files: number;
    activeFiles: number;
    trashedFiles: number;
    pendingFiles: number;
    infectedFiles: number;
    scanErrFiles: number;
    legalHold: number;
    activeBytes: number;
    trashedBytes: number;
    orgs: number;
  };
  statusBreakdown: KV[];
  scanBreakdown: KV[];
  classificationBreakdown: KV[];
  topMimes: KV[];
  topExtensions: KV[];
  trashAge: TrashAge[];
  topOrgs: OrgUsage[];
  topFiles: TopFile[];
  backend: Backend;
};

export default function StorageOverviewPage() {
  const toast = useToast();
  const [data, setData] = useState<Overview | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await api<Overview>("/v1/admin/storage/overview");
      setData(r);
      setForbidden(false);
    } catch (e: any) {
      if (e?.status === 403) setForbidden(true);
      else toast.show("error", "Couldn't load storage overview", { description: e?.message });
    } finally {
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (forbidden) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Super-admin only
          </CardTitle>
          <CardDescription>
            Storage management is restricted to platform operators.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Database className="h-6 w-6" /> Storage management
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Cross-tenant inventory, trash & orphan cleanup, backend health.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/storage/inventory">
              <HardDrive className="mr-1.5 h-4 w-4" /> Inventory
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/storage/trash">
              <Trash2 className="mr-1.5 h-4 w-4" /> Trash
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={load} disabled={refreshing}>
            <RefreshCcw className={"mr-1.5 h-4 w-4 " + (refreshing ? "animate-spin" : "")} />
            Refresh
          </Button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {!data ? (
          [0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-20 rounded-md" />)
        ) : (
          <>
            <KpiTile
              label="Active bytes"
              value={formatBytes(data.totals.activeBytes)}
              sublabel={`${formatCount(data.totals.activeFiles)} files`}
            />
            <KpiTile
              label="Trashed bytes"
              value={formatBytes(data.totals.trashedBytes)}
              sublabel={`${formatCount(data.totals.trashedFiles)} files awaiting purge`}
            />
            <KpiTile
              label="Pending uploads"
              value={formatCount(data.totals.pendingFiles)}
              sublabel="presigned but never completed"
            />
            <KpiTile
              label="Infected / scan-err"
              value={`${formatCount(data.totals.infectedFiles)} / ${formatCount(
                data.totals.scanErrFiles,
              )}`}
              sublabel="files quarantined by AV"
            />
            <KpiTile
              label="Legal hold"
              value={formatCount(data.totals.legalHold)}
              sublabel="cannot be purged"
            />
          </>
        )}
      </div>

      {/* Backend health */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" />
            Backend
          </CardTitle>
          <CardDescription>
            Bucket reachability + latency. The same client serves every workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          {!data ? (
            <Skeleton className="h-6 w-72" />
          ) : (
            <>
              <span className="inline-flex items-center gap-2">
                <span className="text-muted-foreground">Bucket:</span>
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {data.bucket || "(not configured)"}
                </span>
              </span>
              <span className="inline-flex items-center gap-2">
                <span className="text-muted-foreground">Status:</span>
                {data.backend.ok ? (
                  <Badge variant="outline" className="border-emerald-500/40 text-emerald-600">
                    healthy
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-red-500/40 text-red-600">
                    unreachable
                  </Badge>
                )}
              </span>
              {typeof data.backend.latencyMs === "number" && (
                <span className="inline-flex items-center gap-2">
                  <span className="text-muted-foreground">Ping:</span>
                  <span className="tabular-nums">{data.backend.latencyMs} ms</span>
                </span>
              )}
              {data.backend.error && (
                <span className="text-xs text-red-600">{data.backend.error}</span>
              )}
              <span className="ml-auto text-xs text-muted-foreground">
                {data.totals.orgs} orgs · snapshot {new Date(data.generated).toLocaleString()}
              </span>
            </>
          )}
        </CardContent>
      </Card>

      {/* Distributions */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <DonutCard
          title="By status"
          description="Lifecycle stage of every row."
          data={data?.statusBreakdown ?? []}
        />
        <DonutCard
          title="By scan verdict"
          description="AV pipeline outcome. Anything not clean/skipped blocks downloads."
          data={data?.scanBreakdown ?? []}
        />
        <DonutCard
          title="By classification"
          description="Sensitivity label. Active rows only."
          data={data?.classificationBreakdown ?? []}
        />
      </div>

      {/* MIME + extension */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Top MIME types</CardTitle>
            <CardDescription>By total bytes (active rows).</CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart
              data={kvToBarBytes(data?.topMimes ?? [])}
              formatV={formatBytes}
              height={220}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Top extensions</CardTitle>
            <CardDescription>
              Useful when MIME degenerates to application/octet-stream.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart
              data={kvToBarBytes(data?.topExtensions ?? [])}
              formatV={formatBytes}
              height={220}
            />
          </CardContent>
        </Card>
      </div>

      {/* Trash age */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Archive className="h-4 w-4" /> Trash age
          </CardTitle>
          <CardDescription>
            Soft-deleted bytes by age. Older buckets are cheap purge wins.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BarChart
            data={(data?.trashAge ?? []).map((b) => ({ label: b.bucket, value: b.bytes }))}
            formatV={formatBytes}
            height={180}
          />
        </CardContent>
      </Card>

      {/* Top orgs + top files */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Top workspaces by usage</CardTitle>
            <CardDescription>Click through to the org's analytics.</CardDescription>
          </CardHeader>
          <CardContent>
            <TopList
              items={(data?.topOrgs ?? []).map((o) => ({
                id: o.orgId,
                label: o.orgName || o.orgId,
                value: o.activeBytes,
                sub: `${formatCount(o.activeFiles)} files · ${formatBytes(o.trashedBytes)} trashed${
                  o.legalHoldRows > 0 ? ` · ${o.legalHoldRows} on hold` : ""
                }`,
              }))}
              formatV={formatBytes}
              href={(id) => `/admin/orgs/${id}/analytics`}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileWarning className="h-4 w-4" />
              Largest files
            </CardTitle>
            <CardDescription>
              Heaviest objects regardless of trash state — the usual cost outliers.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TopList
              items={(data?.topFiles ?? []).map((f) => ({
                id: f.id,
                label: f.name,
                value: f.size,
                sub: `${f.orgName} · ${f.mime}${f.legalHold ? " · 🔒 legal hold" : ""}${
                  f.trashed ? " · 🗑 trashed" : ""
                }${f.scanStatus === "infected" ? " · ⚠ infected" : ""}`,
              }))}
              formatV={formatBytes}
              href={(id) => `/admin/storage/inventory?focus=${id}`}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="h-4 w-4" /> Quick actions
          </CardTitle>
          <CardDescription>Cleanup workflows live on dedicated pages.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/storage/inventory">Browse inventory</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/storage/trash">Purge trash</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/storage/inventory?status=pending">Stuck uploads</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/storage/inventory?scanStatus=infected">Quarantined files</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// kvToBarBytes flips the API's (label, count, bytes) shape into the
// chart's expected (label, value) by promoting bytes → value.
function kvToBarBytes(rows: KV[]): LabelValue[] {
  return rows.map((r) => ({ label: r.label, value: r.bytes ?? r.value }));
}

// DonutCard — tiny wrapper so the three distribution donuts share their
// loading/empty state shell.
function DonutCard({
  title,
  description,
  data,
}: {
  title: string;
  description: string;
  data: KV[];
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Donut data={data.map((d) => ({ label: d.label, value: d.value }))} size={150} />
      </CardContent>
    </Card>
  );
}
