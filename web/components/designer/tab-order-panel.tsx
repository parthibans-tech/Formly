"use client";

// Tab-order panel — left rail showing interactive AcroForm widgets sorted by
// their acroTabOrder prop. Drag rows to reorder; the panel writes sequential
// integers back into each widget's acroTabOrder prop.

import { useRef, useState } from "react";
import { GripVertical, Hash } from "lucide-react";
import { isAcroFieldType } from "@/lib/acroform-types";
import { cn } from "@/lib/utils";

export type TabWidget = {
  id: string;
  type: string;
  dataKey: string;
  props: Record<string, any>;
};

type Props = {
  widgets: TabWidget[];
  selectedIds: string[];
  onSelect: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
};

// Badge abbreviation per type.
const TYPE_BADGE: Record<string, string> = {
  text: "T",
  multiline: "¶",
  number: "#",
  currency: "$",
  date: "dt",
  checkbox: "☑",
  radio: "◉",
  dropdown: "▾",
  "signature-field": "✎",
  button: "▶",
};

export function TabOrderPanel({ widgets, selectedIds, onSelect, onReorder }: Props) {
  // Filter to interactive-field types only, sorted by acroTabOrder then zIndex.
  const interactive = widgets
    .filter((w) => isAcroFieldType(w.type))
    .sort((a, b) => {
      const ao = a.props.acroTabOrder ?? 9999;
      const bo = b.props.acroTabOrder ?? 9999;
      return ao - bo;
    });

  const dragIdRef = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  function handleDragStart(id: string) {
    dragIdRef.current = id;
  }

  function handleDragOver(e: React.DragEvent, id: string) {
    e.preventDefault();
    setDragOverId(id);
  }

  function handleDrop(targetId: string) {
    const srcId = dragIdRef.current;
    if (!srcId || srcId === targetId) {
      setDragOverId(null);
      return;
    }
    const ids = interactive.map((w) => w.id);
    const srcIdx = ids.indexOf(srcId);
    const tgtIdx = ids.indexOf(targetId);
    ids.splice(srcIdx, 1);
    ids.splice(tgtIdx, 0, srcId);
    onReorder(ids);
    dragIdRef.current = null;
    setDragOverId(null);
  }

  function handleDragEnd() {
    dragIdRef.current = null;
    setDragOverId(null);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <Hash className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Tab order
        </span>
      </div>

      {interactive.length === 0 ? (
        <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">
          No interactive fields yet.
          <br />
          Add text, checkbox, radio, or dropdown widgets.
        </p>
      ) : (
        <ul className="flex-1 overflow-y-auto px-1 py-1">
          {interactive.map((w, i) => {
            const isSelected = selectedIds.includes(w.id);
            const isDragOver = dragOverId === w.id;
            const badge = TYPE_BADGE[w.type] ?? w.type.slice(0, 2);
            const label =
              (w.props._label as string) ||
              (w.props.acroGroupName
                ? `${w.dataKey} (${w.props.acroGroupName})`
                : w.dataKey);

            return (
              <li
                key={w.id}
                draggable
                onDragStart={() => handleDragStart(w.id)}
                onDragOver={(e) => handleDragOver(e, w.id)}
                onDrop={() => handleDrop(w.id)}
                onDragEnd={handleDragEnd}
                onClick={() => onSelect(w.id)}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 rounded px-1 py-1 text-xs",
                  isSelected ? "bg-primary/15 text-primary" : "hover:bg-muted/60",
                  isDragOver && "ring-1 ring-primary/50"
                )}
              >
                <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground/60" />
                <span className="w-5 shrink-0 text-center font-mono text-[10px] text-muted-foreground">
                  {i + 1}
                </span>
                <span className="w-6 shrink-0 rounded bg-muted/60 px-0.5 text-center font-mono text-[9px]">
                  {badge}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="border-t px-3 py-2 text-[10px] text-muted-foreground">
        {interactive.length} interactive field{interactive.length === 1 ? "" : "s"} ·
        drag to reorder
      </div>
    </div>
  );
}
