"use client";

// Owner-facing access-request inbox.
//
// Teammates who hit a template they can't edit send a "request access"
// through the viewer; the API files a pending row in access_requests.
// This page surfaces those rows for every file the caller owns and lets
// them approve (auto-mints a resource_shares row) or deny in one click.
// Admins can flip to org-scope to unblock things on files they don't own.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Check,
  Clock,
  ExternalLink,
  Inbox,
  Loader2,
  Share2,
  X,
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
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";

type AccessRequest = {
  id: string;
  fileId: string;
  fileName: string;
  requesterId: string;
  requesterEmail: string;
  requesterName?: string;
  role: "viewer" | "editor";
  message: string;
  status: "pending" | "approved" | "denied" | "cancelled";
  createdAt: string;
};

type Scope = "inbox" | "outbox";

export default function AccessRequestsPage() {
  const toast = useToast();
  const [scope, setScope] = useState<Scope>("inbox");
  const [rows, setRows] = useState<AccessRequest[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Keyed by request id — tracks which row is currently being approved/
  // denied/cancelled so we can disable just that row's buttons without
  // blocking the whole list.
  const [busyId, setBusyId] = useState<string | null>(null);
  // Outbox always shows history (a cancelled/denied row tells the user
  // the request is closed). Inbox defaults to pending-only.
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    try {
      setErr(null);
      const qs = new URLSearchParams({ scope });
      if (scope === "inbox" && showHistory) qs.set("status", "all");
      const res = await api<{ requests: AccessRequest[] }>(
        `/v1/access-requests?${qs.toString()}`
      );
      setRows(res.requests || []);
    } catch (e: any) {
      setErr(e?.message || "Couldn't load requests");
      setRows([]);
    }
  }, [scope, showHistory]);

  useEffect(() => {
    setRows(null);
    load();
  }, [load]);

  async function decide(
    id: string,
    action: "approve" | "deny" | "cancel"
  ) {
    setBusyId(id);
    try {
      await api(`/v1/access-requests/${id}/${action}`, { method: "POST" });
      toast.show(
        "success",
        action === "approve"
          ? "Access granted"
          : action === "deny"
            ? "Request denied"
            : "Request cancelled"
      );
      await load();
    } catch (e: any) {
      toast.show("error", "Action failed", {
        description: e?.message || "Please try again.",
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Access requests</h1>
          <p className="text-sm text-muted-foreground">
            Decide on teammates asking for edit or view access to your files.
          </p>
        </div>
        <div className="inline-flex rounded-md border p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setScope("inbox")}
            className={
              "rounded px-2.5 py-1 " +
              (scope === "inbox"
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            <Inbox className="mr-1 inline h-3.5 w-3.5" />
            Incoming
          </button>
          <button
            type="button"
            onClick={() => setScope("outbox")}
            className={
              "rounded px-2.5 py-1 " +
              (scope === "outbox"
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            <Share2 className="mr-1 inline h-3.5 w-3.5" />
            My requests
          </button>
        </div>
      </div>

      {scope === "inbox" && (
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={showHistory}
            onChange={(e) => setShowHistory(e.target.checked)}
            className="h-3.5 w-3.5 accent-primary"
          />
          Show decided history
        </label>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {scope === "inbox" ? "For your files" : "Your pending requests"}
          </CardTitle>
          <CardDescription>
            {scope === "inbox"
              ? "Approving creates a share automatically — the requester will see the file unlock."
              : "Requests you've filed on other people's files. Cancel any you no longer need."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {rows === null ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : err ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {err}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title={
                scope === "inbox" ? "No pending requests" : "No outgoing requests"
              }
              description={
                scope === "inbox"
                  ? "When a teammate asks for access to one of your files, they'll show up here."
                  : "When you request access to a teammate's file, it'll show up here until they decide."
              }
            />
          ) : (
            rows.map((r) => (
              <div
                key={r.id}
                className="flex items-start justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/templates/${r.fileId}/designer`}
                      className="truncate text-sm font-medium hover:underline"
                    >
                      {r.fileName}
                    </Link>
                    <Badge variant="outline" className="text-[10px] uppercase">
                      {r.role}
                    </Badge>
                    {r.status !== "pending" && (
                      <Badge
                        variant={
                          r.status === "approved"
                            ? "secondary"
                            : r.status === "denied"
                              ? "destructive"
                              : "outline"
                        }
                        className="text-[10px] uppercase"
                      >
                        {r.status}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {scope === "inbox" ? (
                      <>
                        <span className="font-medium text-foreground">
                          {r.requesterName || r.requesterEmail}
                        </span>
                        {r.requesterName && (
                          <> &middot; {r.requesterEmail}</>
                        )}
                      </>
                    ) : (
                      <>Asked {new Date(r.createdAt).toLocaleString()}</>
                    )}
                  </div>
                  {r.message && (
                    <p className="mt-1.5 whitespace-pre-wrap rounded border bg-background p-2 text-xs text-muted-foreground">
                      &ldquo;{r.message}&rdquo;
                    </p>
                  )}
                  <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {new Date(r.createdAt).toLocaleString()}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {scope === "inbox" && r.status === "pending" ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => decide(r.id, "deny")}
                        disabled={busyId === r.id}
                      >
                        <X className="h-3.5 w-3.5" />
                        Deny
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => decide(r.id, "approve")}
                        disabled={busyId === r.id}
                      >
                        {busyId === r.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        )}
                        Approve
                      </Button>
                    </>
                  ) : scope === "outbox" && r.status === "pending" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => decide(r.id, "cancel")}
                      disabled={busyId === r.id}
                    >
                      {busyId === r.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <X className="h-3.5 w-3.5" />
                      )}
                      Cancel
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" asChild>
                      <Link href={`/templates/${r.fileId}/designer`}>
                        <ExternalLink className="h-3.5 w-3.5" />
                        Open
                      </Link>
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
