"use client";

// Groups tab content — reusable body of the Groups section of the team page.
//
// The hosting page is responsible for rendering its own header (title +
// action button). This component exposes an imperative `openCreate()` via
// the `createRef` prop so the host's "Create group" button can trigger
// the creation dialog.
//
// Backend endpoints (all live already, see api/internal/sharing/groups.go):
//   GET    /v1/groups
//   POST   /v1/groups                 body: {name}
//   PATCH  /v1/groups/:id             body: {name}
//   DELETE /v1/groups/:id             cascades → group_members, resource_shares
//   GET    /v1/groups/:id/members
//   POST   /v1/groups/:id/members     body: {userId}
//   DELETE /v1/groups/:id/members/:userId
//
// Permissions: any org member can list + create. Only the `createdBy`
// user or an admin can rename / delete / manage members.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import {
  Crown,
  Pencil,
  Plus,
  Search,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import { api, getUser } from "@/lib/api";
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
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Group = {
  id: string;
  name: string;
  createdBy: string;
  creatorName?: string;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
};

type Member = {
  userId: string;
  email: string;
  name?: string;
  addedAt: string;
};

type TeamMember = {
  id: string;
  email: string;
  name?: string;
  isSelf?: boolean;
};

/** Imperative handle exposed so the host page can trigger "create group". */
export type GroupsTabHandle = {
  openCreate: () => void;
};

