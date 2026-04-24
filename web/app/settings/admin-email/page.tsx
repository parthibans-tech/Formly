"use client";

// Super-admin cross-org email audit. Mirrors the per-org "Recent sends"
// list on /settings/email but spans every org in the platform and
// exposes filters for diagnosing platform-wide delivery problems.
//
// Why a separate page
// -------------------
// The org-scoped list lives next to the configuration form because its
// audience is "the admin who configured this provider". This list is
// for an operator wearing a different hat — they don't care about the
// SES form, they care about "show me every failed send in the last
// hour, regardless of org." Conflating the two crowds the workflow.

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Inbox,
  RefreshCcw,
  Search,
  XCircle,
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
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

type Send = {
  id: string;
  orgId: string;
  userId?: string | null;
  templateId?: string | null;
  outputFileId?: string | null;
  recipients: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  provider: string;
  status: string;
  providerId?: string | null;
  error?: string | null;
  kind?: string;
  source?: string;
  fromEmail?: string;
  fromName?: string;
  metadata?: Record<string, any> | null;
  createdAt: string;
};

export default function AdminEmailSendsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<Send[] | null>(null);
  const [orgFilter, setOrgFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  // Forbidden flips on a 403 — happens when a non-admin lands here. We
  // render a friendly explanation instead of an empty page so the user
  // knows the page exists but isn't theirs to use.
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const qs = new URLSearchParams();
      if (orgFilter) qs.set("orgId", orgFilter);
      if (kindFilter) qs.set("kind", kindFilter);
      if (statusFilter) qs.set("status", statusFilter);
      if (sourceFilter) qs.set("source", sourceFilter);
      qs.set("limit", "500");
      const res = await api<{ sends: Send[] }>(
        "/v1/admin/email/sends?" + qs.toString()
      );
      setRows(res.sends || []);
      setForbidden(false);
    } catch (e: any) {
      if (e?.status === 403) {
        setForbidden(true);
        setRows([]);
      } else {
        toast.show("error", "Couldn't load sends", {
          description: e?.message || "Please try again.",
        });
        setRows([]);
      }
    } finally {
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgFilter, kindFilter, statusFilter, sourceFilter]);

  useEffect(() => {
    setRows(null);
    load();
  }, [load]);

  if (forbidden) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Admin only
          </CardTitle>
          <CardDescription>
            The cross-org email audit is restricted to organization admins.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Email audit (all orgs)
        </h1>
        <p className="text-sm text-muted-foreground">
          Platform-wide audit log of every transactional email sent through
          Drive360. Filter by org, kind, source module, or delivery status.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Org ID
              </label>
              <Input
                value={orgFilter}
                onChange={(e) => setOrgFilter(e.target.value)}
                placeholder="UUID — leave blank for all"
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Kind
              </label>
              <Select
                value={kindFilter || "all"}
                onValueChange={(v) => setKindFilter(v === "all" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All kinds</SelectItem>
                  <SelectItem value="template">Template</SelectItem>
                  <SelectItem value="test">Test</SelectItem>
                  <SelectItem value="invitation">Invitation</SelectItem>
                  <SelectItem value="access_request_filed">
                    Access request filed
                  </SelectItem>
                  <SelectItem value="access_request_approved">
                    Access approved
                  </SelectItem>
                  <SelectItem value="access_request_denied">
                    Access denied
                  </SelectItem>
                  <SelectItem value="notification">Notification</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Status
              </label>
              <Select
                value={statusFilter || "all"}
                onValueChange={(v) => setStatusFilter(v === "all" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any status</SelectItem>
                  <SelectItem value="sent">Sent</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Source module
              </label>
              <Input
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
                placeholder="e.g. sharing.access_request_filed"
                className="font-mono text-xs"
              />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={load} disabled={refreshing}>
              <RefreshCcw className="h-3.5 w-3.5" />
              Refresh
            </Button>
            <span className="text-xs text-muted-foreground">
              {rows?.length ?? 0} rows
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sends</CardTitle>
          <CardDescription>
            Most recent first. Click a row to expand its metadata payload.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows === null ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <div className="grid place-items-center gap-2 rounded-md border border-dashed bg-muted/30 p-10 text-center text-sm text-muted-foreground">
              <Inbox className="h-8 w-8" />
              No sends match these filters.
            </div>
          ) : (
            <ul className="divide-y">
              {rows.map((s) => (
                <SendRow key={s.id} s={s} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SendRow({ s }: { s: Send }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 text-left hover:bg-accent/50"
      >
        {s.status === "sent" ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" />
        ) : (
          <XCircle className="mt-0.5 h-4 w-4 text-destructive" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{s.subject || "(no subject)"}</span>
            {s.kind && (
              <Badge variant="secondary" className="text-[10px]">
                {s.kind}
              </Badge>
            )}
            <Badge variant="outline" className="font-mono text-[10px]">
              {s.provider}
            </Badge>
            {s.providerId && (
              <span className="font-mono text-[10px] text-muted-foreground">
                #{s.providerId.slice(0, 12)}
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            to {s.recipients.join(", ")} ·{" "}
            {new Date(s.createdAt).toLocaleString()}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>
              org{" "}
              <code className="font-mono">{s.orgId.slice(0, 8)}…</code>
            </span>
            {s.fromEmail && (
              <span>
                from <code className="font-mono">{s.fromEmail}</code>
              </span>
            )}
            {s.source && (
              <span>
                via <code className="font-mono">{s.source}</code>
              </span>
            )}
          </div>
        </div>
      </button>
      {open && (
        <div className="ml-6 mt-2 space-y-2">
          {s.error && (
            <pre className="max-h-32 overflow-auto rounded bg-destructive/10 p-2 font-mono text-[10px] text-destructive">
              {s.error}
            </pre>
          )}
          {s.metadata && Object.keys(s.metadata).length > 0 && (
            <pre className="max-h-32 overflow-auto rounded bg-muted/50 p-2 font-mono text-[10px]">
              {JSON.stringify(s.metadata, null, 2)}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}
