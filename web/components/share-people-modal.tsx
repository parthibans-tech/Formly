"use client";

/**
 * Share-with-people modal.
 *
 * Distinct from `share-modal.tsx` (which issues public URL tokens for
 * unauthenticated recipients). This dialog is the per-user / per-group
 * ACL editor: you grant a teammate or a group "viewer" / "editor"
 * access to a file or folder, and they see it under *Shared with me*
 * in their Drive.
 *
 * Backend: /v1/{files|folders}/:id/access (POST/GET) and
 *           /v1/{files|folders}/:id/access/:shareId (DELETE).
 * Principals: /v1/team/members (users) + /v1/groups (groups).
 *
 * Props use `resourceId` + `resourceType` so the same component serves
 * both file rows and folder rows. Nothing renders unless `open` is
 * true, so it's cheap to leave mounted.
 */
import { useEffect, useMemo, useState } from "react";
import { Check, Search, Trash2, Users, UserPlus } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Role = "viewer" | "editor";

type Member = {
  id: string;
  email: string;
  name?: string;
  isSelf?: boolean;
};

type Group = {
  id: string;
  name: string;
  memberCount: number;
};

type Share = {
  id: string;
  resourceId: string;
  userId?: string;
  userEmail?: string;
  groupId?: string;
  groupName?: string;
  role: Role;
  createdAt: string;
};

export function SharePeopleModal({
  resourceId,
  resourceType,
  resourceName,
  open,
  onOpenChange,
}: {
  resourceId: string;
  resourceType: "file" | "folder";
  resourceName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const toast = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  // Role is picked once per invite; switch it and every principal you
  // add next takes that role. Keeps the UI small for the common case
  // of "share to three people as viewers".
  const [role, setRole] = useState<Role>("viewer");
  const [granting, setGranting] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resourceId, resourceType]);

  async function loadAll() {
    setLoading(true);
    try {
      const [m, g, s] = await Promise.all([
        api<{ members: Member[] }>("/v1/team/members"),
        api<{ groups: Group[] }>("/v1/groups"),
        api<{ shares: Share[] }>(
          `/v1/${resourceType}s/${resourceId}/access`
        ),
      ]);
      setMembers(m.members);
      setGroups(g.groups);
      setShares(s.shares);
    } catch (e: any) {
      toast.show("error", "Couldn't load sharing info", {
        description: e.message,
      });
    } finally {
      setLoading(false);
    }
  }

  // Principals already granted — keep the list visible but the "Invite"
  // button becomes a "Change role" inline control.
  const sharedUserIds = useMemo(
    () => new Set(shares.filter((s) => s.userId).map((s) => s.userId!)),
    [shares]
  );
  const sharedGroupIds = useMemo(
    () => new Set(shares.filter((s) => s.groupId).map((s) => s.groupId!)),
    [shares]
  );

  const q = query.trim().toLowerCase();
  const filteredMembers = members.filter(
    (m) =>
      !m.isSelf &&
      (!q ||
        m.email.toLowerCase().includes(q) ||
        (m.name || "").toLowerCase().includes(q))
  );
  const filteredGroups = groups.filter(
    (g) => !q || g.name.toLowerCase().includes(q)
  );

  async function grant(principal: { userId?: string; groupId?: string }) {
    const key = principal.userId || principal.groupId || "";
    setGranting(key);
    try {
      await api(`/v1/${resourceType}s/${resourceId}/access`, {
        method: "POST",
        body: JSON.stringify({ ...principal, role }),
      });
      toast.show("success", "Access granted");
      await loadAll();
    } catch (e: any) {
      toast.show("error", "Couldn't share", { description: e.message });
    } finally {
      setGranting(null);
    }
  }

  async function revoke(shareId: string) {
    try {
      await api(`/v1/${resourceType}s/${resourceId}/access/${shareId}`, {
        method: "DELETE",
      });
      setShares((s) => s.filter((x) => x.id !== shareId));
    } catch (e: any) {
      toast.show("error", "Couldn't revoke", { description: e.message });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[540px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            Share “{resourceName}”
          </DialogTitle>
          <DialogDescription>
            Pick teammates or groups. They’ll see this{" "}
            {resourceType === "folder" ? "folder and everything inside it" : "file"}{" "}
            under <strong>Shared with me</strong>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search people or groups…"
                className="pl-8"
              />
            </div>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger className="w-[110px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="viewer">Viewer</SelectItem>
                <SelectItem value="editor">Editor</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="max-h-[260px] overflow-y-auto rounded-md border">
            {loading ? (
              <div className="space-y-2 p-3">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : (
              <>
                {filteredGroups.length > 0 && (
                  <div>
                    <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Groups
                    </div>
                    {filteredGroups.map((g) => {
                      const already = sharedGroupIds.has(g.id);
                      return (
                        <Row
                          key={g.id}
                          icon={<Users className="h-4 w-4" />}
                          title={g.name}
                          subtitle={`${g.memberCount} member${g.memberCount === 1 ? "" : "s"}`}
                          already={already}
                          pending={granting === g.id}
                          onAdd={() => grant({ groupId: g.id })}
                        />
                      );
                    })}
                  </div>
                )}
                {filteredMembers.length > 0 && (
                  <div>
                    <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      People
                    </div>
                    {filteredMembers.map((m) => {
                      const already = sharedUserIds.has(m.id);
                      return (
                        <Row
                          key={m.id}
                          icon={<Avatar name={m.name || m.email} />}
                          title={m.name || m.email}
                          subtitle={m.name ? m.email : undefined}
                          already={already}
                          pending={granting === m.id}
                          onAdd={() => grant({ userId: m.id })}
                        />
                      );
                    })}
                  </div>
                )}
                {filteredMembers.length === 0 && filteredGroups.length === 0 && (
                  <div className="p-6 text-center text-xs text-muted-foreground">
                    No matches
                  </div>
                )}
              </>
            )}
          </div>

          {shares.length > 0 && (
            <>
              <Separator />
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Currently shared with
                </div>
                <div className="space-y-1">
                  {shares.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60"
                    >
                      {s.groupId ? (
                        <Users className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <Avatar name={s.userEmail || ""} />
                      )}
                      <span className="flex-1 truncate">
                        {s.groupName || s.userEmail}
                      </span>
                      <Badge variant="outline" className="text-[10px]">
                        {s.role}
                      </Badge>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => revoke(s.id)}
                        title="Revoke access"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  icon,
  title,
  subtitle,
  already,
  pending,
  onAdd,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  already: boolean;
  pending: boolean;
  onAdd: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-1.5 hover:bg-muted/60">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{title}</div>
        {subtitle && (
          <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
        )}
      </div>
      {already ? (
        <Badge variant="secondary" className="gap-1 text-[10px]">
          <Check className="h-3 w-3" /> Shared
        </Badge>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={onAdd}
          className="h-7"
        >
          {pending ? "…" : "Share"}
        </Button>
      )}
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  const initial = (name || "?").trim().charAt(0).toUpperCase();
  return (
    <div className={cn("flex h-4 w-4 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary")}>
      {initial}
    </div>
  );
}
