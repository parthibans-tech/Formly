"use client";

// Groups panel — manage widget groups from the side rail instead of relying
// on Cmd+G / Cmd+Shift+G shortcuts.
//
// Responsibilities
//   • Show every group on the template, its member count, and sample member
//     labels so the user can identify it at a glance.
//   • Let the user rename a group (mutates props._groupName on every member).
//   • Select all members of a group with one click.
//   • Ungroup / delete the group without losing the underlying widgets.
//   • Delete every widget that belongs to the group.
//   • Create a new group from the current selection (same as Cmd+G but
//     discoverable via UI), with an optional immediate rename.

import { useMemo, useState } from "react";
import {
  Group as GroupIcon,
  MousePointerSquareDashed,
  Pencil,
  Trash2,
  Ungroup,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type GroupWidget = {
  id: string;
  type: string;
  dataKey: string;
  props: Record<string, any>;
};

export type GroupInfo = {
  id: string;
  name: string;
  memberCount: number;
  /** Labels of up to ~3 members, for previewing contents. */
  memberLabels: string[];
};

type Props = {
  widgets: GroupWidget[];
  selectedIds: string[];
  /** Create a new group from the current selection. */
  onCreateGroup: () => void;
  /** Set a human-readable name for a group (props._groupName on every member). */
  onRenameGroup: (groupId: string, name: string) => void;
  /** Select every widget in the group. */
  onSelectGroup: (groupId: string) => void;
  /** Remove the group association from every member (widgets stay). */
  onUngroup: (groupId: string) => void;
  /** Delete every widget in the group. */
  onDeleteGroup: (groupId: string) => void;
};

export function GroupsPanel({
  widgets,
  selectedIds,
  onCreateGroup,
  onRenameGroup,
  onSelectGroup,
  onUngroup,
  onDeleteGroup,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmMode, setConfirmMode] = useState<"ungroup" | "delete" | null>(
    null
  );

  // Build group summaries from widget props.
  const groups: GroupInfo[] = useMemo(() => {
    const byId = new Map<string, GroupWidget[]>();
    for (const w of widgets) {
      const gid = w.props?._group as string | undefined;
      if (!gid) continue;
      if (!byId.has(gid)) byId.set(gid, []);
      byId.get(gid)!.push(w);
    }
    const list: GroupInfo[] = [];
    for (const [gid, members] of byId) {
      // Name: use _groupName from the first member that has one,
      // falling back to a short suffix of the group id.
      const named = members.find((m) => m.props?._groupName);
      const name =
        (named?.props?._groupName as string | undefined) ||
        `Group ${gid.slice(-4)}`;
      const memberLabels = members.slice(0, 3).map((m) => {
        const lbl = (m.props?._label as string | undefined) || m.dataKey || m.type;
        return lbl;
      });
      list.push({
        id: gid,
        name,
        memberCount: members.length,
        memberLabels,
      });
    }
    // Stable sort: alphabetical by name, then by id.
    list.sort((a, b) =>
      a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    );
    return list;
  }, [widgets]);

  const canCreate = selectedIds.length >= 2;

  // How many of the currently selected widgets already have a group?
  const selectedGroupIds = useMemo(() => {
    const gs = new Set<string>();
    for (const id of selectedIds) {
      const w = widgets.find((x) => x.id === id);
      const g = w?.props?._group as string | undefined;
      if (g) gs.add(g);
    }
    return gs;
  }, [selectedIds, widgets]);

  function startEdit(g: GroupInfo) {
    setEditingId(g.id);
    setEditValue(g.name.startsWith("Group ") ? "" : g.name);
  }

  function commitEdit(id: string) {
    onRenameGroup(id, editValue.trim());
    setEditingId(null);
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Groups
        </span>
        <span className="text-[10px] text-muted-foreground">
          {groups.length}
        </span>
      </div>

      {/* Create-from-selection toolbar */}
      <div className="px-3 pb-2">
        <button
          type="button"
          disabled={!canCreate}
          onClick={onCreateGroup}
          className={cn(
            "flex w-full items-center justify-center gap-1.5 rounded border px-2 py-1.5 text-xs transition-colors",
            canCreate
              ? "border-primary/30 bg-primary/5 text-primary hover:bg-primary/10"
              : "cursor-not-allowed border-border bg-muted/40 text-muted-foreground"
          )}
          title={
            canCreate
              ? "Create a new group from the current selection (⌘G)"
              : "Select 2 or more widgets on the canvas to group them"
          }
        >
          <GroupIcon className="h-3.5 w-3.5" />
          Group selection
          {canCreate && (
            <span className="ml-1 rounded bg-primary/15 px-1 text-[10px]">
              {selectedIds.length}
            </span>
          )}
        </button>
        {selectedGroupIds.size > 0 && (
          <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
            {selectedIds.length === 1
              ? "This widget is already in a group."
              : `${selectedGroupIds.size} group${
                  selectedGroupIds.size > 1 ? "s" : ""
                } overlap with this selection.`}
          </p>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto pb-2">
        {groups.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] leading-snug text-muted-foreground">
            No groups yet.
            <br />
            Select 2+ widgets and click{" "}
            <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
              <GroupIcon className="h-2.5 w-2.5" />
              Group selection
            </span>{" "}
            above, or press{" "}
            <span className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
              ⌘G
            </span>
            .
          </div>
        ) : (
          <ul className="space-y-1 px-2">
            {groups.map((g) => {
              const isEditing = editingId === g.id;
              const isConfirming = confirmId === g.id;
              return (
                <li
                  key={g.id}
                  className="rounded border bg-background px-2 py-1.5 text-xs shadow-sm"
                >
                  <div className="flex items-center gap-1.5">
                    <Users className="h-3 w-3 shrink-0 text-violet-500" />

                    {/* Name / rename input */}
                    {isEditing ? (
                      <input
                        autoFocus
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => commitEdit(g.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitEdit(g.id);
                          if (e.key === "Escape") setEditingId(null);
                          e.stopPropagation();
                        }}
                        placeholder={g.name}
                        className="min-w-0 flex-1 rounded border px-1 py-0 text-xs outline-none focus:ring-1 focus:ring-primary/40"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => startEdit(g)}
                        className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                        title={`Rename "${g.name}"`}
                      >
                        {g.name}
                      </button>
                    )}

                    <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                      {g.memberCount}
                    </span>

                    {/* Rename (pencil) */}
                    {!isEditing && (
                      <button
                        type="button"
                        title="Rename group"
                        onClick={() => startEdit(g)}
                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    )}
                  </div>

                  {/* Member preview */}
                  {g.memberLabels.length > 0 && (
                    <div className="mt-1 truncate text-[10px] text-muted-foreground">
                      {g.memberLabels.join(", ")}
                      {g.memberCount > g.memberLabels.length
                        ? `, +${g.memberCount - g.memberLabels.length} more`
                        : ""}
                    </div>
                  )}

                  {/* Action row */}
                  <div className="mt-1.5 flex items-center gap-1">
                    <button
                      type="button"
                      title="Select all members of this group"
                      onClick={() => onSelectGroup(g.id)}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-foreground hover:bg-muted"
                    >
                      <MousePointerSquareDashed className="h-3 w-3" />
                      Select
                    </button>

                    <button
                      type="button"
                      title="Ungroup — removes the group but keeps the widgets"
                      onClick={() => {
                        setConfirmId(g.id);
                        setConfirmMode("ungroup");
                      }}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-foreground hover:bg-muted"
                    >
                      <Ungroup className="h-3 w-3" />
                      Ungroup
                    </button>

                    <button
                      type="button"
                      title="Delete every widget in this group"
                      onClick={() => {
                        setConfirmId(g.id);
                        setConfirmMode("delete");
                      }}
                      className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-3 w-3" />
                      Delete
                    </button>
                  </div>

                  {/* Confirm bar */}
                  {isConfirming && confirmMode && (
                    <div
                      className={cn(
                        "mt-1.5 flex items-center gap-1 rounded border p-1 text-[10px]",
                        confirmMode === "delete"
                          ? "border-destructive/30 bg-destructive/5"
                          : "border-amber-400/40 bg-amber-50"
                      )}
                    >
                      <span className="mr-auto text-foreground">
                        {confirmMode === "delete"
                          ? `Delete ${g.memberCount} widget${
                              g.memberCount > 1 ? "s" : ""
                            }?`
                          : `Ungroup ${g.memberCount} widget${
                              g.memberCount > 1 ? "s" : ""
                            }?`}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmId(null);
                          setConfirmMode(null);
                        }}
                        className="rounded px-1.5 py-0.5 hover:bg-muted"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (confirmMode === "delete") onDeleteGroup(g.id);
                          else onUngroup(g.id);
                          setConfirmId(null);
                          setConfirmMode(null);
                        }}
                        className={cn(
                          "rounded px-1.5 py-0.5 font-medium text-white",
                          confirmMode === "delete"
                            ? "bg-destructive hover:bg-destructive/90"
                            : "bg-amber-500 hover:bg-amber-600"
                        )}
                      >
                        Confirm
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
