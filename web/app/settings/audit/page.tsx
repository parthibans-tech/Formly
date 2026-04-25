"use client";

// Unified audit module.
//
// One screen for every audited stream — org-scoped for admins, cross-org
// for super-admins (the same page transparently swaps `/v1/audit` for
// `/v1/admin/audit` and adds an Org column). Tabs split the streams by
// kind (Activity = generic audit_log; Email = email_sends). Built so the
// surface is the same from a compliance-officer perspective regardless
// of whether they're auditing one org or all of them.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Building2,
  Download,
  Eye,
  Filter,
  Inbox,
  Mail,
  RefreshCcw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { api, getUser } from "@/lib/api";
import { useToast } from "@/components/toast";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// Normalized row used by the table — both `/v1/audit` and `/v1/admin/audit`
// map onto this shape so the renderer doesn't care which endpoint paid.
type Row = {
  at: string;
  actor: string;
  action: string;
  category: string;
  ip?: string;
  orgId?: string;
  orgName?: string;
  resourceType?: string;
  resourceId?: string;
  meta?: Record<string, any> | null;
};

type EmailRow = {
  id: string;
  at: string;
  orgId?: string;
  subject: string;
  recipients: string[];
  provider: string;
  status: string;
  kind?: string;
  source?: string;
  fromEmail?: string;
  error?: string | null;
  meta?: Record<string, any> | null;
};

// Buckets the raw `action` strings into stable categories so the UI can
// colour-code and filter without enumerating every action prefix.
function categoryFor(action: string): string {
  const a = action.toLowerCase();
  if (a.startsWith("auth.") || a.startsWith("session.") || a.startsWith("mfa.")) return "auth";
  if (a.startsWith("super_admin.") || a.startsWith("platform.")) return "platform";
  if (a.startsWith("billing.") || a.startsWith("subscription.")) return "billing";
  if (a.startsWith("share.") || a.startsWith("acl.") || a.startsWith("link.")) return "sharing";
  if (a.startsWith("file.") || a.startsWith("template.") || a.startsWith("folder.")) return "files";
  if (a.startsWith("user.") || a.startsWith("team.") || a.startsWith("member.")) return "users";
  if (a.startsWith("api_key.") || a.startsWith("webhook.")) return "developer";
  if (a.startsWith("integration.")) return "integrations";
  return "other";
}

const CATEGORY_LABEL: Record<string, string> = {
  auth: "Auth",
  platform: "Platform",
  billing: "Billing",
  sharing: "Sharing",
  files: "Files",
  users: "Users",
  developer: "Developer",
  integrations: "Integrations",
  other: "Other",
};

const CATEGORY_TONE: Record<string, string> = {
  auth: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  platform: "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  billing: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  sharing: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  files: "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  users: "bg-fuchsia-50 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300",
  developer: "bg-orange-50 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  integrations: "bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  other: "bg-muted text-muted-foreground",
};

type TabId = "activity" | "email";

