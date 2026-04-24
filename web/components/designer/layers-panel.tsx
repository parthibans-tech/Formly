"use client";

// Layers panel — shows every widget stacked by z-index (front first).
// Supports:
//   • click to select / Cmd-click to multi-select
//   • HTML5 drag-to-reorder (updates z-order)
//   • double-click label to rename (_label prop)
//   • eye / lock icon toggles per row
//   • group membership badge (Cmd+G sets props._group)
//   • filter by label / type / dataKey

import { useState } from "react";
import { Eye, EyeOff, GripVertical, Lock, LockOpen, Users } from "lucide-react";
import { cn } from "@/lib/utils";

export type LayerWidget = {
  id: string;
  type: string;
  dataKey: string;
  zIndex: number;
  locked?: boolean;
  hidden?: boolean;
  props: Record<string, any>;
};

type Props = {
  widgets: LayerWidget[];
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  onReorder: (draggedId: string, targetId: string) => void;
  onToggleLock: (id: string) => void;
  onToggleHide: (id: string) => void;
  onRename: (id: string, label: string) => void;
  /** Select all members of a group */
  onSelectGroup: (groupId: string) => void;
};

// Short badge shown in the type column.
const TYPE_BADGE: Record<string, string> = {
  text: "T",
  multiline: "¶",
  number: "#",
  currency: "$",
  date: "dt",
  checkbox: "☑",
  qr: "QR",
  barcode: "║",
  image: "img",
  signature: "sig",
  rectangle: "▭",
  line: "—",
  pageNumber: "#p",
  watermark: "wm",
  repeat: "⇌",
};

export function LayersPanel({
  widgets,
  selectedIds,
  onSelect,
  onReorder,
  onToggleLock,
  onToggleHide,
  onRename,
  onSelectGroup,
}: Props) {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Highest z-index at top (front layer first — same convention as Figma).
  const sorted = [...widgets].sort((a, b) => b.zIndex - a.zIndex);

  const filtered = query.trim()
    ? sorted.filter((w) => {
        const q = query.toLowerCase();
        const label = (w.props?._label as string | undefined) ?? w.dataKey ?? w.type;
        return (
          label.toLowerCase().includes(q) ||
          w.type.toLowerCase().includes(q) ||
          w.dataKey.toLowerCase().includes(q)
        );
      })
    : sorted;

  function startEdit(w: LayerWidget) {
    setEditingId(w.id);
    setEditValue((w.props?._label as string | undefined) ?? "");
  }

  function commitEdit(id: string) {
    onRename(id, editValue.trim());
    setEditingId(null);
  }

  function handleRowClick(e: React.MouseEvent, w: LayerWidget) {
    if (e.metaKey || e.ctrlKey) {
      // toggle
      onSelect(
        selectedIds.includes(w.id)
          ? selectedIds.filter((id) => id !== w.id)
          : [...selectedIds, w.id]
      );
    } else if (e.shiftKey && selectedIds.length > 0) {
      // range-select across the sorted list
      const lastIdx = sorted.findIndex((x) => x.id === selectedIds[selectedIds.length - 1]);
      const thisIdx = sorted.findIndex((x) => x.id === w.id);
      const [lo, hi] = lastIdx < thisIdx ? [lastIdx, thisIdx] : [thisIdx, lastIdx];
      const rangeIds = sorted.slice(lo, hi + 1).map((x) => x.id);
      onSelect([...new Set([...selectedIds, ...rangeIds])]);
    } else {
      onSelect([w.id]);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Layers
        </span>
        <span className="text-[10px] text-muted-foreground">{widgets.length}</span>
      </div>

      {/* Filter */}
      <div className="px-3 pb-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter layers…"
          className="h-7 w-full rounded border px-2 text-xs outline-none focus:ring-1 focus:ring-primary/40"
        />
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto pb-2">
        <ul className="space-y-px px-1">
          {filtered.map((w) => {
            const isSelected = selectedIds.includes(w.id);
            const isHidden = !!(w.hidden || w.props?._hidden);
            const isLocked = !!(w.locked || w.props?._locked);
            const groupId = w.props?._group as string | undefined;
            const label =
              (w.props?._label as string | undefined) ||
              w.dataKey ||
              w.type;
            const badge = TYPE_BADGE[w.type] ?? w.type.slice(0, 3);
            const isDragTarget = dragOverId === w.id && dragId !== w.id;

            return (
              <li
                key={w.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  setDragId(w.id);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDragOverId(w.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDragOverId(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragId && dragId !== w.id) onReorder(dragId, w.id);
                  setDragId(null);
                  setDragOverId(null);
                }}
                onClick={(e) => handleRowClick(e, w)}
                className={cn(
                  "group flex cursor-pointer select-none items-center gap-1.5 rounded px-1.5 py-1 text-xs transition-colors",
                  isSelected
                    ? "bg-primary/10 text-primary"
                    : "hover:bg-muted/60 text-foreground",
                  isDragTarget && "border-t-2 border-primary",
                  isHidden && "opacity-40",
                  dragId === w.id && "opacity-30"
                )}
              >
                {/* Drag handle */}
                <GripVertical className="h-3 w-3 shrink-0 cursor-grab text-muted-foreground opacity-0 group-hover:opacity-60" />

                {/* Type badge */}
                <span className="w-7 shrink-0 rounded bg-muted px-0.5 text-center font-mono text-[9px] text-muted-foreground">
                  {badge}
                </span>

                {/* Label — double-click to rename */}
                {editingId === w.id ? (
                  <input
                    autoFocus
                    className="min-w-0 flex-1 rounded border px-1 py-0 text-xs outline-none focus:ring-1 focus:ring-primary/40"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => commitEdit(w.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit(w.id);
                      if (e.key === "Escape") setEditingId(null);
                      e.stopPropagation();
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className="min-w-0 flex-1 truncate"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      startEdit(w);
                    }}
                    title={label}
                  >
                    {label}
                  </span>
                )}

                {/* Group badge — click to select all members */}
                {groupId && (
                  <button
                    type="button"
                    title={`Select group ${groupId.slice(-4)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectGroup(groupId);
                    }}
                    className="shrink-0 opacity-0 group-hover:opacity-100"
                  >
                    <Users className="h-3 w-3 text-violet-500" />
                  </button>
                )}

                {/* Visibility toggle */}
                <button
                  type="button"
                  title={isHidden ? "Show widget" : "Hide widget"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleHide(w.id);
                  }}
                  className="shrink-0 opacity-0 group-hover:opacity-100"
                >
                  {isHidden ? (
                    <EyeOff className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <Eye className="h-3 w-3 text-muted-foreground" />
                  )}
                </button>

                {/* Lock toggle */}
                <button
                  type="button"
                  title={isLocked ? "Unlock widget" : "Lock widget"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleLock(w.id);
                  }}
                  className={cn(
                    "shrink-0",
                    isLocked ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  )}
                >
                  {isLocked ? (
                    <Lock className="h-3 w-3 text-amber-500" />
                  ) : (
                    <LockOpen className="h-3 w-3 text-muted-foreground" />
                  )}
                </button>
              </li>
            );
          })}

          {filtered.length === 0 && (
            <li className="px-3 py-6 text-center text-[11px] text-muted-foreground">
              {query ? "No matching layers." : "No widgets on this template."}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
