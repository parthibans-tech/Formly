// Storage inventory — paginated cross-tenant file browser with filters
// and per-row admin actions.
//
// Design notes:
//
//   - Filters live in URL search params so an operator can paste the
//     link into a Slack thread and the recipient sees the same view.
//     We reflect changes back into the URL without forcing a full
//     navigation (`router.replace`).
//
//   - Pagination is keyset (cursor-based). The API returns a
//     `nextCursor` opaque string when more rows exist; we stash a
//     stack of cursors so the user can also page back.
//
//   - Bulk select → bulk-purge with a real confirmation dialog. We
//     surface a dry-run preview before the destructive call so the
//     operator sees the count + bytes about to disappear, AND any
//     legal-hold rows that will be skipped.
//
//   - Per-row "purge" is a single-file fast path that goes straight
//     through confirm → POST /files/{id}/purge. Legal-hold rows render
//     a disabled lock chip instead of a purge button.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Eye,
  Filter,
  Lock,
  RefreshCcw,
  ShieldAlert,
  Trash2,
  X,
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
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import { formatBytes } from "@/components/admin-charts";

type Row = {
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

type ListResp = {
  files: Row[];
  nextCursor?: string;
};

type BulkPurgeResp = {
  dryRun: boolean;
  requested: number;
  purged: number;
  skippedLegalHold: number;
  notFound: number;
  freedBytes: number;
  storageErrs: number;
  protectedIds?: string[];
};

const STATUS_OPTIONS = ["", "active", "pending", "scanning", "rejected", "quota_blocked"];
const SCAN_OPTIONS = ["", "pending", "scanning", "clean", "infected", "error", "skipped"];
const CLASS_OPTIONS = ["", "public", "internal", "confidential", "restricted"];
const TRASH_OPTIONS = [
  { value: "", label: "Active only" },
  { value: "include", label: "Include trashed" },
  { value: "only", label: "Only trashed" },
];

export default function StorageInventoryPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const toast = useToast();
  const confirm = useConfirm();

  // Filter state (local, hydrated from URL).
  const [q, setQ] = useState(sp.get("q") ?? "");
  const [orgId, setOrgId] = useState(sp.get("orgId") ?? "");
  const [ownerEmail, setOwnerEmail] = useState(sp.get("ownerEmail") ?? "");
  const [status, setStatus] = useState(sp.get("status") ?? "");
  const [scanStatus, setScanStatus] = useState(sp.get("scanStatus") ?? "");
  const [classification, setClassification] = useState(sp.get("classification") ?? "");
  const [mime, setMime] = useState(sp.get("mime") ?? "");
  const [trashMode, setTrashMode] = useState(sp.get("trashMode") ?? "");
  const [legalHold, setLegalHold] = useState(sp.get("legalHold") ?? "");

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Cursor stack: [undefined, c1, c2, ...]. Index 0 = page 1 (no cursor).
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [pageIdx, setPageIdx] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);

  const buildQuery = useCallback(
    (cursor: string | undefined): string => {
      const p = new URLSearchParams();
      if (q) p.set("q", q);
      if (orgId) p.set("orgId", orgId);
      if (ownerEmail) p.set("ownerEmail", ownerEmail);
      if (status) p.set("status", status);
      if (scanStatus) p.set("scanStatus", scanStatus);
      if (classification) p.set("classification", classification);
      if (mime) p.set("mime", mime);
      if (legalHold) p.set("legalHold", legalHold);
      switch (trashMode) {
        case "include":
          p.set("includeTrashed", "true");
          break;
        case "only":
          p.set("onlyTrashed", "true");
          break;
      }
      if (cursor) p.set("cursor", cursor);
      p.set("limit", "50");
      return p.toString();
    },
    [q, orgId, ownerEmail, status, scanStatus, classification, mime, legalHold, trashMode],
  );

  const load = useCallback(
    async (cursor: string | undefined) => {
      setLoading(true);
      try {
        const r = await api<ListResp>(
          `/v1/admin/storage/inventory?${buildQuery(cursor)}`,
        );
        setRows(r.files);
        setNextCursor(r.nextCursor);
        setForbidden(false);
        setSelected(new Set());
      } catch (e: any) {
        if (e?.status === 403) setForbidden(true);
        else toast.show("error", "Couldn't load inventory", { description: e?.message });
      } finally {
        setLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [buildQuery],
  );

  // Sync filters to URL (without cursor — navigating filters always
  // resets to page 1).
  useEffect(() => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (orgId) p.set("orgId", orgId);
    if (ownerEmail) p.set("ownerEmail", ownerEmail);
    if (status) p.set("status", status);
    if (scanStatus) p.set("scanStatus", scanStatus);
    if (classification) p.set("classification", classification);
    if (mime) p.set("mime", mime);
    if (legalHold) p.set("legalHold", legalHold);
    if (trashMode) p.set("trashMode", trashMode);
    router.replace("/admin/storage/inventory" + (p.size ? `?${p.toString()}` : ""), {
      scroll: false,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, orgId, ownerEmail, status, scanStatus, classification, mime, legalHold, trashMode]);

  // Reset cursor stack on any filter change.
  useEffect(() => {
    setCursors([undefined]);
    setPageIdx(0);
    load(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, orgId, ownerEmail, status, scanStatus, classification, mime, legalHold, trashMode]);

  function clearFilters() {
    setQ("");
    setOrgId("");
    setOwnerEmail("");
    setStatus("");
    setScanStatus("");
    setClassification("");
    setMime("");
    setTrashMode("");
    setLegalHold("");
  }

  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  function toggleAllOnPage() {
    if (allOnPageSelected) {
      const next = new Set(selected);
      for (const r of rows) next.delete(r.id);
      setSelected(next);
    } else {
      const next = new Set(selected);
      for (const r of rows) if (!r.legalHold) next.add(r.id);
      setSelected(next);
    }
  }
  function toggleOne(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function purgeOne(row: Row) {
    if (row.legalHold) return;
    const ok = await confirm({
      title: "Purge file?",
      description: `Hard-delete "${row.name}" (${formatBytes(row.size)}) from ${row.orgName}. This removes the row AND the storage object. Cannot be undone.`,
      confirmLabel: "Purge",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/admin/storage/files/${row.id}/purge`, { method: "POST" });
      toast.show("success", "File purged", {
        description: `${row.name} (${formatBytes(row.size)}) removed.`,
      });
      load(cursors[pageIdx]);
    } catch (e: any) {
      toast.show("error", "Purge failed", { description: e?.message });
    }
  }

  async function bulkPurge() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;

    // Dry-run first so the operator sees the precise impact.
    let dry: BulkPurgeResp;
    try {
      dry = await api<BulkPurgeResp>("/v1/admin/storage/files/bulk-purge", {
        method: "POST",
        body: JSON.stringify({ ids, dryRun: true }),
      });
    } catch (e: any) {
      toast.show("error", "Couldn't compute impact", { description: e?.message });
      return;
    }
    const note = dry.skippedLegalHold > 0
      ? `\n\n${dry.skippedLegalHold} file(s) on legal hold will be skipped.`
      : "";
    const missing = dry.notFound > 0 ? `\n\n${dry.notFound} id(s) no longer exist.` : "";
    const ok = await confirm({
      title: `Purge ${dry.purged} file(s)?`,
      description: `This will hard-delete ${dry.purged} file(s) freeing ${formatBytes(
        dry.freedBytes,
      )}.${note}${missing}\n\nThis cannot be undone.`,
      confirmLabel: `Purge ${dry.purged}`,
      destructive: true,
    });
    if (!ok) return;

    try {
      const res = await api<BulkPurgeResp>("/v1/admin/storage/files/bulk-purge", {
        method: "POST",
        body: JSON.stringify({ ids, dryRun: false }),
      });
      toast.show("success", "Bulk purge complete", {
        description: `${res.purged} purged · ${formatBytes(res.freedBytes)} freed${
          res.skippedLegalHold ? ` · ${res.skippedLegalHold} legal-hold skipped` : ""
        }${res.storageErrs ? ` · ${res.storageErrs} storage errors` : ""}`,
      });
      setSelected(new Set());
      load(cursors[pageIdx]);
    } catch (e: any) {
      toast.show("error", "Bulk purge failed", { description: e?.message });
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
            Storage inventory is restricted to platform operators.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const filterCount = useMemo(
    () =>
      [q, orgId, ownerEmail, status, scanStatus, classification, mime, legalHold, trashMode]
        .filter(Boolean).length,
    [q, orgId, ownerEmail, status, scanStatus, classification, mime, legalHold, trashMode],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Button asChild variant="ghost" size="sm" className="-ml-3">
            <Link href="/admin/storage">
              <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to overview
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold">Storage inventory</h1>
          <p className="text-sm text-muted-foreground">
            Cross-tenant file browser. Filter, inspect, purge.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            <Filter className="mr-1 h-3 w-3" /> {filterCount} active
          </Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => load(cursors[pageIdx])}
            disabled={loading}
          >
            <RefreshCcw className={"mr-1.5 h-4 w-4 " + (loading ? "animate-spin" : "")} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Filter row */}
      <Card>
        <CardContent className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <FilterInput
            label="Search (name / key)"
            value={q}
            onChange={setQ}
            placeholder="invoice.pdf"
          />
          <FilterInput
            label="Org ID"
            value={orgId}
            onChange={setOrgId}
            placeholder="uuid"
            mono
          />
          <FilterInput
            label="Owner email"
            value={ownerEmail}
            onChange={setOwnerEmail}
            placeholder="user@org"
          />
          <FilterInput
            label="MIME"
            value={mime}
            onChange={setMime}
            placeholder="application/pdf"
            mono
          />
          <FilterSelect
            label="Status"
            value={status}
            onChange={setStatus}
            options={STATUS_OPTIONS}
          />
          <FilterSelect
            label="Scan"
            value={scanStatus}
            onChange={setScanStatus}
            options={SCAN_OPTIONS}
          />
          <FilterSelect
            label="Classification"
            value={classification}
            onChange={setClassification}
            options={CLASS_OPTIONS}
          />
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Trash
            </label>
            <Select
              value={trashMode || "_none"}
              onValueChange={(v) => setTrashMode(v === "_none" ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRASH_OPTIONS.map((o) => (
                  <SelectItem key={o.value || "_none"} value={o.value || "_none"}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Legal hold
            </label>
            <Select
              value={legalHold || "_any"}
              onValueChange={(v) => setLegalHold(v === "_any" ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_any">Any</SelectItem>
                <SelectItem value="true">On hold</SelectItem>
                <SelectItem value="false">Not on hold</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2 lg:col-span-4 flex justify-end">
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <X className="mr-1.5 h-4 w-4" /> Clear filters
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Bulk action bar — only shown when something is selected */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between rounded-md border bg-amber-50 px-3 py-2 text-sm dark:bg-amber-950/30">
          <span className="inline-flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-600" />
            <strong>{selected.size}</strong> file(s) selected
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button variant="destructive" size="sm" onClick={bulkPurge}>
              <Trash2 className="mr-1.5 h-4 w-4" /> Bulk purge
            </Button>
          </div>
        </div>
      )}

      {/* Rows */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="w-8 p-2">
                    <input
                      type="checkbox"
                      checked={allOnPageSelected}
                      onChange={toggleAllOnPage}
                      aria-label="Select all on this page"
                    />
                  </th>
                  <th className="p-2 text-left">Name</th>
                  <th className="p-2 text-left">Org / Owner</th>
                  <th className="p-2 text-left">Size</th>
                  <th className="p-2 text-left">Status</th>
                  <th className="p-2 text-left">Created</th>
                  <th className="p-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && rows.length === 0 ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i} className="border-b">
                      <td colSpan={7} className="p-2">
                        <Skeleton className="h-6 w-full" />
                      </td>
                    </tr>
                  ))
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-6 text-center text-muted-foreground">
                      No files match these filters.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr
                      key={r.id}
                      className={
                        "border-b transition-colors " +
                        (selected.has(r.id) ? "bg-amber-50/50 dark:bg-amber-950/10" : "")
                      }
                    >
                      <td className="p-2 align-top">
                        <input
                          type="checkbox"
                          checked={selected.has(r.id)}
                          onChange={() => toggleOne(r.id)}
                          disabled={r.legalHold}
                          aria-label={`Select ${r.name}`}
                        />
                      </td>
                      <td className="p-2 align-top">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0">
                            <div className="truncate font-medium">{r.name}</div>
                            <div className="truncate text-[11px] text-muted-foreground">
                              <span className="font-mono">{r.mime}</span> ·{" "}
                              <span className="font-mono">{r.classification}</span>
                              {r.trashed && (
                                <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                                  trashed
                                </span>
                              )}
                              {r.legalHold && (
                                <span className="ml-2 inline-flex items-center gap-0.5 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
                                  <Lock className="h-2.5 w-2.5" /> hold
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">
                              {r.storageKey}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="p-2 align-top">
                        <Link
                          href={`/admin/orgs/${r.orgId}/analytics`}
                          className="text-blue-600 hover:underline"
                        >
                          {r.orgName || r.orgId.slice(0, 8)}
                        </Link>
                        {r.ownerEmail && (
                          <div className="text-[11px] text-muted-foreground">{r.ownerEmail}</div>
                        )}
                      </td>
                      <td className="p-2 align-top tabular-nums">{formatBytes(r.size)}</td>
                      <td className="p-2 align-top">
                        <ScanBadge status={r.status} scanStatus={r.scanStatus} />
                      </td>
                      <td className="p-2 align-top text-xs text-muted-foreground">
                        {new Date(r.createdAt).toLocaleString()}
                      </td>
                      <td className="p-2 align-top">
                        <div className="flex justify-end gap-1">
                          <Button asChild variant="ghost" size="sm">
                            <Link href={`/admin/storage/files/${r.id}`}>
                              <Eye className="h-4 w-4" />
                            </Link>
                          </Button>
                          {r.legalHold ? (
                            <Button variant="ghost" size="sm" disabled title="Legal hold">
                              <Lock className="h-4 w-4 text-muted-foreground" />
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => purgeOne(r)}
                              title="Hard-delete"
                            >
                              <Trash2 className="h-4 w-4 text-red-600" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t p-2 text-xs text-muted-foreground">
            <span>
              Page {pageIdx + 1} · {rows.length} row(s)
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={pageIdx === 0}
                onClick={() => {
                  const next = pageIdx - 1;
                  setPageIdx(next);
                  load(cursors[next]);
                }}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!nextCursor}
                onClick={() => {
                  if (!nextCursor) return;
                  const newCursors = [...cursors.slice(0, pageIdx + 1), nextCursor];
                  setCursors(newCursors);
                  setPageIdx(pageIdx + 1);
                  load(nextCursor);
                }}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function FilterInput({
  label,
  value,
  onChange,
  placeholder,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={mono ? "font-mono text-xs" : ""}
      />
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      <Select value={value || "_any"} onValueChange={(v) => onChange(v === "_any" ? "" : v)}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o || "_any"} value={o || "_any"}>
              {o || "Any"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ScanBadge collapses (status, scanStatus) into a single coloured pill.
// status carries the lifecycle (pending/active/etc), scanStatus carries
// the AV verdict — we surface the more alarming of the two.
function ScanBadge({ status, scanStatus }: { status: string; scanStatus: string }) {
  if (scanStatus === "infected") {
    return <Badge className="bg-red-500/10 text-red-600 hover:bg-red-500/20">infected</Badge>;
  }
  if (scanStatus === "error") {
    return <Badge className="bg-orange-500/10 text-orange-600">scan error</Badge>;
  }
  if (status === "pending") {
    return <Badge variant="outline">pending</Badge>;
  }
  if (status === "rejected" || status === "quota_blocked") {
    return <Badge className="bg-orange-500/10 text-orange-600">{status}</Badge>;
  }
  if (scanStatus === "scanning") {
    return <Badge variant="outline">scanning</Badge>;
  }
  return <Badge className="bg-emerald-500/10 text-emerald-600">{status}</Badge>;
}
