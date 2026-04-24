"use client";

// AlignToolbar — horizontal row of align/distribute/match-size buttons.
// Appears in Edit mode when 2+ fields are multi-selected. Emits intent
// events; the parent computes new rects via align-tools.ts and commits.
//
// Icons are picked from lucide-react to stay consistent with the rest of
// the designer chrome. Match-size uses Stretch + MoveVertical because
// lucide doesn't ship a dedicated "same width / same height" glyph.

import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  MoveHorizontal,
  MoveVertical,
  Ruler,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AlignAxis, DistributeAxis, SizeAxis } from "./align-tools";

type Props = {
  count: number;
  onAlign: (axis: AlignAxis) => void;
  onDistribute: (axis: DistributeAxis) => void;
  onMatchSize: (axis: SizeAxis) => void;
  onClear: () => void;
};

export function AlignToolbar({
  count,
  onAlign,
  onDistribute,
  onMatchSize,
  onClear,
}: Props) {
  return (
    <div className="flex items-center gap-1 border-b bg-muted/30 px-3 py-1.5 text-xs">
      <span className="text-muted-foreground">{count} selected</span>
      <div className="mx-2 h-4 w-px bg-border" aria-hidden />
      <div className="flex items-center gap-0.5" title="Align">
        <IconButton title="Align left" onClick={() => onAlign("left")}>
          <AlignStartVertical className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          title="Align center (horizontal)"
          onClick={() => onAlign("centerH")}
        >
          <AlignCenterVertical className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton title="Align right" onClick={() => onAlign("right")}>
          <AlignEndVertical className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <div className="mx-1 h-4 w-px bg-border" aria-hidden />
      <div className="flex items-center gap-0.5" title="Align (vertical)">
        <IconButton title="Align top" onClick={() => onAlign("top")}>
          <AlignStartHorizontal className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          title="Align middle (vertical)"
          onClick={() => onAlign("middleV")}
        >
          <AlignCenterHorizontal className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton title="Align bottom" onClick={() => onAlign("bottom")}>
          <AlignEndHorizontal className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <div className="mx-1 h-4 w-px bg-border" aria-hidden />
      <div className="flex items-center gap-0.5" title="Distribute">
        <IconButton
          title="Distribute horizontally"
          disabled={count < 3}
          onClick={() => onDistribute("horizontal")}
        >
          <MoveHorizontal className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          title="Distribute vertically"
          disabled={count < 3}
          onClick={() => onDistribute("vertical")}
        >
          <MoveVertical className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <div className="mx-1 h-4 w-px bg-border" aria-hidden />
      <div className="flex items-center gap-0.5" title="Match size">
        <IconButton
          title="Match width (first selected)"
          onClick={() => onMatchSize("width")}
        >
          <Ruler className="h-3.5 w-3.5 rotate-90" />
        </IconButton>
        <IconButton
          title="Match height (first selected)"
          onClick={() => onMatchSize("height")}
        >
          <Ruler className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <div className="ml-auto">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={onClear}
        >
          Clear
        </Button>
      </div>
    </div>
  );
}

function IconButton({
  children,
  onClick,
  title,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="flex h-7 w-7 items-center justify-center rounded hover:bg-muted disabled:opacity-40"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
    >
      {children}
    </button>
  );
}