export default function AuditPage() {
  const toast = useToast();
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [tab, setTab] = useState<TabId>("activity");
  const [forbidden, setForbidden] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Activity tab state
  const [rows, setRows] = useState<Row[] | null>(null);
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [category, setCategory] = useState<string>("");
  const [orgId, setOrgId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // Email tab state
  const [emails, setEmails] = useState<EmailRow[] | null>(null);
  const [emailKind, setEmailKind] = useState("");
  const [emailStatus, setEmailStatus] = useState("");
  const [emailSource, setEmailSource] = useState("");

  // Detail drawer
  const [detail, setDetail] = useState<Row | EmailRow | null>(null);

  // Hydrate the role flag once. `ready` gates the first fetch so we
  // don't fire the org-scoped endpoint on render 1 and the cross-org
  // endpoint on render 2 — a classic double-load when isSuperAdmin
  // flips after the first paint.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setIsSuperAdmin(!!getUser()?.isSuperAdmin);
    setReady(true);
  }, []);

  // Stable refs so the firing effect doesn't re-trigger when `toast`
  // (a new object every render) or the load callbacks change identity.
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const loadActivity = useCallback(async () => {
    setRefreshing(true);
    try {
      const qs = new URLSearchParams();
      if (actor) qs.set("actor", actor);
      if (action) qs.set("action", action);
      if (orgId && isSuperAdmin) qs.set("orgId", orgId);
      if (from) qs.set("from", new Date(from).toISOString());
      if (to) qs.set("to", new Date(to).toISOString());
      qs.set("limit", "300");

      if (isSuperAdmin) {
        const res = await api<{ entries: any[] }>(
          "/v1/admin/audit?" + qs.toString()
        );
        const norm: Row[] = (res.entries || []).map((e) => ({
          at: e.at,
          actor: e.actor || e.actorEmail || "",
          action: e.action,
          category: categoryFor(e.action),
          ip: e.ip,
          orgId: e.orgId,
          orgName: e.orgName,
          meta: e.meta,
        }));
        setRows(norm);
      } else {
        const res = await api<{ events: any[] }>("/v1/audit?" + qs.toString());
        const norm: Row[] = (res.events || []).map((e) => ({
          at: e.createdAt,
          actor: e.actorEmail || e.actorId || "",
          action: e.action,
          category: categoryFor(e.action),
          ip: e.ip,
          resourceType: e.resourceType,
          resourceId: e.resourceId,
          meta: e.meta,
        }));
        setRows(norm);
      }
      setForbidden(false);
    } catch (e: any) {
      if (e?.status === 403) {
        setForbidden(true);
        setRows([]);
      } else {
        toastRef.current.show("error", "Couldn't load audit", {
          description: e?.message,
        });
        setRows([]);
      }
    } finally {
      setRefreshing(false);
    }
  }, [actor, action, orgId, from, to, isSuperAdmin]);

  const loadEmail = useCallback(async () => {
    setRefreshing(true);
    try {
      const qs = new URLSearchParams();
      if (orgId && isSuperAdmin) qs.set("orgId", orgId);
      if (emailKind) qs.set("kind", emailKind);
      if (emailStatus) qs.set("status", emailStatus);
      if (emailSource) qs.set("source", emailSource);
      qs.set("limit", "300");

      const path = isSuperAdmin
        ? "/v1/admin/email/sends?"
        : "/v1/email/sends?";
      const res = await api<{ sends: any[] }>(path + qs.toString());
      const norm: EmailRow[] = (res.sends || []).map((s) => ({
        id: s.id,
        at: s.createdAt,
        orgId: s.orgId,
        subject: s.subject,
        recipients: s.recipients || [],
        provider: s.provider,
        status: s.status,
        kind: s.kind,
        source: s.source,
        fromEmail: s.fromEmail,
        error: s.error,
        meta: s.metadata,
      }));
      setEmails(norm);
      setForbidden(false);
    } catch (e: any) {
      if (e?.status === 403) {
        setForbidden(true);
        setEmails([]);
      } else {
        toastRef.current.show("error", "Couldn't load email audit", {
          description: e?.message,
        });
        setEmails([]);
      }
    } finally {
      setRefreshing(false);
    }
  }, [orgId, emailKind, emailStatus, emailSource, isSuperAdmin]);

  // Mirror the latest loaders onto a ref so the firing effect can stay
  // dependency-light — it only fires when the actual filter values, the
  // active tab, or readiness change.
  const loadActivityRef = useRef(loadActivity);
  const loadEmailRef = useRef(loadEmail);
  loadActivityRef.current = loadActivity;
  loadEmailRef.current = loadEmail;

  // Debounced reload on filter change. 300ms hides the per-keystroke
  // refetch when typing in the actor or org-id fields.
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => {
      if (tab === "activity") loadActivityRef.current();
      else loadEmailRef.current();
    }, 300);
    return () => clearTimeout(t);
  }, [
    ready,
    tab,
    isSuperAdmin,
    actor,
    action,
    orgId,
    from,
    to,
    emailKind,
    emailStatus,
    emailSource,
  ]);

  const filteredActivity = useMemo(() => {
    if (!rows) return null;
    if (!category) return rows;
    return rows.filter((r) => r.category === category);
  }, [rows, category]);

  const clearFilters = () => {
    if (tab === "activity") {
      setActor("");
      setAction("");
      setCategory("");
      setOrgId("");
      setFrom("");
      setTo("");
    } else {
      setOrgId("");
      setEmailKind("");
      setEmailStatus("");
      setEmailSource("");
    }
  };

  function exportCSV() {
    const escape = (s: any) =>
      `"${String(s ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
    let header: string[] = [];
    let body: string[] = [];
    if (tab === "activity") {
      if (!filteredActivity || filteredActivity.length === 0) return;
      header = ["at", "org", "actor", "category", "action", "ip", "meta"];
      body = filteredActivity.map((r) =>
        [
          r.at,
          r.orgName || r.orgId || "",
          r.actor,
          CATEGORY_LABEL[r.category] || r.category,
          r.action,
          r.ip || "",
          r.meta ? JSON.stringify(r.meta) : "",
        ]
          .map(escape)
          .join(",")
      );
    } else {
      if (!emails || emails.length === 0) return;
      header = [
        "at",
        "org",
        "subject",
        "recipients",
        "provider",
        "status",
        "kind",
        "source",
        "from",
        "error",
      ];
      body = emails.map((e) =>
        [
          e.at,
          e.orgId || "",
          e.subject,
          e.recipients.join(";"),
          e.provider,
          e.status,
          e.kind || "",
          e.source || "",
          e.fromEmail || "",
          e.error || "",
        ]
          .map(escape)
          .join(",")
      );
    }
    const csv = [header.join(","), ...body].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (forbidden) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Admin only
          </CardTitle>
          <CardDescription>
            The audit module is restricted to admins. Ask your workspace
            owner if you need access.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const activityCount = filteredActivity?.length ?? 0;
  const emailCount = emails?.length ?? 0;
  const totalCount = tab === "activity" ? activityCount : emailCount;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <ShieldCheck className="h-6 w-6" />
            Audit
          </h1>
          <p className="text-sm text-muted-foreground">
            {isSuperAdmin
              ? "Cross-org audit trail. Every authenticated action across every workspace."
              : "Every audited action in your workspace. Filters compose; export gives you the rows you're looking at."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isSuperAdmin && (
            <Badge variant="outline" className="gap-1">
              <Building2 className="h-3 w-3" />
              All orgs
            </Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => (tab === "activity" ? loadActivity() : loadEmail())}
            disabled={refreshing}
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            Refresh
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={exportCSV}
            disabled={totalCount === 0}
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex items-center gap-1 rounded-md border bg-card p-1 w-fit">
        <TabButton
          active={tab === "activity"}
          onClick={() => setTab("activity")}
          icon={<Activity className="h-3.5 w-3.5" />}
          label="Activity"
          count={rows?.length}
        />
        <TabButton
          active={tab === "email"}
          onClick={() => setTab("email")}
          icon={<Mail className="h-3.5 w-3.5" />}
          label="Email"
          count={emails?.length}
        />
      </div>

      {/* Filter toolbar — distinct sets per tab */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card p-2">
        {tab === "activity" ? (
          <>
            <div className="relative min-w-[180px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={actor}
                onChange={(e) => setActor(e.target.value)}
                placeholder="Actor email…"
                className="h-8 pl-8"
              />
            </div>
            <Input
              value={action}
              onChange={(e) => setAction(e.target.value)}
              placeholder="Action prefix (auth., file.…)"
              className="h-8 w-[200px]"
            />
            <Select
              value={category || "__all"}
              onValueChange={(v) => setCategory(v === "__all" ? "" : v)}
            >
              <SelectTrigger className="h-8 w-[150px]">
                <Filter className="h-3 w-3" />
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All categories</SelectItem>
                {Object.keys(CATEGORY_LABEL).map((k) => (
                  <SelectItem key={k} value={k}>
                    {CATEGORY_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isSuperAdmin && (
              <Input
                value={orgId}
                onChange={(e) => setOrgId(e.target.value)}
                placeholder="Org UUID"
                className="h-8 w-[160px] font-mono text-xs"
              />
            )}
            <Input
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-8 w-[180px]"
              aria-label="From"
            />
            <Input
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-8 w-[180px]"
              aria-label="To"
            />
          </>
        ) : (
          <>
            {isSuperAdmin && (
              <Input
                value={orgId}
                onChange={(e) => setOrgId(e.target.value)}
                placeholder="Org UUID"
                className="h-8 w-[180px] font-mono text-xs"
              />
            )}
            <Select
              value={emailKind || "__all"}
              onValueChange={(v) => setEmailKind(v === "__all" ? "" : v)}
            >
              <SelectTrigger className="h-8 w-[160px]">
                <SelectValue placeholder="Kind" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All kinds</SelectItem>
                <SelectItem value="auth">Auth</SelectItem>
                <SelectItem value="invite">Invite</SelectItem>
                <SelectItem value="share">Share</SelectItem>
                <SelectItem value="generation">Generation</SelectItem>
                <SelectItem value="billing">Billing</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={emailStatus || "__all"}
              onValueChange={(v) => setEmailStatus(v === "__all" ? "" : v)}
            >
              <SelectTrigger className="h-8 w-[160px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All statuses</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="bounced">Bounced</SelectItem>
                <SelectItem value="complained">Complained</SelectItem>
              </SelectContent>
            </Select>
            <Input
              value={emailSource}
              onChange={(e) => setEmailSource(e.target.value)}
              placeholder="Source (handler)"
              className="h-8 w-[180px]"
            />
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {totalCount} row{totalCount === 1 ? "" : "s"}
          </span>
          {(actor ||
            action ||
            category ||
            orgId ||
            from ||
            to ||
            emailKind ||
            emailStatus ||
            emailSource) && (
            <Button size="sm" variant="ghost" className="h-8" onClick={clearFilters}>
              <X className="h-3.5 w-3.5" />
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Table card */}
      <Card>
        <CardContent className="p-0">
          {refreshing && totalCount === 0 ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : tab === "activity" ? (
            <ActivityTable
              rows={filteredActivity}
              isSuperAdmin={isSuperAdmin}
              onSelect={setDetail}
            />
          ) : (
            <EmailTable
              rows={emails}
              isSuperAdmin={isSuperAdmin}
              onSelect={setDetail}
            />
          )}
        </CardContent>
      </Card>

      {/* Detail drawer — JSON dump for now; meta is the most useful field */}
      {detail && <DetailDrawer item={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      {icon}
      {label}
      {typeof count === "number" && count > 0 && (
        <span
          className={cn(
            "ml-0.5 rounded px-1 text-[10px]",
            active ? "bg-primary-foreground/20" : "bg-muted"
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// deviceSummary pulls the three fields auth audit rows now ship in meta —
// browser, os, and deviceType — into a single short string for the row.
// Returns "" when none are present so non-auth rows don't show "··".
function deviceSummary(meta?: Record<string, any> | null): string {
  if (!meta) return "";
  const browser = meta.browser as string | undefined;
  const os = meta.os as string | undefined;
  const dev = meta.deviceType as string | undefined;
  const parts: string[] = [];
  if (browser) parts.push(browser);
  if (os) parts.push(os);
  if (dev && dev !== "desktop") parts.push(dev);
  return parts.join(" · ");
}

function locationSummary(meta?: Record<string, any> | null): string {
  const g = meta?.geo as Record<string, any> | undefined;
  if (!g) return "";
  if (g.city && g.country) return `${g.city}, ${g.country}`;
  if (g.country) return g.country as string;
  if (g.lat && g.lng) {
    return `${(g.lat as number).toFixed(2)}, ${(g.lng as number).toFixed(2)}`;
  }
  return "";
}

function ActivityTable({
  rows,
  isSuperAdmin,
  onSelect,
}: {
  rows: Row[] | null;
  isSuperAdmin: boolean;
  onSelect: (r: Row) => void;
}) {
  if (!rows) return null;
  if (rows.length === 0) {
    return (
      <div className="grid place-items-center gap-2 p-10 text-center text-sm text-muted-foreground">
        <Inbox className="h-8 w-8" />
        No audit rows match these filters.
      </div>
    );
  }
  return (
    <ul className="divide-y text-sm">
      {rows.map((r, i) => {
        const dev = deviceSummary(r.meta);
        const loc = locationSummary(r.meta);
        return (
          <li
            key={i}
            className="group flex flex-wrap items-start gap-3 px-4 py-2.5 hover:bg-accent/40"
          >
            <div className="w-[140px] shrink-0 text-xs text-muted-foreground tabular-nums">
              {new Date(r.at).toLocaleString()}
            </div>
            <Badge
              variant="outline"
              className={cn(
                "shrink-0 text-[10px]",
                CATEGORY_TONE[r.category] || ""
              )}
            >
              {CATEGORY_LABEL[r.category] || r.category}
            </Badge>
            <div className="min-w-0 flex-1">
              <code className="break-all font-mono text-[12px]">{r.action}</code>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground/80">
                  {r.actor || "—"}
                </span>
                {r.ip && <span className="ml-2">{r.ip}</span>}
                {dev && <span className="ml-2">· {dev}</span>}
                {loc && <span className="ml-2">· {loc}</span>}
                {isSuperAdmin && (r.orgName || r.orgId) && (
                  <span className="ml-2">· {r.orgName || r.orgId}</span>
                )}
                {r.resourceType && (
                  <span className="ml-2 font-mono">
                    {r.resourceType}:{r.resourceId}
                  </span>
                )}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 opacity-0 group-hover:opacity-100"
              onClick={() => onSelect(r)}
            >
              <Eye className="h-3.5 w-3.5" />
              Details
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function EmailTable({
  rows,
  isSuperAdmin,
  onSelect,
}: {
  rows: EmailRow[] | null;
  isSuperAdmin: boolean;
  onSelect: (r: EmailRow) => void;
}) {
  if (!rows) return null;
  if (rows.length === 0) {
    return (
      <div className="grid place-items-center gap-2 p-10 text-center text-sm text-muted-foreground">
        <Inbox className="h-8 w-8" />
        No email sends match these filters.
      </div>
    );
  }
  const tone = (status: string) => {
    switch (status) {
      case "sent":
        return "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300";
      case "failed":
      case "bounced":
      case "complained":
        return "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300";
      default:
        return "bg-muted text-muted-foreground";
    }
  };
  return (
    <ul className="divide-y text-sm">
      {rows.map((r) => (
        <li
          key={r.id}
          className="group flex flex-wrap items-start gap-3 px-4 py-2.5 hover:bg-accent/40"
        >
          <div className="w-[140px] shrink-0 text-xs text-muted-foreground tabular-nums">
            {new Date(r.at).toLocaleString()}
          </div>
          <Badge variant="outline" className={cn("shrink-0 text-[10px]", tone(r.status))}>
            {r.status}
          </Badge>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{r.subject || "(no subject)"}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              <span>{r.recipients.slice(0, 2).join(", ")}</span>
              {r.recipients.length > 2 && (
                <span> +{r.recipients.length - 2}</span>
              )}
              <span className="ml-2">· {r.provider}</span>
              {r.kind && <span className="ml-2">· {r.kind}</span>}
              {r.source && <span className="ml-2 font-mono">· {r.source}</span>}
              {isSuperAdmin && r.orgId && (
                <span className="ml-2 font-mono">· {r.orgId.slice(0, 8)}</span>
              )}
            </div>
            {r.error && (
              <div className="mt-0.5 truncate text-[11px] text-red-600 dark:text-red-400">
                {r.error}
              </div>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 opacity-0 group-hover:opacity-100"
            onClick={() => onSelect(r)}
          >
            <Eye className="h-3.5 w-3.5" />
            Details
          </Button>
        </li>
      ))}
    </ul>
  );
}

function DetailDrawer({
  item,
  onClose,
}: {
  item: Row | EmailRow;
  onClose: () => void;
}) {
  // Click outside or Esc closes; aria-modal so screen readers announce it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex"
      onClick={(e) => {
        if (e.currentTarget === e.target) onClose();
      }}
    >
      <div className="flex-1 bg-background/60 backdrop-blur-sm" />
      <div className="h-full w-full max-w-lg overflow-y-auto border-l bg-card shadow-2xl">
        <div className="sticky top-0 flex items-center justify-between border-b bg-card px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Eye className="h-4 w-4" />
            Audit detail
          </div>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="space-y-4 p-4 text-sm">
          {Object.entries(item).map(([k, v]) => {
            if (v == null || v === "") return null;
            return (
              <div key={k} className="grid grid-cols-3 gap-3">
                <div className="text-xs text-muted-foreground">{k}</div>
                <div className="col-span-2 break-all font-mono text-[12px]">
                  {typeof v === "object" ? (
                    <pre className="overflow-x-auto rounded bg-muted p-2 text-[11px]">
                      {JSON.stringify(v, null, 2)}
                    </pre>
                  ) : (
                    String(v)
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
