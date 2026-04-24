"use client";

// BulkToolbar — visible when 2+ rows are multi-selected. Offers
// find/replace rename, toggle required, set transform, set section,
// clear dataKey, and auto-generate dataKey.

import { useState } from "react";
import {
  ChevronDown,
  Eraser,
  Hash,
  Pencil,
  Wand2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TRANSFORM_CATALOG, Transform } from "@/lib/acroform-transforms";
import type { AcroMapping } from "./types";

type Props = {
  selectedNames: string[];
  onClear: () => void;
  onApplyPatch: (names: string[], patch: Partial<AcroMapping>) => void;
  onRename: (names: string[], pattern: string, replacement: string) => void;
  onAutoKey: (names: string[], style: "snake" | "camel" | "kebab") => void;
};

export function BulkToolbar({
  selectedNames,
  onClear,
  onApplyPatch,
  onRename,
  onAutoKey,
}: Props) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [pattern, setPattern] = useState("");
  const [replacement, setReplacement] = useState("");
  const [sectionOpen, setSectionOpen] = useState(false);
  const [sectionName, setSectionName] = useState("");

  if (selectedNames.length === 0) return null;

  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/95 px-3 py-2 text-xs backdrop-blur">
      <span className="font-medium">{selectedNames.length} selected</span>
      <div className="flex-1" />

      <Button size="sm" variant="outline" onClick={() => setRenameOpen(true)}>
        <Pencil className="h-3.5 w-3.5" /> Rename keys
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">
            <Wand2 className="h-3.5 w-3.5" /> Transform <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
          <DropdownMenuLabel>Apply to selection</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {TRANSFORM_CATALOG.map((c) => (
            <DropdownMenuItem
              key={c.op}
              onClick={() =>
                onApplyPatch(selectedNames, {
                  transform: c.op === "none" ? undefined : ({ op: c.op } as Transform),
                })
              }
            >
              {c.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">
            <Hash className="h-3.5 w-3.5" /> Auto-key <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onAutoKey(selectedNames, "snake")}>snake_case</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onAutoKey(selectedNames, "camel")}>camelCase</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onAutoKey(selectedNames, "kebab")}>kebab-case</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        size="sm"
        variant="outline"
        onClick={() => onApplyPatch(selectedNames, { required: true })}
      >
        Require
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => onApplyPatch(selectedNames, { required: false })}
      >
        Unrequire
      </Button>

      <Button size="sm" variant="outline" onClick={() => setSectionOpen(true)}>
        Section…
      </Button>

      <Button
        size="sm"
        variant="outline"
        onClick={() => onApplyPatch(selectedNames, { dataKey: "" })}
      >
        <Eraser className="h-3.5 w-3.5" /> Clear keys
      </Button>

      <Button size="sm" variant="ghost" onClick={onClear}>
        <X className="h-3.5 w-3.5" />
      </Button>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename data keys</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="space-y-1">
              <Label>Regex pattern</Label>
              <Input
                className="font-mono"
                placeholder="^billing_"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Replacement</Label>
              <Input
                className="font-mono"
                placeholder="invoice_"
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Applied to {selectedNames.length} selected row{selectedNames.length === 1 ? "" : "s"}'
              data key.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                onRename(selectedNames, pattern, replacement);
                setRenameOpen(false);
                setPattern("");
                setReplacement("");
              }}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={sectionOpen} onOpenChange={setSectionOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Move to section</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="space-y-1">
              <Label>Section name (empty = ungrouped)</Label>
              <Input
                placeholder="Billing"
                value={sectionName}
                onChange={(e) => setSectionName(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSectionOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                onApplyPatch(selectedNames, {
                  section: sectionName || undefined,
                });
                setSectionOpen(false);
                setSectionName("");
              }}
            >
              Move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
