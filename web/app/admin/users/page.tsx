"use client";

// Super-admin user management — Phase 1.
//
// What lives here
// ---------------
// One list view (search + filters + paged table) with a right-side
// drawer that opens when you click a row. Drawer has four tabs:
// Overview, Memberships, Security, Audit.
//
// Why a drawer instead of a route
// -------------------------------
// Operators jump between users constantly when triaging a support
// ticket — "look at the reporter, then the alleged bad actor, then
// their teammates." A full page navigation per user adds back/forward
// friction. Keeping the list visible behind the drawer preserves
// scroll position and the active filter state.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  BarChart3,
  Download,
  Inbox,
  Key,
  KeyRound,
  Lock,
  LogOut,
  RefreshCcw,
  Search,
  ShieldCheck,
  ShieldOff,
  Unlock,
  UserCog,
} from "lucide-react";
import {
  HourHeatmap,
  KpiTile,
  LineChart,
  formatCount,
  type TimePoint,
} from "@/components/admin-charts";
import { api, API_URL, getToken } from "@/lib/api";
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

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "editor" | "viewer";
  orgId: string;
  orgName: string;
  hasMfa: boolean;
  lockedAt?: string | null;
  lockReason?: string | null;
  createdAt: string;
  lastSeenAt?: string | null;
};

type Membership = {
  orgId: string;
  orgName: string;
  role: string;
  source: string;
};

type Session = {
  id: string;
  ip: string;
  userAgent: string;
  createdAt: string;
  lastActiveAt: string;
};

type AuditEntry = {
  at: string;
  action: string;
  ip: string;
  meta?: Record<string, any> | null;
};

type UserDetail = UserRow & {
  memberships: Membership[];
  sessions: Session[];
  recentAudit: AuditEntry[];
};