export const GroupsTab = forwardRef<GroupsTabHandle>(function GroupsTab(
  _props,
  ref
) {
  const toast = useToast();
  const confirm = useConfirm();

  // --- session + catalogues ----------------------------------------------
  const [me, setMe] = useState<any>(null);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  // --- create dialog ------------------------------------------------------
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createMembers, setCreateMembers] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  // --- manage dialog ------------------------------------------------------
  const [manageGroup, setManageGroup] = useState<Group | null>(null);
  const [manageMembers, setManageMembers] = useState<Member[]>([]);
  const [manageMembersLoading, setManageMembersLoading] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [addMemberQuery, setAddMemberQuery] = useState("");
  const [addingUserId, setAddingUserId] = useState<string | null>(null);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);

  // ------------------------------------------------------------------------

  useEffect(() => {
    setMe(getUser());
    void load();
  }, []);

  useImperativeHandle(ref, () => ({ openCreate }), []);

  async function load() {
    setLoading(true);
    try {
      const [g, t] = await Promise.all([
        api<{ groups: Group[] }>("/v1/groups"),
        api<{ members: TeamMember[] }>("/v1/team/members"),
      ]);
      setGroups(g.groups);
      setTeamMembers(t.members);
    } catch (e: any) {
      toast.show("error", "Couldn't load groups", { description: e.message });
    } finally {
      setLoading(false);
    }
  }

  const isAdmin = me?.role === "admin";
  const myUserId: string | undefined = me?.id;

  /** Who can mutate this group? Mirrors the backend's `canManageGroup`. */
  function canManage(g: Group) {
    return isAdmin || g.createdBy === myUserId;
  }

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) =>
        g.name.toLowerCase().includes(q) ||
        (g.creatorName || "").toLowerCase().includes(q)
    );
  }, [groups, query]);

  // --- CREATE -------------------------------------------------------------

  function openCreate() {
    setCreateName("");
    setCreateMembers(new Set());
    setCreateOpen(true);
  }

  async function submitCreate() {
    const name = createName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const { id } = await api<{ id: string; name: string }>("/v1/groups", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      const ids = [...createMembers];
      const results = await Promise.allSettled(
        ids.map((userId) =>
          api(`/v1/groups/${id}/members`, {
            method: "POST",
            body: JSON.stringify({ userId }),
          })
        )
      );
      const failures = results.filter((r) => r.status === "rejected").length;
      setCreateOpen(false);
      await load();
      if (failures > 0) {
        toast.show(
          "info",
          `Group "${name}" created, but ${failures} member${
            failures === 1 ? "" : "s"
          } couldn't be added`
        );
      } else {
        toast.show(
          "success",
          ids.length > 0
            ? `Group "${name}" created with ${ids.length} member${
                ids.length === 1 ? "" : "s"
              }`
            : `Group "${name}" created`
        );
      }
    } catch (e: any) {
      toast.show("error", "Couldn't create group", { description: e.message });
    } finally {
      setCreating(false);
    }
  }

  function toggleCreateMember(userId: string) {
    setCreateMembers((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  // --- DELETE -------------------------------------------------------------

  async function deleteGroup(g: Group) {
    const ok = await confirm({
      title: `Delete group "${g.name}"?`,
      description: `All ${g.memberCount} member${
        g.memberCount === 1 ? "" : "s"
      } will lose access to every file and folder shared with this group. This cannot be undone.`,
      confirmLabel: "Delete group",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/groups/${g.id}`, { method: "DELETE" });
      toast.show("success", `Group "${g.name}" deleted`);
      await load();
    } catch (e: any) {
      toast.show("error", "Couldn't delete group", {
        description: e.message,
      });
    }
  }

  // --- MANAGE -------------------------------------------------------------

  async function openManage(g: Group) {
    setManageGroup(g);
    setRenameValue(g.name);
    setAddMemberQuery("");
    setManageMembers([]);
    setManageMembersLoading(true);
    try {
      const r = await api<{ members: Member[] }>(
        `/v1/groups/${g.id}/members`
      );
      setManageMembers(r.members);
    } catch (e: any) {
      toast.show("error", "Couldn't load members", {
        description: e.message,
      });
    } finally {
      setManageMembersLoading(false);
    }
  }

  function closeManage() {
    setManageGroup(null);
    setManageMembers([]);
    setRenameValue("");
    setAddMemberQuery("");
  }

  async function submitRename() {
    if (!manageGroup) return;
    const next = renameValue.trim();
    if (!next || next === manageGroup.name || renaming) return;
    setRenaming(true);
    try {
      await api(`/v1/groups/${manageGroup.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: next }),
      });
      toast.show("success", `Renamed to "${next}"`);
      setManageGroup({ ...manageGroup, name: next });
      await load();
    } catch (e: any) {
      toast.show("error", "Couldn't rename", { description: e.message });
    } finally {
      setRenaming(false);
    }
  }

  async function addMember(userId: string) {
    if (!manageGroup || addingUserId) return;
    setAddingUserId(userId);
    try {
      await api(`/v1/groups/${manageGroup.id}/members`, {
        method: "POST",
        body: JSON.stringify({ userId }),
      });
      const r = await api<{ members: Member[] }>(
        `/v1/groups/${manageGroup.id}/members`
      );
      setManageMembers(r.members);
      await load();
    } catch (e: any) {
      toast.show("error", "Couldn't add member", { description: e.message });
    } finally {
      setAddingUserId(null);
    }
  }

  async function removeMember(m: Member) {
    if (!manageGroup || removingUserId) return;
    const ok = await confirm({
      title: `Remove ${m.name || m.email}?`,
      description: `They'll lose access to everything shared with "${manageGroup.name}" via this group. Direct shares aren't affected.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    setRemovingUserId(m.userId);
    try {
      await api(
        `/v1/groups/${manageGroup.id}/members/${m.userId}`,
        { method: "DELETE" }
      );
      setManageMembers((prev) => prev.filter((x) => x.userId !== m.userId));
      await load();
    } catch (e: any) {
      toast.show("error", "Couldn't remove member", {
        description: e.message,
      });
    } finally {
      setRemovingUserId(null);
    }
  }

  // Team members not yet in the group — the "add" picker.
  const addableMembers = useMemo(() => {
    const in_group = new Set(manageMembers.map((m) => m.userId));
    const q = addMemberQuery.trim().toLowerCase();
    return teamMembers.filter(
      (t) =>
        !in_group.has(t.id) &&
        (!q ||
          t.email.toLowerCase().includes(q) ||
          (t.name || "").toLowerCase().includes(q))
    );
  }, [teamMembers, manageMembers, addMemberQuery]);

  const canManageActive = manageGroup ? canManage(manageGroup) : false;

  return (
    <>
      {/* List card */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              All groups
            </CardTitle>
            <CardDescription>
              Any teammate can create a group. Only the creator or an admin
              can rename, delete, or change membership.
            </CardDescription>
          </div>
          {groups.length > 0 && (
            <div className="relative w-[220px] shrink-0">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter groups…"
                className="h-8 pl-8 text-sm"
              />
            </div>
          )}
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : groups.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No groups yet"
              description="Groups make it easy to share resources with several teammates at once. Create your first group to get started."
              className="border-0"
              action={
                <Button onClick={openCreate}>
                  <Plus className="h-4 w-4" />
                  Create group
                </Button>
              }
            />
          ) : filteredGroups.length === 0 ? (
            <p className="rounded-md border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
              No groups match “{query}”.
            </p>
          ) : (
            <ul className="divide-y">
              {filteredGroups.map((g) => {
                const mine = canManage(g);
                return (
                  <li
                    key={g.id}
                    className="flex flex-wrap items-center gap-3 py-3"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <Users className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-semibold">{g.name}</span>
                        <Badge variant="secondary" className="text-[10px]">
                          {g.memberCount} member
                          {g.memberCount === 1 ? "" : "s"}
                        </Badge>
                        {mine && (
                          <Badge variant="outline" className="gap-1 text-[10px]">
                            <Crown className="h-3 w-3" />
                            You manage this
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Created by {g.creatorName || "someone"} ·{" "}
                        {new Date(g.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openManage(g)}
                      >
                        {mine ? (
                          <>
                            <Pencil className="h-4 w-4" />
                            Manage
                          </>
                        ) : (
                          <>
                            <Users className="h-4 w-4" />
                            View
                          </>
                        )}
                      </Button>
                      {mine && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Delete group"
                          title="Delete group"
                          onClick={() => deleteGroup(g)}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ============================================================ */}
      {/* Create dialog                                                   */}
      {/* ============================================================ */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              Create a group
            </DialogTitle>
            <DialogDescription>
              Give the group a name, then pick teammates to add. You can
              change the roster at any time.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-group-name">Name</Label>
              <Input
                id="new-group-name"
                autoFocus
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="e.g. Finance team"
                maxLength={120}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && createName.trim()) {
                    e.preventDefault();
                    void submitCreate();
                  }
                }}
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>
                  Members
                  {createMembers.size > 0 && (
                    <span className="ml-1 rounded bg-primary/10 px-1.5 py-[1px] text-[10px] font-medium text-primary">
                      {createMembers.size} selected
                    </span>
                  )}
                </Label>
                {createMembers.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setCreateMembers(new Set())}
                    className="text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    Clear
                  </button>
                )}
              </div>
              {teamMembers.filter((m) => !m.isSelf).length === 0 ? (
                <p className="rounded border border-dashed p-3 text-center text-xs text-muted-foreground">
                  No teammates in this workspace yet. You can still create the
                  group and add members later.
                </p>
              ) : (
                <div className="max-h-[200px] overflow-y-auto rounded border">
                  {teamMembers
                    .filter((m) => !m.isSelf)
                    .map((m) => {
                      const checked = createMembers.has(m.id);
                      return (
                        <label
                          key={m.id}
                          className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 hover:bg-muted/60"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleCreateMember(m.id)}
                            className="h-3.5 w-3.5 shrink-0"
                          />
                          <Avatar name={m.name || m.email} />
                          <span className="min-w-0 flex-1 truncate text-sm">
                            {m.name || m.email}
                          </span>
                          {m.name && (
                            <span className="shrink-0 truncate text-[11px] text-muted-foreground">
                              {m.email}
                            </span>
                          )}
                        </label>
                      );
                    })}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void submitCreate()}
              disabled={!createName.trim() || creating}
            >
              {creating ? "Creating…" : "Create group"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ============================================================ */}
      {/* Manage dialog                                                   */}
      {/* ============================================================ */}
      <Dialog
        open={manageGroup !== null}
        onOpenChange={(v) => {
          if (!v) closeManage();
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              {manageGroup?.name}
            </DialogTitle>
            <DialogDescription>
              {canManageActive
                ? "Rename the group, add teammates, or remove anyone who shouldn't have access."
                : "Group details. Only the creator or an admin can change membership."}
            </DialogDescription>
          </DialogHeader>

          {manageGroup && (
            <div className="space-y-5">
              {/* Rename */}
              {canManageActive && (
                <div className="space-y-1.5">
                  <Label htmlFor="rename-group">Group name</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="rename-group"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      maxLength={120}
                      className="flex-1"
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          renameValue.trim() &&
                          renameValue.trim() !== manageGroup.name
                        ) {
                          e.preventDefault();
                          void submitRename();
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      onClick={() => void submitRename()}
                      disabled={
                        renaming ||
                        !renameValue.trim() ||
                        renameValue.trim() === manageGroup.name
                      }
                    >
                      {renaming ? "Saving…" : "Rename"}
                    </Button>
                  </div>
                </div>
              )}

              {/* Add member */}
              {canManageActive && addableMembers.length > 0 && (
                <div className="space-y-1.5">
                  <Label>Add member</Label>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={addMemberQuery}
                      onChange={(e) => setAddMemberQuery(e.target.value)}
                      placeholder="Search teammates…"
                      className="h-8 pl-8 text-sm"
                    />
                  </div>
                  <div className="max-h-[140px] overflow-y-auto rounded border">
                    {addableMembers.slice(0, 20).map((t) => (
                      <div
                        key={t.id}
                        className="flex items-center gap-2 px-2.5 py-1.5 hover:bg-muted/60"
                      >
                        <Avatar name={t.name || t.email} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm">
                            {t.name || t.email}
                          </div>
                          {t.name && (
                            <div className="truncate text-[11px] text-muted-foreground">
                              {t.email}
                            </div>
                          )}
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7"
                          disabled={addingUserId === t.id}
                          onClick={() => void addMember(t.id)}
                        >
                          {addingUserId === t.id ? (
                            "…"
                          ) : (
                            <>
                              <UserPlus className="h-3.5 w-3.5" />
                              Add
                            </>
                          )}
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {canManageActive && addableMembers.length === 0 && (
                <p className="rounded border border-dashed bg-muted/30 p-3 text-center text-[11px] text-muted-foreground">
                  Everyone in the workspace is already a member.
                </p>
              )}

              {/* Members list */}
              <div className="space-y-1.5">
                <Label>
                  Members ({manageMembers.length})
                </Label>
                {manageMembersLoading ? (
                  <div className="space-y-1">
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                  </div>
                ) : manageMembers.length === 0 ? (
                  <p className="rounded border border-dashed bg-muted/30 p-3 text-center text-[11px] text-muted-foreground">
                    No members yet.{" "}
                    {canManageActive &&
                      "Add teammates from the picker above so they get access to everything shared with this group."}
                  </p>
                ) : (
                  <ul className="divide-y rounded border">
                    {manageMembers.map((m) => {
                      const isSelf = m.userId === myUserId;
                      const canRemove =
                        canManageActive || isSelf; // self-leave is allowed
                      return (
                        <li
                          key={m.userId}
                          className="flex items-center gap-2 px-2.5 py-1.5"
                        >
                          <Avatar name={m.name || m.email} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 truncate text-sm">
                              {m.name || m.email}
                              {isSelf && (
                                <Badge
                                  variant="secondary"
                                  className="text-[10px]"
                                >
                                  You
                                </Badge>
                              )}
                            </div>
                            {m.name && (
                              <div className="truncate text-[11px] text-muted-foreground">
                                {m.email}
                              </div>
                            )}
                          </div>
                          {canRemove && (
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={
                                isSelf && !canManageActive
                                  ? "Leave group"
                                  : "Remove member"
                              }
                              title={
                                isSelf && !canManageActive
                                  ? "Leave group"
                                  : "Remove member"
                              }
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              disabled={removingUserId === m.userId}
                              onClick={() => void removeMember(m)}
                            >
                              {removingUserId === m.userId ? (
                                <span className="text-[11px]">…</span>
                              ) : (
                                <UserMinus className="h-4 w-4" />
                              )}
                            </Button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={closeManage}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});

// Small shared avatar — mirrors the one in share-people-modal so group
// members look the same wherever they appear.
function Avatar({ name }: { name: string }) {
  const initial = (name || "?").trim().charAt(0).toUpperCase();
  return (
    <div
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary"
      )}
    >
      {initial}
    </div>
  );
}
