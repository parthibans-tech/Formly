"use client";

// FixturesPicker — compact toolbar for switching between named sample
// data fixtures. Mounted above the Field mapping list so the active
// fixture is visible wherever the user is editing.
//
// Actions
// -------
//   • Select      — dropdown lists all fixtures, updates activeId
//   • New…        — prompt for name, creates an empty fixture
//   • Rename…     — prompt for new name
//   • Duplicate   — copies the active fixture with " copy" suffix
//   • Delete      — confirm, then drop (no-op on the last one)
//   • Edit JSON   — opens the raw JSON editor dialog
//
// The JSON editor lives inside this component because nothing else owns
// it; `onEditJSON` surfaces the dialog open toggle so the parent can
// integrate with its toast/feedback system if needed.

import { useState } from "react";
import {
  ChevronDown,
  Copy,
  FileJson,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { UseFixtures } from "@/hooks/use-acroform-fixtures";

type Props = {
  fx: UseFixtures;
  onImportCsv?: () => void;
};

export function FixturesPicker({ fx, onImportCsv }: Props) {
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonDraft, setJsonDraft] = useState("");
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  function openJson() {
    setJsonDraft(JSON.stringify(fx.data, null, 2));
    setJsonErr(null);
    setJsonOpen(true);
  }
  function saveJson() {
    try {
      const parsed = JSON.parse(jsonDraft);
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("Must be a JSON object");
      }
      fx.setData(parsed);
      setJsonOpen(false);
    } catch (e: any) {
      setJsonErr(e.message || "Invalid JSON");
    }
  }

  const active = fx.active;

  return (
    <>
      <div className="flex items-center gap-1 border-b bg-muted/20 px-4 py-2 text-xs">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Sample
        </span>
        <div className="relative flex-1">
          <button
            type="button"
            onClick={() => setDropdownOpen((o) => !o)}
            onBlur={() => setTimeout(() => setDropdownOpen(false), 150)}
            className="flex h-7 w-full items-center justify-between gap-1 rounded-md border bg-background px-2 text-xs hover:bg-muted/50"
          >
            <span className="truncate">
              {active ? active.name : "No fixture"}
              {fx.fixtures.length > 1 && (
                <span className="ml-1 text-muted-foreground">
                  ({fx.fixtures.length})
                </span>
              )}
            </span>
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          </button>
          {dropdownOpen && fx.fixtures.length > 0 && (
            <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-md border bg-popover shadow-lg">
              {fx.fixtures.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between px-2 py-1.5 text-left text-xs hover:bg-muted",
                    f.id === fx.activeId && "bg-muted font-medium"
                  )}
                  onMouseDown={(e) => {
                    // Prevent the button's blur from firing before onClick.
                    e.preventDefault();
                  }}
                  onClick={() => {
                    fx.setActive(f.id);
                    setDropdownOpen(false);
                  }}
                >
                  <span className="truncate">{f.name}</span>
                  <span className="ml-2 text-[10px] text-muted-foreground">
                    {Object.keys(f.data).length} keys
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <IconButton
            title="New fixture"
            onClick={() => {
              const name = window.prompt("Fixture name:", "New fixture");
              if (name) fx.create(name, {});
            }}
          >
            <Plus className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            title="Rename"
            disabled={!active}
            onClick={() => {
              if (!active) return;
              const name = window.prompt("Rename to:", active.name);
              if (name) fx.rename(active.id, name);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            title="Duplicate"
            disabled={!active}
            onClick={() => active && fx.duplicate(active.id)}
          >
            <Copy className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            title="Delete"
            disabled={!active || fx.fixtures.length < 2}
            onClick={() => {
              if (!active) return;
              if (window.confirm(`Delete fixture "${active.name}"?`)) {
                fx.remove(active.id);
              }
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            title="Edit JSON"
            disabled={!active}
            onClick={openJson}
          >
            <FileJson className="h-3.5 w-3.5" />
          </IconButton>
          {onImportCsv && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={onImportCsv}
            >
              CSV…
            </Button>
          )}
        </div>
      </div>

      <Dialog open={jsonOpen} onOpenChange={setJsonOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              Edit fixture — {active?.name ?? ""}
            </DialogTitle>
            <DialogDescription>
              Keys must match the mapping data keys exactly. This is the
              sample used for previews and as the default payload when
              you click Generate.
            </DialogDescription>
          </DialogHeader>
          <textarea
            className="h-72 w-full rounded-md border bg-background p-3 font-mono text-xs"
            value={jsonDraft}
            onChange={(e) => setJsonDraft(e.target.value)}
          />
          {jsonErr && (
            <div className="text-xs text-destructive">{jsonErr}</div>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setJsonOpen(false)}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={saveJson}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className="flex h-7 w-7 items-center justify-center rounded hover:bg-muted disabled:opacity-40"
    >
      {children}
    </button>
  );
}
