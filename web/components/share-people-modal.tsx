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
import {
  Check,
  ChevronDown,
  Plus,
  Search,
  Trash2,
  Users,
  UserPlus,
  X,
} from "lucide-react";
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

  // Inline "Create a new group" form state.
  // The form is collapsed by default to keep the picker compact. When a
  // user opens it, we let them pick a name and check members from the
  // same team-member list used above, then — on submit — create the
  // group, add members in parallel, auto-grant access to the current
  // resource at the currently selected role, and collapse again.
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupMembers, setNewGroupMembers] = useState<Set<string>>(
    new Set()
  );
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resourceId, resourceType]);

  // Collapse and reset the inline creator whenever the modal closes or
  // the target resource changes — otherwise half-typed names linger.
  useEffect(() => {
    setCreatorOpen(false);
    setNewGroupName("");
    setNewGroupMembers(new Set());
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

  // Create a new group inline, add the selected members, and grant the
  // current resource to it — all in one go. Failures at any stage roll
  // back as gracefully as the backend allows: group creation is the only
  // atomic step. If member-adds fail for some users we still keep the
  // group and surface a partial-success toast so the user can retry.
  async function createGroup() {
    const name = newGroupName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      // 1. Create the group.
      const { id: groupId } = await api<{ id: string; name: string }>(
        "/v1/groups",
        {
          method: "POST",
          body: JSON.stringify({ name }),
        }
      );

      // 2. Add members in parallel. Collect failures but keep going.
      const memberIds = [...newGroupMembers];
      const memberResults = await Promise.allSettled(
        memberIds.map((userId) =>
          api(`/v1/groups/${groupId}/members`, {
            method: "POST",
            body: JSON.stringify({ userId }),
          })
        )
      );
      const failedMemberAdds = memberResults.filter(
        (r) => r.status === "rejected"
      ).length;

      // 3. Grant the new group access to this resource at the current role.
      await api(`/v1/${resourceType}s/${resourceId}/access`, {
        method: "POST",
        body: JSON.stringify({ groupId, role }),
      });

      // 4. Reset, refresh, and report.
      setCreatorOpen(false);
      setNewGroupName("");
      setNewGroupMembers(new Set());
      await loadAll();

      if (failedMemberAdds > 0) {
        toast.show(
          "info",
          `Group "${name}" created, but ${failedMemberAdds} member${
            failedMemberAdds === 1 ? "" : "s"
          } couldn't be added`
        );
      } else {
        toast.show(
          "success",
          memberIds.length > 0
            ? `Group "${name}" created with ${memberIds.length} member${
                memberIds.length === 1 ? "" : "s"
              } and shared`
            : `Group "${name}" created and shared`
        );
      }
    } catch (e: any) {
      // Surface the backend's error code directly — "name_conflict" is
      // the common one and the message is already user-friendly.
      toast.show("error", "Couldn't create group", {
        description: e.message,
      });
    } finally {
      setCreating(false);
    }
  }

  function toggleNewGroupMember(userId: string) {
    setNewGroupMembers((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
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
                {/* Inline group creator — collapsed by default, expands to
                    let the user name a new group and tick members in one go. */}
                <div className="border-b bg-muted/20">
                  {!creatorOpen ? (
                    <button
                      type="button"
                      onClick={() => {
                        // Preseed the new-group name with the current
                        // search query — a common "I just typed the
                        // group name I wanted" flow.
                        if (query.trim() && !newGroupName) {
                          setNewGroupName(query.trim());
                        }
                        setCreatorOpen(true);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/60"
                    >
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                        <Plus className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">
                          Create a new group
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          Name it and pick teammates — you&apos;ll share{" "}
                          {resourceType === "folder" ? "this folder" : "this file"}{" "}
                          with the group right after
                        </div>
                      </div>
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </button>
                  ) : (
                    <div className="space-y-2 p-3">
                      <div className="flex items-center gap-2">
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                          <Users className="h-4 w-4" />
                        </div>
                        <Input
                          autoFocus
                          value={newGroupName}
                          onChange={(e) => setNewGroupName(e.target.value)}
                          placeholder="Group name (e.g. Finance team)"
                          maxLength={120}
                          className="h-8 flex-1 text-sm"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void createGroup();
                            }
                            if (e.key === "Escape") {
                              e.preventDefault();
                              setCreatorOpen(false);
                            }
                          }}
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          title="Cancel"
                          onClick={() => {
                            setCreatorOpen(false);
                            setNewGroupName("");
                            setNewGroupMembers(new Set());
                          }}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>

                      {/* Member checklist — reuse the existing team
                          list, filtered by the same query. Only shown
                          when the org has teammates to pick. */}
                      {members.filter((m) => !m.isSelf).length > 0 && (
                        <div>
                          <div className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            <span>
                              Members
                              {newGroupMembers.size > 0 && (
                                <span className="ml-1 rounded bg-primary/10 px-1 py-[1px] text-[10px] font-medium normal-case text-primary">
                                  {newGroupMembers.size} selected
                                </span>
                              )}
                            </span>
                            {newGroupMembers.size > 0 && (
                              <button
                                type="button"
                                onClick={() => setNewGroupMembers(new Set())}
                                className="text-[10px] font-normal uppercase tracking-wide text-muted-foreground hover:text-foreground"
                              >
                                Clear
                              </button>
                            )}
                          </div>
                          <div className="max-h-[120px] overflow-y-auto rounded border bg-background">
                            {filteredMembers.length === 0 ? (
                              <div className="p-2 text-center text-[11px] text-muted-foreground">
                                No matching teammates
                              </div>
                            ) : (
                              filteredMembers.map((m) => {
                                const checked = newGroupMembers.has(m.id);
                                return (
                                  <label
                                    key={m.id}
                                    className="flex cursor-pointer items-center gap-2 px-2 py-1 hover:bg-muted/60"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() =>
                                        toggleNewGroupMember(m.id)
                                      }
                                      className="h-3.5 w-3.5 shrink-0 rounded border-muted-foreground/40"
                                    />
                                    <Avatar name={m.name || m.email} />
                                    <span className="min-w-0 flex-1 truncate text-xs">
                                      {m.name || m.email}
                                    </span>
                                    {m.name && (
                                      <span className="shrink-0 truncate text-[10px] text-muted-foreground">
                                        {m.email}
                                      </span>
                                    )}
                                  </label>
                                );
                              })
                            )}
                          </div>
                        </div>
                      )}

                      <div className="flex items-center justify-end gap-2 pt-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7"
                          onClick={() => {
                            setCreatorOpen(false);
                            setNewGroupName("");
                            setNewGroupMembers(new Set());
                          }}
                          disabled={creating}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          className="h-7"
                          disabled={!newGroupName.trim() || creating}
                          onClick={() => void createGroup()}
                        >
                          {creating
                            ? "Creating…"
                            : newGroupMembers.size > 0
                              ? `Create & share`
                              : `Create group`}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                {filteredGroups.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <span>Groups</span>
                      <a
                        href="/settings/team?tab=groups"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-normal normal-case tracking-normal text-primary hover:underline"
                        title="Rename, delete, or change membership"
                      >
                        Manage groups →
                      </a>
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