export default function AdminUsersPage() {
  const toast = useToast();
  const confirm = useConfirm();

  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [q, setQ] = useState("");
  const [orgFilter, setOrgFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState("");

  // Drawer state lives in the page so the list keeps mounted while
  // the drawer is open — no flicker on close.
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Lock dialog needs its own state so we can reuse it from both the
  // row action and the drawer footer.
  const [lockTarget, setLockTarget] = useState<UserRow | null>(null);
  const [lockReason, setLockReason] = useState("");

  // Bulk-select state — sticky toolbar surfaces lock / unlock when
  // at least one row is checked.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkLockOpen, setBulkLockOpen] = useState(false);
  const [bulkLockReason, setBulkLockReason] = useState("");

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectAllVisible() {
    if (!rows) return;
    const eligible = rows.filter((u) => !u.lockedAt).map((u) => u.id);
    setSelected((prev) => {
      const next = new Set(prev);
      eligible.forEach((id) => next.add(id));
      return next;
    });
  }
  function clearSelection() {
    setSelected(new Set());
  }

  async function exportCSV() {
    try {
      const qs = new URLSearchParams();
      if (q) qs.set("q", q);
      if (orgFilter) qs.set("orgId", orgFilter);
      if (statusFilter) qs.set("status", statusFilter);
      if (roleFilter) qs.set("role", roleFilter);
      const res = await fetch(
        `${API_URL}/v1/admin/users/export.csv?` + qs.toString(),
        { headers: { Authorization: `Bearer ${getToken() ?? ""}` } }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `formly-users-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.show("success", "Export downloaded");
    } catch (e: any) {
      toast.show("error", "Export failed", { description: e?.message });
    }
  }

  async function bulkLockSubmit() {
    try {
      const r = await api<{ requested: number; affected: number }>(
        "/v1/admin/users/bulk-lock",
        {
          method: "POST",
          body: JSON.stringify({
            ids: Array.from(selected),
            reason: bulkLockReason,
          }),
        }
      );
      toast.show(
        "success",
        `Locked ${r.affected} of ${r.requested} accounts`
      );
      setBulkLockOpen(false);
      setBulkLockReason("");
      clearSelection();
      await load();
    } catch (e: any) {
      toast.show("error", e?.message || "Bulk lock failed");
    }
  }

  async function bulkUnlock() {
    try {
      const r = await api<{ requested: number; affected: number }>(
        "/v1/admin/users/bulk-unlock",
        {
          method: "POST",
          body: JSON.stringify({ ids: Array.from(selected) }),
        }
      );
      toast.show(
        "success",
        `Unlocked ${r.affected} of ${r.requested} accounts`
      );
      clearSelection();
      await load();
    } catch (e: any) {
      toast.show("error", e?.message || "Bulk unlock failed");
    }
  }

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const qs = new URLSearchParams();
      if (q) qs.set("q", q);
      if (orgFilter) qs.set("orgId", orgFilter);
      if (statusFilter) qs.set("status", statusFilter);
      if (roleFilter) qs.set("role", roleFilter);
      qs.set("limit", "200");
      const res = await api<{ users: UserRow[] }>(
        "/v1/admin/users?" + qs.toString()
      );
      setRows(res.users || []);
      setForbidden(false);
    } catch (e: any) {
      if (e?.status === 403) {
        setForbidden(true);
        setRows([]);
      } else {
        toast.show("error", "Couldn't load users", { description: e?.message });
        setRows([]);
      }
    } finally {
      setRefreshing(false);
    }
    // toast is a fresh object every render — including it would re-create
    // `load` and re-fire the debounced effect on every keystroke
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, orgFilter, statusFilter, roleFilter]);

  // Debounced search: rebuild the query 300ms after the user stops
  // typing so the API isn't hammered on every keystroke.
  useEffect(() => {
    setRows(null);
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  // Drawer detail loader — keyed on openId so reopening the same user
  // refetches (cheap, and reflects any actions taken since last view).
  useEffect(() => {
    if (!openId) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    api<UserDetail>(`/v1/admin/users/${openId}`)
      .then(setDetail)
      .catch((e) => toast.show("error", e?.message || "Failed to load user"))
      .finally(() => setDetailLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  async function unlock(u: UserRow) {
    try {
      await api(`/v1/admin/users/${u.id}/unlock`, { method: "POST" });
      toast.show("success", `${u.email} unlocked`);
      await load();
      if (openId === u.id) refreshDetail();
    } catch (e: any) {
      toast.show("error", e?.message || "Unlock failed");
    }
  }

  async function lockSubmit() {
    if (!lockTarget) return;
    try {
      await api(`/v1/admin/users/${lockTarget.id}/lock`, {
        method: "POST",
        body: JSON.stringify({ reason: lockReason }),
      });
      toast.show("success", `${lockTarget.email} locked`, {
        description: "Active sessions revoked.",
      });
      setLockTarget(null);
      setLockReason("");
      await load();
      if (openId === lockTarget.id) refreshDetail();
    } catch (e: any) {
      toast.show("error", e?.message || "Lock failed");
    }
  }

  async function resetMFA(u: UserRow) {
    const ok = await confirm({
      title: `Reset 2FA for ${u.email}?`,
      description:
        "Their authenticator and recovery codes stop working immediately. They'll sign in with just their password and re-enroll. Use only when they've genuinely lost their device.",
      confirmLabel: "Reset 2FA",
      destructive: true,
    });
    if (!ok) return;
    try {
      const r = await api<{ hadMFA: boolean }>(
        `/v1/admin/users/${u.id}/reset-mfa`,
        { method: "POST" }
      );
      toast.show(
        "success",
        r.hadMFA ? `2FA reset for ${u.email}` : `${u.email} had no 2FA enrolled`
      );
      await load();
      if (openId === u.id) refreshDetail();
    } catch (e: any) {
      toast.show("error", e?.message || "Reset failed");
    }
  }

  async function forcePasswordReset(u: UserRow) {
    const ok = await confirm({
      title: `Force password reset for ${u.email}?`,
      description:
        "Their current password keeps working until they next sign in — at that point they'll be forced to choose a new one before they can use the app. All active sessions are revoked.",
      confirmLabel: "Force reset",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/admin/users/${u.id}/force-password-reset`, {
        method: "POST",
      });
      toast.show("success", `${u.email} will reset on next sign-in`);
      if (openId === u.id) refreshDetail();
    } catch (e: any) {
      toast.show("error", e?.message || "Force reset failed");
    }
  }

  async function revokeSessions(u: UserRow) {
    const ok = await confirm({
      title: `Sign ${u.email} out everywhere?`,
      description:
        "Every active session for this user will be revoked. They'll need to sign in again on all devices.",
      confirmLabel: "Revoke all sessions",
      destructive: true,
    });
    if (!ok) return;
    try {
      const r = await api<{ revoked: number }>(
        `/v1/admin/users/${u.id}/sessions`,
        { method: "DELETE" }
      );
      toast.show("success", `${r.revoked} session${r.revoked === 1 ? "" : "s"} revoked`);
      if (openId === u.id) refreshDetail();
    } catch (e: any) {
      toast.show("error", e?.message || "Revoke failed");
    }
  }

  function refreshDetail() {
    if (!openId) return;
    api<UserDetail>(`/v1/admin/users/${openId}`).then(setDetail).catch(() => {});
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
            Cross-org user management is restricted to platform operators.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Users (all orgs)
          </h1>
          <p className="text-sm text-muted-foreground">
            Search the whole platform. Lock accounts, reset MFA, or kill stuck
            sessions for any user.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href="/admin/users/analytics">
              <BarChart3 className="h-3.5 w-3.5" />
              Analytics
            </Link>
          </Button>
          <Button size="sm" variant="outline" onClick={exportCSV}>
            <Download className="h-3.5 w-3.5" />
            Export
          </Button>
        </div>
      </div>

      {/* Compact filter toolbar. */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card p-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search email or name…"
            className="h-8 pl-8"
          />
        </div>
        <Input
          value={orgFilter}
          onChange={(e) => setOrgFilter(e.target.value)}
          placeholder="Org UUID"
          className="h-8 w-[160px] font-mono text-xs"
        />
        <Select
          value={statusFilter || "all"}
          onValueChange={(v) => setStatusFilter(v === "all" ? "" : v)}
        >
          <SelectTrigger className="h-8 w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="locked">Locked</SelectItem>
            <SelectItem value="no_mfa">No MFA</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={roleFilter || "all"}
          onValueChange={(v) => setRoleFilter(v === "all" ? "" : v)}
        >
          <SelectTrigger className="h-8 w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any role</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="editor">Editor</SelectItem>
            <SelectItem value="viewer">Viewer</SelectItem>
          </SelectContent>
        </Select>
        {(q || orgFilter || statusFilter || roleFilter) && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8"
            onClick={() => {
              setQ("");
              setOrgFilter("");
              setStatusFilter("");
              setRoleFilter("");
            }}
          >
            Clear
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {rows?.length ?? 0} users
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

      {selected.size > 0 && (
        <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-md border bg-background/95 p-2 shadow-sm backdrop-blur">
          <span className="text-xs font-medium">
            {selected.size} selected
          </span>
          <Button size="sm" variant="ghost" className="h-7" onClick={selectAllVisible}>
            Select all visible
          </Button>
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              onClick={() => {
                setBulkLockOpen(true);
                setBulkLockReason("");
              }}
            >
              <Lock className="h-3.5 w-3.5" />
              Lock
            </Button>
            <Button size="sm" variant="outline" onClick={bulkUnlock}>
              <Unlock className="h-3.5 w-3.5" />
              Unlock
            </Button>
            <Button size="sm" variant="ghost" onClick={clearSelection}>
              Clear
            </Button>
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Users</CardTitle>
          <CardDescription>
            Click any row for the detail drawer. Tick a row to enable bulk
            lock / unlock; common per-user actions are inline.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows === null ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <div className="grid place-items-center gap-2 rounded-md border border-dashed bg-muted/30 p-10 text-center text-sm text-muted-foreground">
              <Inbox className="h-8 w-8" />
              No users match these filters.
            </div>
          ) : (
            <ul className="divide-y">
              {rows.map((u) => (
                <UserRowItem
                  key={u.id}
                  u={u}
                  selected={selected.has(u.id)}
                  onToggle={() => toggleSelected(u.id)}
                  onOpen={() => setOpenId(u.id)}
                  onLock={() => {
                    setLockTarget(u);
                    setLockReason("");
                  }}
                  onUnlock={() => unlock(u)}
                  onResetMFA={() => resetMFA(u)}
                  onRevokeSessions={() => revokeSessions(u)}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Detail modal */}
      <Dialog
        open={!!openId}
        onOpenChange={(o) => !o && setOpenId(null)}
      >
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          {detailLoading || !detail ? (
            <div className="space-y-3">
              <Skeleton className="h-8 w-2/3" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : (
            <DetailPanel
              detail={detail}
              onLock={() => {
                setLockTarget(detail);
                setLockReason("");
              }}
              onUnlock={() => unlock(detail)}
              onResetMFA={() => resetMFA(detail)}
              onRevokeSessions={() => revokeSessions(detail)}
              onForcePasswordReset={() => forcePasswordReset(detail)}
              onAuditFilterChange={(prefix) => {
                if (!openId) return;
                setDetailLoading(true);
                const qs = prefix ? "?auditAction=" + encodeURIComponent(prefix) : "";
                api<UserDetail>(`/v1/admin/users/${openId}${qs}`)
                  .then(setDetail)
                  .catch((e) =>
                    toast.show("error", e?.message || "Failed to refresh audit")
                  )
                  .finally(() => setDetailLoading(false));
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Lock dialog */}
      <Dialog
        open={!!lockTarget}
        onOpenChange={(o) => {
          if (!o) {
            setLockTarget(null);
            setLockReason("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5 text-destructive" />
              Lock {lockTarget?.email}?
            </DialogTitle>
            <DialogDescription>
              Sign-in is blocked until you unlock. All active sessions are
              revoked immediately. Reason is required for the audit trail.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="lock-reason">Reason</Label>
            <Input
              id="lock-reason"
              autoFocus
              value={lockReason}
              onChange={(e) => setLockReason(e.target.value)}
              placeholder="Support ticket #1234 — reported account takeover"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLockTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={lockSubmit}
              disabled={!lockReason.trim()}
            >
              <Lock className="h-4 w-4" />
              Lock account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk lock — same shape as the single-user lock dialog, but
          we reuse one reason across every selected ID. The backend
          revokes sessions atomically per row. */}
      <Dialog
        open={bulkLockOpen}
        onOpenChange={(o) => {
          if (!o) {
            setBulkLockOpen(false);
            setBulkLockReason("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5 text-destructive" />
              Lock {selected.size} account{selected.size === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              Each selected user is locked, all their active sessions are
              revoked, and a per-user audit row is written. Operators can
              never lock themselves; that ID is silently skipped.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="bulk-lock-reason">Reason (audit log)</Label>
            <Input
              id="bulk-lock-reason"
              autoFocus
              value={bulkLockReason}
              onChange={(e) => setBulkLockReason(e.target.value)}
              placeholder="Compromised credential set / mass off-boarding / incident #4567"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkLockOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={bulkLockSubmit}
              disabled={!bulkLockReason.trim()}
            >
              <Lock className="h-4 w-4" />
              Lock {selected.size}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function UserRowItem({
  u,
  selected,
  onToggle,
  onOpen,
  onLock,
  onUnlock,
  onResetMFA,
  onRevokeSessions,
}: {
  u: UserRow;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onLock: () => void;
  onUnlock: () => void;
  onResetMFA: () => void;
  onRevokeSessions: () => void;
}) {
  const locked = !!u.lockedAt;
  // Already-locked accounts shouldn't be selectable for bulk-lock
  // (no-op) and bulk-unlock takes the same set, so we hide the
  // checkbox on locked rows. The single-row "Unlock" button is right
  // there — that's the right path for one-off unlocks.
  const selectable = !locked;
  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      {selectable ? (
        <input
          type="checkbox"
          aria-label={`Select ${u.email}`}
          checked={selected}
          onChange={onToggle}
          className="h-4 w-4 cursor-pointer accent-primary"
        />
      ) : (
        <span className="inline-block h-4 w-4" aria-hidden />
      )}
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 text-left"
      >
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{u.name || u.email.split("@")[0]}</span>
          <span className="text-xs text-muted-foreground">{u.email}</span>
          <Badge variant="outline" className="text-[10px]">
            {u.role}
          </Badge>
          {locked && (
            <Badge variant="destructive" className="gap-1 text-[10px]">
              <Lock className="h-3 w-3" />
              Locked
            </Badge>
          )}
          {u.hasMfa ? (
            <Badge variant="secondary" className="gap-1 text-[10px]">
              <ShieldCheck className="h-3 w-3" />
              MFA
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1 text-[10px] text-amber-600">
              <ShieldOff className="h-3 w-3" />
              No MFA
            </Badge>
          )}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {u.orgName || u.orgId.slice(0, 8) + "…"} · joined{" "}
          {new Date(u.createdAt).toLocaleDateString()}
          {u.lastSeenAt && (
            <> · last seen {new Date(u.lastSeenAt).toLocaleDateString()}</>
          )}
        </div>
      </button>
      <div className="flex items-center gap-1">
        {locked ? (
          <Button size="sm" variant="outline" onClick={onUnlock}>
            <Unlock className="h-3.5 w-3.5" />
            Unlock
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={onLock}
            className="text-destructive"
          >
            <Lock className="h-3.5 w-3.5" />
            Lock
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          title="Reset 2FA"
          onClick={onResetMFA}
        >
          <ShieldOff className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          title="Revoke all sessions"
          onClick={onRevokeSessions}
        >
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </li>
  );
}

function DetailPanel({
  detail,
  onLock,
  onUnlock,
  onResetMFA,
  onRevokeSessions,
  onForcePasswordReset,
  onAuditFilterChange,
}: {
  detail: UserDetail;
  onLock: () => void;
  onUnlock: () => void;
  onResetMFA: () => void;
  onRevokeSessions: () => void;
  onForcePasswordReset: () => void;
  onAuditFilterChange: (prefix: string) => void;
}) {
  const [tab, setTab] = useState<
    "overview" | "analytics" | "memberships" | "security" | "audit"
  >("overview");
  const locked = !!detail.lockedAt;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <UserCog className="h-5 w-5" />
          {detail.name || detail.email}
        </DialogTitle>
        <DialogDescription>
          {detail.email} · {detail.orgName || detail.orgId.slice(0, 8) + "…"}
        </DialogDescription>
      </DialogHeader>

      <div className="mt-4 flex gap-1 border-b">
        {(["overview", "analytics", "memberships", "security", "audit"] as const).map((t) => (
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

      <div className="mt-4 space-y-4">
        {tab === "overview" && (
          <OverviewTab
            detail={detail}
            locked={locked}
            onLock={onLock}
            onUnlock={onUnlock}
          />
        )}
        {tab === "analytics" && <UserAnalyticsTab userId={detail.id} />}
        {tab === "memberships" && <MembershipsTab detail={detail} />}
        {tab === "security" && (
          <SecurityTab
            detail={detail}
            onResetMFA={onResetMFA}
            onRevokeSessions={onRevokeSessions}
            onForcePasswordReset={onForcePasswordReset}
          />
        )}
        {tab === "audit" && (
          <AuditTab
            detail={detail}
            onFilterChange={onAuditFilterChange}
          />
        )}
      </div>
    </>
  );
}

function OverviewTab({
  detail,
  locked,
  onLock,
  onUnlock,
}: {
  detail: UserDetail;
  locked: boolean;
  onLock: () => void;
  onUnlock: () => void;
}) {
  return (
    <div className="space-y-3">
      <DetailRow label="User ID" value={detail.id} mono />
      <DetailRow label="Org ID" value={detail.orgId} mono />
      <DetailRow label="Role" value={detail.role} />
      <DetailRow
        label="Joined"
        value={new Date(detail.createdAt).toLocaleString()}
      />
      <DetailRow
        label="Last active"
        value={
          detail.lastSeenAt
            ? new Date(detail.lastSeenAt).toLocaleString()
            : "—"
        }
      />
      {locked && detail.lockReason && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
          <div className="flex items-center gap-1 font-semibold text-destructive">
            <Lock className="h-3.5 w-3.5" />
            Account locked
          </div>
          <div className="mt-1 text-foreground/80">
            {detail.lockReason}
          </div>
          {detail.lockedAt && (
            <div className="mt-1 text-muted-foreground">
              {new Date(detail.lockedAt).toLocaleString()}
            </div>
          )}
        </div>
      )}
      <div className="pt-2">
        {locked ? (
          <Button onClick={onUnlock} className="w-full">
            <Unlock className="h-4 w-4" />
            Unlock account
          </Button>
        ) : (
          <Button variant="destructive" onClick={onLock} className="w-full">
            <Lock className="h-4 w-4" />
            Lock account
          </Button>
        )}
      </div>
    </div>
  );
}

// Per-user analytics drilldown shown inside the detail drawer.
//
// We pull the per-ID series at a fixed 30-day window — matching the
// org drilldown — so support engineers can quickly answer "is this
// account behaving normally?" without hopping to the global page.
type UserIdAnalytics = {
  window: string;
  bucket: string;
  activity: TimePoint[];
  hourlyPattern: number[];
  sessionStarts: TimePoint[];
  failedLogins30d: number;
  actions30d: { total: number; distinct: number };
};

function UserAnalyticsTab({ userId }: { userId: string }) {
  const toast = useToast();
  const [data, setData] = useState<UserIdAnalytics | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<UserIdAnalytics>(`/v1/admin/users/${userId}/analytics?window=30d`)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e) => {
        if (!cancelled) {
          toast.show("error", "Couldn't load analytics", {
            description: e?.message,
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  if (!data) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  // HourHeatmap takes the raw int[24] from the API as-is.
  const heatmap = data.hourlyPattern;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button asChild size="sm" variant="outline">
          <Link href={`/admin/users/${userId}/analytics`}>
            <BarChart3 className="h-3.5 w-3.5" />
            Open full dashboard
          </Link>
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <KpiTile
          label="Actions (30d)"
          value={formatCount(data.actions30d.total)}
          sublabel={`${data.actions30d.distinct} distinct`}
        />
        <KpiTile
          label="Sessions (30d)"
          value={formatCount(
            data.sessionStarts.reduce((a, p) => a + p.value, 0)
          )}
          sublabel="new sign-ins"
        />
        <KpiTile
          label="Failed logins (30d)"
          value={formatCount(data.failedLogins30d)}
          sublabel="security signal"
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs">Activity</CardTitle>
          <CardDescription className="text-[11px]">
            Audit-log events authored by this user, last 30 days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LineChart
            height={140}
            series={[
              { name: "Events", color: "#3b82f6", data: data.activity },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs">Hour-of-day pattern</CardTitle>
          <CardDescription className="text-[11px]">
            Auth events by UTC hour, last 60 days. A spike outside the
            usual band is a strong takeover signal.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <HourHeatmap data={heatmap} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs">Session starts</CardTitle>
          <CardDescription className="text-[11px]">
            New sessions per day — flat line is fine, spikes warrant a look.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LineChart
            height={140}
            series={[
              { name: "Sessions", color: "#22c55e", data: data.sessionStarts },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function MembershipsTab({ detail }: { detail: UserDetail }) {
  if (detail.memberships.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No memberships found.</p>
    );
  }
  return (
    <ul className="divide-y rounded-md border">
      {detail.memberships.map((m) => (
        <li key={m.orgId} className="flex items-center gap-3 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{m.orgName || "(unnamed org)"}</div>
            <div className="font-mono text-[11px] text-muted-foreground">
              {m.orgId}
            </div>
          </div>
          <Badge variant="outline" className="text-[10px]">
            {m.role}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function SecurityTab({
  detail,
  onResetMFA,
  onRevokeSessions,
  onForcePasswordReset,
}: {
  detail: UserDetail;
  onResetMFA: () => void;
  onRevokeSessions: () => void;
  onForcePasswordReset: () => void;
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Key className="h-4 w-4" />
            Two-factor authentication
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            {detail.hasMfa
              ? "Enrolled — TOTP secret stored."
              : "Not enrolled — user signs in with password only."}
          </div>
          <Button size="sm" variant="outline" onClick={onResetMFA}>
            <ShieldOff className="h-3.5 w-3.5" />
            Reset 2FA
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <KeyRound className="h-4 w-4" />
            Password
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            Force the user to choose a new password before they can use
            the app again. Active sessions are revoked.
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={onForcePasswordReset}
            className="shrink-0 text-destructive"
          >
            <KeyRound className="h-3.5 w-3.5" />
            Force reset
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <LogOut className="h-4 w-4" />
            Active sessions ({detail.sessions.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {detail.sessions.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No active sessions.
            </p>
          ) : (
            <>
              <ul className="mb-3 divide-y rounded-md border">
                {detail.sessions.map((s) => (
                  <li key={s.id} className="px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono">{s.ip || "unknown ip"}</span>
                      <span className="text-muted-foreground">
                        {new Date(s.lastActiveAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {s.userAgent || "—"}
                    </div>
                  </li>
                ))}
              </ul>
              <Button
                size="sm"
                variant="outline"
                onClick={onRevokeSessions}
                className="w-full text-destructive"
              >
                <LogOut className="h-3.5 w-3.5" />
                Revoke all sessions
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AuditTab({
  detail,
  onFilterChange,
}: {
  detail: UserDetail;
  onFilterChange: (prefix: string) => void;
}) {
  const [filter, setFilter] = useState("all");
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Label className="text-xs text-muted-foreground">Filter</Label>
        <Select
          value={filter}
          onValueChange={(v) => {
            setFilter(v);
            onFilterChange(v === "all" ? "" : v);
          }}
        >
          <SelectTrigger className="h-8 w-[200px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            <SelectItem value="auth.">auth.*</SelectItem>
            <SelectItem value="super_admin.">super_admin.*</SelectItem>
            <SelectItem value="mfa.">mfa.*</SelectItem>
            <SelectItem value="session.">session.*</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {detail.recentAudit.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No recent audit activity.
        </p>
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
              {e.ip && (
                <div className="text-[11px] text-muted-foreground">{e.ip}</div>
              )}
              {e.meta && Object.keys(e.meta).length > 0 && (
                <pre className="mt-1 max-h-24 overflow-auto rounded bg-muted/40 p-1 font-mono text-[10px]">
                  {JSON.stringify(e.meta, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("text-right", mono && "font-mono")}>{value}</span>
    </div>
  );
}
