"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Download,
  Eye,
  Filter,
  Key,
  LogIn,
  LogOut,
  Mail,
  MessageSquare,
  Settings,
  Share2,
  ShieldCheck,
  Trash2,
  User,
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
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

type Event = {
  id: string;
  actorId?: string;
  actorEmail?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  ip?: string;
  userAgent?: string;
  meta?: Record<string, any>;
  createdAt: string;
};

export default function AuditPage() {
  const toast = useToast();
  const [events, setEvents] = useState<Event[] | null>(null);
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const qs = new URLSearchParams();
      if (action) qs.set("action", action);
      if (actor) qs.set("actor", actor);
      qs.set("limit", "200");
      const r = await api<{ events: Event[] }>(
        `/v1/audit?${qs.toString()}`
      );
      setEvents(r.events);
    } catch (e: any) {
      setErr(e.message);
      toast.show("error", e.message);
    }
  }, [action, actor, toast]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const actionOptions = useMemo(() => {
    const s = new Set<string>();
    (events ?? []).forEach((e) => s.add(e.action));
    return Array.from(s).sort();
  }, [events]);

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="text-sm text-muted-foreground">
          Immutable record of every sensitive action in your workspace —
          sign-ins, file access, share-link creation, role changes, and more.
        </p>
      </div>

      {err && err.includes("admin") && (
        <Card className="border-warning/50 bg-warning/5">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 text-warning" />
            <div>
              <div className="font-medium">Admin only</div>
              <div className="text-muted-foreground">
                The audit log is restricted to workspace administrators.
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-primary" />
            Filter
          </CardTitle>
          <CardDescription>
            Narrow the log by action type or actor (user ID or email).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Action
            </label>
            <Input
              list="audit-actions"
              value={action}
              onChange={(e) => setAction(e.target.value)}
              placeholder="e.g. share.create"
            />
            <datalist id="audit-actions">
              {actionOptions.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Actor
            </label>
            <Input
              value={actor}
              onChange={(e) => setActor(e.target.value)}
              placeholder="email or user id"
            />
          </div>
          <div className="flex items-end gap-2">
            <Button onClick={load}>Apply</Button>
            {(action || actor) && (
              <Button
                variant="ghost"
                onClick={() => {
                  setAction("");
                  setActor("");
                  setTimeout(load, 0);
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {events === null && !err ? (
            <div className="space-y-1 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : events && events.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No events"
              description="Nothing matches the current filter. Try clearing filters or widening the time range."
            />
          ) : (
            <ul className="divide-y">
              {(events ?? []).map((e) => (
                <EventRow key={e.id} e={e} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function EventRow({ e }: { e: Event }) {
  const { Icon, color, title } = describe(e.action);
  const [open, setOpen] = useState(false);
  const hasMeta = e.meta && Object.keys(e.meta).length > 0;

  return (
    <li>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/40"
      >
        <span
          className={cn(
            "grid h-8 w-8 shrink-0 place-items-center rounded-md",
            color
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{title}</span>
            <Badge variant="secondary" className="font-mono text-[10px]">
              {e.action}
            </Badge>
            {e.resourceType && (
              <Badge variant="outline" className="text-[10px]">
                {e.resourceType}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {e.actorEmail || e.actorId || "system"}
            {e.ip && ` · ${e.ip}`}
            {" · "}
            {new Date(e.createdAt).toLocaleString()}
          </div>
        </div>
        {hasMeta && (
          <span className="text-[10px] text-muted-foreground">
            {open ? "Hide details" : "Show details"}
          </span>
        )}
      </button>
      {open && hasMeta && (
        <div className="border-t bg-muted/20 px-4 py-2 font-mono text-[11px]">
          <pre className="overflow-x-auto whitespace-pre-wrap">
            {JSON.stringify(e.meta, null, 2)}
          </pre>
        </div>
      )}
    </li>
  );
}

function describe(action: string): {
  Icon: React.ComponentType<{ className?: string }>;
  color: string;
  title: string;
} {
  const family = action.split(".")[0];
  const verb = action.split(".").slice(1).join(".");
  switch (family) {
    case "auth":
      if (verb.startsWith("login.failed") || verb.includes("failed"))
        return {
          Icon: AlertTriangle,
          color: "bg-destructive/10 text-destructive",
          title: "Authentication failure",
        };
      if (verb === "logout")
        return {
          Icon: LogOut,
          color: "bg-muted text-muted-foreground",
          title: "Signed out",
        };
      return {
        Icon: LogIn,
        color: "bg-primary/10 text-primary",
        title: "Signed in",
      };
    case "mfa":
      if (verb === "admin_reset")
        return {
          Icon: AlertTriangle,
          color: "bg-amber-500/10 text-amber-600",
          title: "Admin reset MFA for user",
        };
      return {
        Icon: ShieldCheck,
        color: "bg-primary/10 text-primary",
        title:
          verb === "enroll"
            ? "MFA enrolled"
            : verb === "verify"
            ? "MFA verified"
            : "MFA disabled",
      };
    case "session":
      return {
        Icon: LogOut,
        color: "bg-amber-500/10 text-amber-600",
        title:
          verb === "revoke_all_others"
            ? "Revoked other sessions"
            : "Session revoked",
      };
    case "share":
      return {
        Icon: Share2,
        color: "bg-sky-500/10 text-sky-600",
        title:
          verb === "create"
            ? "Share link created"
            : verb === "revoke"
            ? "Share link revoked"
            : "Share link action",
      };
    case "file":
      if (verb.startsWith("legalhold"))
        return {
          Icon: ShieldCheck,
          color: "bg-violet-500/10 text-violet-600",
          title:
            verb === "legalhold.apply"
              ? "Legal hold applied"
              : "Legal hold released",
        };
      if (verb === "classify")
        return {
          Icon: ShieldCheck,
          color: "bg-violet-500/10 text-violet-600",
          title: "File re-classified",
        };
      if (verb === "delete")
        return {
          Icon: Trash2,
          color: "bg-destructive/10 text-destructive",
          title: "File moved to trash",
        };
      if (verb === "download")
        return {
          Icon: Download,
          color: "bg-emerald-500/10 text-emerald-600",
          title: "File downloaded",
        };
      if (verb === "view")
        return {
          Icon: Eye,
          color: "bg-muted text-muted-foreground",
          title: "File viewed",
        };
      return {
        Icon: Activity,
        color: "bg-muted text-muted-foreground",
        title: action,
      };
    case "template":
      return {
        Icon: Activity,
        color: "bg-muted text-muted-foreground",
        title: "Template event",
      };
    case "team":
      return {
        Icon: User,
        color: "bg-primary/10 text-primary",
        title: "Team change",
      };
    case "apikey":
      return {
        Icon: Key,
        color: "bg-amber-500/10 text-amber-600",
        title: "API key event",
      };
    case "webhook":
      return {
        Icon: Activity,
        color: "bg-muted text-muted-foreground",
        title: "Webhook event",
      };
    case "comment":
    case "review":
      return {
        Icon: MessageSquare,
        color: "bg-sky-500/10 text-sky-600",
        title: action,
      };
    case "email":
      return {
        Icon: Mail,
        color: "bg-rose-500/10 text-rose-600",
        title: "Email event",
      };
    case "security":
      return {
        Icon: Settings,
        color: "bg-primary/10 text-primary",
        title: "Security settings updated",
      };
    default:
      return {
        Icon: CheckCircle2,
        color: "bg-muted text-muted-foreground",
        title: action,
      };
  }
}
