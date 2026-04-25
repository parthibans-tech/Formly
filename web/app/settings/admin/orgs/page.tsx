"use client";

// Super-admin organization management — Phase 3.
//
// Mirrors the user-management page in shape: filters card on top, a
// scrolling list, a right-side drawer with tabs. State-changing
// actions (freeze, unfreeze, soft-delete, restore, set quotas) all
// route through this page so an operator never has to touch psql.

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Building2,
  HardDrive,
  Inbox,
  Lock,
  RefreshCcw,
  Search,
  Snowflake,
  Trash2,
  Undo2,
  Users,
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type OrgRow = {
  id: string;
  name: string;
  plan: string;
  userCount: number;
  storageBytes: number;
  maxUsers?: number | null;
  maxStorageBytes?: number | null;
  frozenAt?: string | null;
  frozenReason?: string | null;
  deletedAt?: string | null;
  createdAt: string;
};

type Member = {
  id: string;
  email: string;
  name: string;
  role: string;
};

type AuditEntry = {
  at: string;
  action: string;
  actor: string;
  ip: string;
  meta?: Record<string, any> | null;
};

type OrgDetail = OrgRow & {
  members: Member[];
  recentAudit: AuditEntry[];
};

function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function AdminOrgsPage() {
  const toast = useToast();
  const confirm = useConfirm();

  const [rows, setRows] = useState<OrgRow[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [planFilter, setPlanFilter] = useState("");

  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrgDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [freezeTarget, setFreezeTarget] = useState<OrgRow | null>(null);
  const [freezeReason, setFreezeReason] = useState("");

  const [quotasTarget, setQuotasTarget] = useState<OrgRow | null>(null);
  const [quotaUsers, setQuotaUsers] = useState("");
  const [quotaStorageGB, setQuotaStorageGB] = useState("");

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const qs = new URLSearchParams();
      if (q) qs.set("q", q);
      if (statusFilter) qs.set("status", statusFilter);
      if (planFilter) qs.set("plan", planFilter);
      qs.set("limit", "200");
      const res = await api<{ orgs: OrgRow[] }>(
        "/v1/admin/orgs?" + qs.toString()
      );
      setRows(res.orgs || []);
      setForbidden(false);
    } catch (e: any) {
      if (e?.status === 403) {
        setForbidden(true);
        setRows([]);
      } else {
        toast.show("error", "Couldn't load orgs", { description: e?.message });
        setRows([]);
      }
    } finally {
      setRefreshing(false);
    }
    // toast intentionally omitted — see admin/users page for rationale
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, statusFilter, planFilter]);

  useEffect(() => {
    setRows(null);
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    if (!openId) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    api<OrgDetail>(`/v1/admin/orgs/${openId}`)
      .then(setDetail)
      .catch((e) => toast.show("error", e?.message || "Failed to load org"))
      .finally(() => setDetailLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  function refreshDetail() {
    if (!openId) return;
    api<OrgDetail>(`/v1/admin/orgs/${openId}`).then(setDetail).catch(() => {});
  }

  async function freezeSubmit() {
    if (!freezeTarget) return;
    try {
      await api(`/v1/admin/orgs/${freezeTarget.id}/freeze`, {
        method: "POST",
        body: JSON.stringify({ reason: freezeReason }),
      });
      toast.show("success", `${freezeTarget.name} frozen`, {
        description: "Writes are blocked org-wide; reads still work.",
      });
      setFreezeTarget(null);
      setFreezeReason("");
      await load();
      if (openId === freezeTarget.id) refreshDetail();
    } catch (e: any) {
      toast.show("error", e?.message || "Freeze failed");
    }
  }

  async function unfreeze(o: OrgRow) {
    try {
      await api(`/v1/admin/orgs/${o.id}/unfreeze`, { method: "POST" });
      toast.show("success", `${o.name} unfrozen`);
      await load();
      if (openId === o.id) refreshDetail();
    } catch (e: any) {
      toast.show("error", e?.message || "Unfreeze failed");
    }
  }

  async function softDelete(o: OrgRow) {
    const ok = await confirm({
      title: `Delete ${o.name}?`,
      description:
        "This is a soft-delete: the org is hidden, all sessions are revoked, and sign-in is refused. Restore is possible later from the Deleted view.",
      confirmLabel: "Delete org",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/admin/orgs/${o.id}`, { method: "DELETE" });
      toast.show("success", `${o.name} deleted`);
      await load();
      if (openId === o.id) refreshDetail();
    } catch (e: any) {
      toast.show("error", e?.message || "Delete failed");
    }
  }

  async function restore(o: OrgRow) {
    try {
      await api(`/v1/admin/orgs/${o.id}/restore`, { method: "POST" });
      toast.show("success", `${o.name} restored`);
      await load();
      if (openId === o.id) refreshDetail();
    } catch (e: any) {
      toast.show("error", e?.message || "Restore failed");
    }
  }

  function openQuotas(o: OrgRow) {
    setQuotasTarget(o);
    setQuotaUsers(o.maxUsers != null ? String(o.maxUsers) : "");
    setQuotaStorageGB(
      o.maxStorageBytes != null
        ? String(Math.round(o.maxStorageBytes / (1024 * 1024 * 1024)))
        : ""
    );
  }

  async function saveQuotas() {
    if (!quotasTarget) return;
    const body: any = {};
    if (quotaUsers === "") {
      // explicit "unlimited" — only send if this is a change
      if (quotasTarget.maxUsers != null) body.maxUsers = null;
    } else {
      const n = Number(quotaUsers);
      if (Number.isFinite(n) && n >= 0) body.maxUsers = n;
    }
    if (quotaStorageGB === "") {
      if (quotasTarget.maxStorageBytes != null) body.maxStorageBytes = null;
    } else {
      const n = Number(quotaStorageGB);
      if (Number.isFinite(n) && n >= 0) {
        body.maxStorageBytes = Math.round(n * 1024 * 1024 * 1024);
      }
    }
    if (Object.keys(body).length === 0) {
      setQuotasTarget(null);
      return;
    }
    try {
      await api(`/v1/admin/orgs/${quotasTarget.id}/quotas`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      toast.show("success", `${quotasTarget.name} updated`);
      setQuotasTarget(null);
      await load();
      if (openId === quotasTarget.id) refreshDetail();
    } catch (e: any) {
      toast.show("error", e?.message || "Update failed");
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
            Cross-org workspace management is restricted to platform operators.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Organizations
        </h1>
        <p className="text-sm text-muted-foreground">
          Every workspace on the platform. Freeze a misbehaving tenant,
          adjust their quotas, or soft-delete and restore.
        </p>
      </div>

      {/* Compact filter toolbar — single row, label-via-placeholder. */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card p-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search organizations…"
            className="h-8 pl-8"
          />
        </div>
        <Select
          value={statusFilter || "active"}
          onValueChange={(v) => setStatusFilter(v === "active" ? "" : v)}
        >
          <SelectTrigger className="h-8 w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="frozen">Frozen</SelectItem>
            <SelectItem value="deleted">Deleted</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={planFilter || "all"}
          onValueChange={(v) => setPlanFilter(v === "all" ? "" : v)}
        >
          <SelectTrigger className="h-8 w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any plan</SelectItem>
            <SelectItem value="free">Free</SelectItem>
            <SelectItem value="pro">Pro</SelectItem>
            <SelectItem value="enterprise">Enterprise</SelectItem>
          </SelectContent>
        </Select>
        {(q || statusFilter || planFilter) && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8"
            onClick={() => {
              setQ("");
              setStatusFilter("");
              setPlanFilter("");
            }}
          >
            Clear
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {rows?.length ?? 0} orgs
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={load}
            disabled={refreshing}
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workspaces</CardTitle>
          <CardDescription>
            Click any row for the detail drawer. Inline actions cover the
            common cases.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows === null ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <div className="grid place-items-center gap-2 rounded-md border border-dashed bg-muted/30 p-10 text-center text-sm text-muted-foreground">
              <Inbox className="h-8 w-8" />
              No orgs match these filters.
            </div>
          ) : (
            <ul className="divide-y">
              {rows.map((o) => (
                <OrgRowItem
                  key={o.id}
                  o={o}
                  onOpen={() => setOpenId(o.id)}
                  onFreeze={() => {
                    setFreezeTarget(o);
                    setFreezeReason("");
                  }}
                  onUnfreeze={() => unfreeze(o)}
                  onDelete={() => softDelete(o)}
                  onRestore={() => restore(o)}
                  onQuotas={() => openQuotas(o)}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!openId} onOpenChange={(o) => !o && setOpenId(null)}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          {detailLoading || !detail ? (
            <div className="space-y-3">
              <Skeleton className="h-8 w-2/3" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : (
            <OrgDetailPanel detail={detail} />
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!freezeTarget}
        onOpenChange={(o) => {
          if (!o) {
            setFreezeTarget(null);
            setFreezeReason("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Snowflake className="h-5 w-5 text-blue-500" />
              Freeze {freezeTarget?.name}?
            </DialogTitle>
            <DialogDescription>
              Members can still read, but every write is rejected with 423
              until you unfreeze. API keys for this org stop working too.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="freeze-reason">Reason</Label>
            <Input
              id="freeze-reason"
              autoFocus
              value={freezeReason}
              onChange={(e) => setFreezeReason(e.target.value)}
              placeholder="Non-payment / policy violation / support ticket #1234"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFreezeTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={freezeSubmit}
              disabled={!freezeReason.trim()}
            >
              <Snowflake className="h-4 w-4" />
              Freeze
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!quotasTarget}
        onOpenChange={(o) => !o && setQuotasTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Quotas for {quotasTarget?.name}</DialogTitle>
            <DialogDescription>
              Leave a field blank for unlimited. Storage is in GB.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-[11px] text-muted-foreground">
              These overrides win against the plan defaults. To change
              the plan itself, use the Billing tab in the org details.
            </p>
            <div className="space-y-1.5">
              <Label className="text-xs">Max users</Label>
              <Input
                value={quotaUsers}
                onChange={(e) => setQuotaUsers(e.target.value)}
                inputMode="numeric"
                placeholder="blank = unlimited"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Max storage (GB)</Label>
              <Input
                value={quotaStorageGB}
                onChange={(e) => setQuotaStorageGB(e.target.value)}
                inputMode="numeric"
                placeholder="blank = unlimited"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setQuotasTarget(null)}>
              Cancel
            </Button>
            <Button onClick={saveQuotas}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OrgRowItem({
  o,
  onOpen,
  onFreeze,
  onUnfreeze,
  onDelete,
  onRestore,
  onQuotas,
}: {
  o: OrgRow;
  onOpen: () => void;
  onFreeze: () => void;
  onUnfreeze: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onQuotas: () => void;
}) {
  const frozen = !!o.frozenAt;
  const deleted = !!o.deletedAt;
  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{o.name}</span>
          <Badge variant="outline" className="text-[10px] uppercase">
            {o.plan}
          </Badge>
          {frozen && (
            <Badge variant="secondary" className="gap-1 text-[10px] text-blue-600">
              <Snowflake className="h-3 w-3" />
              Frozen
            </Badge>
          )}
          {deleted && (
            <Badge variant="destructive" className="gap-1 text-[10px]">
              <Trash2 className="h-3 w-3" />
              Deleted
            </Badge>
          )}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          <Users className="mr-1 inline h-3 w-3" />
          {o.userCount}
          {o.maxUsers != null && ` / ${o.maxUsers}`}
          <span className="mx-1.5">·</span>
          <HardDrive className="mr-1 inline h-3 w-3" />
          {formatBytes(o.storageBytes)}
          {o.maxStorageBytes != null && ` / ${formatBytes(o.maxStorageBytes)}`}
          <span className="mx-1.5">·</span>
          created {new Date(o.createdAt).toLocaleDateString()}
        </div>
      </button>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" onClick={onQuotas}>
          Quotas
        </Button>
        {deleted ? (
          <Button size="sm" variant="outline" onClick={onRestore}>
            <Undo2 className="h-3.5 w-3.5" />
            Restore
          </Button>
        ) : frozen ? (
          <Button size="sm" variant="outline" onClick={onUnfreeze}>
            <Snowflake className="h-3.5 w-3.5" />
            Unfreeze
          </Button>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={onFreeze}>
              <Snowflake className="h-3.5 w-3.5" />
              Freeze
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onDelete}
              className="text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

function OrgDetailPanel({ detail }: { detail: OrgDetail }) {
  const [tab, setTab] = useState<
    "overview" | "members" | "billing" | "audit"
  >("overview");
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Building2 className="h-5 w-5" />
          {detail.name}
        </DialogTitle>
        <DialogDescription className="font-mono text-[11px]">
          {detail.id}
        </DialogDescription>
      </DialogHeader>

      <div className="mt-4 flex gap-1 border-b">
        {(["overview", "members", "billing", "audit"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "-mb-px border-b-2 px-3 py-1.5 text-xs capitalize transition-colors",
              tab === t
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-3">
        {tab === "overview" && (
          <>
            <Row label="Plan" value={detail.plan} />
            <Row label="Users" value={`${detail.userCount}${detail.maxUsers != null ? ` / ${detail.maxUsers}` : ""}`} />
            <Row
              label="Storage"
              value={`${formatBytes(detail.storageBytes)}${
                detail.maxStorageBytes != null
                  ? ` / ${formatBytes(detail.maxStorageBytes)}`
                  : ""
              }`}
            />
            <Row
              label="Created"
              value={new Date(detail.createdAt).toLocaleString()}
            />
            {detail.frozenAt && (
              <div className="rounded-md border border-blue-500/30 bg-blue-500/10 p-3 text-xs">
                <div className="flex items-center gap-1 font-semibold text-blue-700">
                  <Snowflake className="h-3.5 w-3.5" />
                  Frozen
                </div>
                {detail.frozenReason && (
                  <div className="mt-1 text-foreground/80">
                    {detail.frozenReason}
                  </div>
                )}
                <div className="mt-1 text-muted-foreground">
                  {new Date(detail.frozenAt).toLocaleString()}
                </div>
              </div>
            )}
            {detail.deletedAt && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
                <div className="flex items-center gap-1 font-semibold text-destructive">
                  <Trash2 className="h-3.5 w-3.5" />
                  Deleted
                </div>
                <div className="mt-1 text-muted-foreground">
                  {new Date(detail.deletedAt).toLocaleString()}
                </div>
              </div>
            )}
          </>
        )}

        {tab === "members" &&
          (detail.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No users.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {detail.members.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center gap-3 px-3 py-2 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">
                      {m.name || m.email.split("@")[0]}
                    </div>
                    <div className="text-muted-foreground">{m.email}</div>
                  </div>
                  <Badge variant="outline" className="text-[10px]">
                    {m.role}
                  </Badge>
                </li>
              ))}
            </ul>
          ))}

        {tab === "billing" && <OrgBillingTab orgId={detail.id} />}

        {tab === "audit" &&
          (detail.recentAudit.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recent audit activity.</p>
          ) : (
            <ul className="divide-y rounded-md border text-xs">
              {detail.recentAudit.map((e, i) => (
                <li key={i} className="px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <code className="font-mono">{e.action}</code>
                    <span className="text-muted-foreground">
                      {new Date(e.at).toLocaleString()}
                    </span>
                  </div>
                  {e.actor && (
                    <div className="text-[11px] text-muted-foreground">
                      {e.actor} {e.ip && `· ${e.ip}`}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ))}
      </div>

      {/* Lock import kept for icon parity with the user drawer */}
      <span className="hidden">
        <Lock />
      </span>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

type AdminBilling = {
  subscription: {
    id: string;
    status: string;
    provider: string;
    planId: string;
    planName: string;
    tier: string;
    currency: string;
    interval: string;
    amountCents?: number | null;
    trialEndsAt?: string | null;
    currentPeriodEnd?: string | null;
    cancelAtPeriodEnd: boolean;
    canceledAt?: string | null;
    updatedAt: string;
  } | null;
  invoices: Array<{
    id: string;
    number: string;
    status: string;
    provider: string;
    currency: string;
    totalCents: number;
    issuedAt: string;
  }>;
};

type AdminPlan = {
  id: string;
  name: string;
  tier: string;
  currency: string;
  interval: string;
  amountCents?: number | null;
};

function OrgBillingTab({ orgId }: { orgId: string }) {
  const toast = useToast();
  const [data, setData] = useState<AdminBilling | null>(null);
  const [allPlans, setAllPlans] = useState<AdminPlan[] | null>(null);
  const [planId, setPlanId] = useState("");
  const [status, setStatus] = useState("active");
  const [noCharge, setNoCharge] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, pInr, pUsd] = await Promise.all([
        api<AdminBilling>(`/v1/admin/orgs/${orgId}/subscription`),
        api<{ plans: AdminPlan[] }>("/v1/billing/plans?currency=INR"),
        api<{ plans: AdminPlan[] }>("/v1/billing/plans?currency=USD"),
      ]);
      setData(d);
      // Merge both currency catalogs and de-dupe so the assign dropdown
      // can pick any plan regardless of the operator's locale. Free /
      // enterprise show up once because the API returns them in both.
      const merged: Record<string, AdminPlan> = {};
      [...(pInr.plans || []), ...(pUsd.plans || [])].forEach((p) => {
        merged[p.id] = p;
      });
      setAllPlans(Object.values(merged));
    } catch (e: any) {
      toast.show("error", "Couldn't load billing", {
        description: e?.message,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  async function assign() {
    if (!planId) return;
    setBusy(true);
    try {
      await api(`/v1/admin/orgs/${orgId}/subscription`, {
        method: "POST",
        body: JSON.stringify({ planId, status, noCharge }),
      });
      toast.show("success", "Subscription updated");
      setPlanId("");
      await load();
    } catch (e: any) {
      toast.show("error", e?.message || "Assignment failed");
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return <Skeleton className="h-32 w-full" />;
  }

  const sub = data.subscription;
  return (
    <div className="space-y-4">
      <div className="rounded-md border p-3 text-xs">
        {sub ? (
          <>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm font-semibold">{sub.planName}</span>
              <Badge
                variant={sub.status === "trialing" ? "default" : "outline"}
                className="text-[10px]"
              >
                {sub.status}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {sub.provider}
              </Badge>
            </div>
            <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
              <Row
                label="Price"
                value={
                  sub.amountCents != null
                    ? `${formatMoney(sub.amountCents, sub.currency)} / ${sub.interval}`
                    : "Custom"
                }
              />
              {sub.trialEndsAt && (
                <Row
                  label="Trial ends"
                  value={new Date(sub.trialEndsAt).toLocaleDateString()}
                />
              )}
              {sub.currentPeriodEnd && (
                <Row
                  label="Renews"
                  value={new Date(sub.currentPeriodEnd).toLocaleDateString()}
                />
              )}
            </div>
          </>
        ) : (
          <p className="text-muted-foreground">No active subscription.</p>
        )}
      </div>

      <div className="space-y-2 rounded-md border p-3">
        <div className="text-xs font-medium">Assign plan (manual)</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Select value={planId} onValueChange={setPlanId}>
            <SelectTrigger>
              <SelectValue placeholder="Select plan" />
            </SelectTrigger>
            <SelectContent>
              {(allPlans || []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                  {p.amountCents != null
                    ? ` — ${formatMoney(p.amountCents, p.currency)}/${p.interval}`
                    : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="trialing">Trialing (14 days)</SelectItem>
              <SelectItem value="past_due">Past due</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={noCharge}
            onChange={(e) => setNoCharge(e.target.checked)}
          />
          Don&apos;t record an invoice (comp / internal move)
        </label>
        <Button size="sm" onClick={assign} disabled={!planId || busy}>
          Apply
        </Button>
      </div>

      <div>
        <div className="mb-1 text-xs font-medium">Recent invoices</div>
        {data.invoices.length === 0 ? (
          <p className="text-xs text-muted-foreground">None yet.</p>
        ) : (
          <ul className="divide-y rounded-md border text-xs">
            {data.invoices.map((inv) => (
              <li
                key={inv.id}
                className="flex items-center gap-3 px-3 py-2"
              >
                <span className="font-mono text-[11px]">{inv.number}</span>
                <Badge variant="outline" className="text-[10px]">
                  {inv.status}
                </Badge>
                <span className="ml-auto text-muted-foreground">
                  {new Date(inv.issuedAt).toLocaleDateString()}
                </span>
                <span className="font-medium">
                  {formatMoney(inv.totalCents, inv.currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function formatMoney(cents: number | null | undefined, currency: string) {
  if (cents == null) return "—";
  const sym = currency === "USD" ? "$" : currency === "INR" ? "₹" : "";
  const major = cents / 100;
  return `${sym}${major.toLocaleString(undefined, {
    minimumFractionDigits: major % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}
