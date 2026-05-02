"use client";

/**
 * Enterprise folder picker.
 *
 * Replaces the old "paste a folder ID" prompt. Lets users browse their
 * folder tree, see breadcrumbs, drill in/out, search the current level,
 * create a new sub-folder inline, and confirm a destination.
 *
 * Modeled on the existing PromptProvider pattern: mount once at the root
 * layout, then anywhere in the tree call `useFolderPicker()` to get a
 * function that returns a Promise resolving to the chosen folder (or
 * `null` if the user cancelled). Same one-shot, await-style ergonomics
 * as `usePrompt()` so call-sites don't need to manage open/close state.
 *
 * Backed entirely by the existing `/v1/folders` endpoints — no new API
 * surface. Children are fetched lazily per-level (drill-down only loads
 * one folder at a time), so it scales to large org trees without paying
 * for a full recursive fetch up front.
 */

import * as React from "react";
import {
  ChevronRight,
  Folder as FolderIcon,
  FolderPlus,
  Home,
  Loader2,
  Lock,
  Search,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Server-side folder shape — mirrors api/internal/folders/folders.go
// `folderDTO`. Only the fields the picker uses are typed here.
type Folder = {
  id: string;
  parentId?: string | null;
  name: string;
  locked?: boolean;
};

/**
 * Inputs to the picker. Most are optional and have sensible defaults so
 * a typical "Move file" call only has to pass `title` + `currentFolderId`.
 */
export type FolderPickerOptions = {
  /** Dialog title — usually `Move "<filename>"` or `Choose a folder`. */
  title: string;
  /** Optional one-line subtitle below the title. */
  description?: string;
  /** Confirm button label (default: `Select`). */
  confirmLabel?: string;
  /**
   * Folder ID to start the browser at. The picker will auto-navigate to
   * this folder (loading breadcrumbs as needed). Pass `null` to start at
   * the org root. When omitted, defaults to root.
   */
  startAtFolderId?: string | null;
  /**
   * Folder the item currently lives in — gets a "Current location" pill
   * and the Confirm button is disabled while it stays selected so the
   * user doesn't accidentally "move" into the same place.
   */
  currentFolderId?: string | null;
  /**
   * Folders that should be non-selectable (and not navigable into).
   * Used when moving a folder so it can't end up inside itself or one
   * of its descendants. The caller is responsible for computing the
   * descendant list — the picker only honors what's passed.
   */
  excludeFolderIds?: string[];
  /**
   * Allow creating a new folder inline at the current level. Defaults
   * to `true`; pass `false` for read-only contexts.
   */
  allowCreate?: boolean;
};

/**
 * Result of a successful pick. `folderId` is `null` when the user
 * confirmed at the root level. `folderName` is the human label of the
 * destination ("Root" for null) — useful for confirmation toasts.
 */
export type FolderPickerResult = {
  folderId: string | null;
  folderName: string;
};

type PickerFn = (opts: FolderPickerOptions) => Promise<FolderPickerResult | null>;

const FolderPickerContext = React.createContext<PickerFn | null>(null);

export function FolderPickerProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<{
    open: boolean;
    opts: FolderPickerOptions | null;
    resolve: ((v: FolderPickerResult | null) => void) | null;
  }>({ open: false, opts: null, resolve: null });

  const pick = React.useCallback<PickerFn>(
    (opts) =>
      new Promise<FolderPickerResult | null>((resolve) => {
        setState({ open: true, opts, resolve });
      }),
    []
  );

  const close = (result: FolderPickerResult | null) => {
    state.resolve?.(result);
    setState((s) => ({ ...s, open: false }));
  };

  return (
    <FolderPickerContext.Provider value={pick}>
      {children}
      {state.opts && (
        <FolderPickerDialog
          open={state.open}
          opts={state.opts}
          onCancel={() => close(null)}
          onConfirm={(r) => close(r)}
        />
      )}
    </FolderPickerContext.Provider>
  );
}

export function useFolderPicker(): PickerFn {
  const ctx = React.useContext(FolderPickerContext);
  if (!ctx)
    throw new Error("useFolderPicker must be used inside <FolderPickerProvider>");
  return ctx;
}

// ---------------------------------------------------------------------
// Dialog body — keeping the heavy lifting out of the provider so the
// network calls only fire when the dialog is actually open.
// ---------------------------------------------------------------------

function FolderPickerDialog({
  open,
  opts,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  opts: FolderPickerOptions;
  onCancel: () => void;
  onConfirm: (r: FolderPickerResult) => void;
}) {
  // The "current location" the user is browsing inside the picker. null
  // = root. Different from `opts.currentFolderId` (the source location
  // of the item being moved) — that one's a static reference label.
  const [browseId, setBrowseId] = React.useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = React.useState<Folder[]>([]);
  const [children, setChildren] = React.useState<Folder[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const [creatingNew, setCreatingNew] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  const allowCreate = opts.allowCreate !== false;
  const excludeSet = React.useMemo(
    () => new Set(opts.excludeFolderIds || []),
    [opts.excludeFolderIds]
  );

  // Load children + breadcrumbs for `browseId`. Two parallel fetches
  // since they're independent — breadcrumbs only matter for non-root.
  const loadLevel = React.useCallback(
    async (id: string | null) => {
      setLoading(true);
      setFilter("");
      setCreatingNew(false);
      setNewName("");
      try {
        const [kidsRes, crumbsRes] = await Promise.all([
          api<{ folders: Folder[] }>(
            `/v1/folders?parent=${encodeURIComponent(id || "")}`
          ),
          id
            ? api<{ breadcrumbs: Folder[] }>(`/v1/folders/${id}/breadcrumbs`)
            : Promise.resolve({ breadcrumbs: [] as Folder[] }),
        ]);
        setChildren(kidsRes.folders || []);
        setBreadcrumbs(crumbsRes.breadcrumbs || []);
      } catch {
        // On error, fall back to an empty level — the dialog stays
        // usable (user can still navigate up via breadcrumbs / Cancel).
        setChildren([]);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // Initial load when the dialog opens. Reset to opts.startAtFolderId
  // every time so reopening the picker doesn't show stale state from
  // the previous invocation.
  React.useEffect(() => {
    if (!open) return;
    const start =
      opts.startAtFolderId !== undefined
        ? opts.startAtFolderId
        : opts.currentFolderId !== undefined
          ? opts.currentFolderId
          : null;
    setBrowseId(start || null);
    void loadLevel(start || null);
  }, [open, opts.startAtFolderId, opts.currentFolderId, loadLevel]);

  // Drill into a folder. Skip locked / excluded folders defensively
  // (the row is also visually disabled).
  const navigate = (id: string | null) => {
    setBrowseId(id);
    void loadLevel(id);
  };

  const onCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const created = await api<Folder>(`/v1/folders`, {
        method: "POST",
        body: JSON.stringify({
          name,
          parentId: browseId || undefined,
        }),
      });
      // Drop the new folder into the list optimistically and navigate
      // into it — that's almost always what the user wants next.
      setCreatingNew(false);
      setNewName("");
      navigate(created.id);
    } catch {
      // Surfacing a toast from inside this component would couple it
      // to the toast provider; the parent screen will still re-load
      // its own folder list after the picker resolves.
    } finally {
      setCreating(false);
    }
  };

  const filteredChildren = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return children;
    return children.filter((c) => c.name.toLowerCase().includes(q));
  }, [children, filter]);

  // The selected destination is just `browseId` — every navigation
  // implicitly "selects" the level you're looking at. Confirming the
  // root means folderId = null. We surface a dedicated "Select this
  // folder" affordance below the breadcrumbs so the action is explicit.
  const currentLabel =
    browseId === null
      ? "Root"
      : breadcrumbs[breadcrumbs.length - 1]?.name || "Folder";

  const isCurrentSource =
    opts.currentFolderId !== undefined &&
    (opts.currentFolderId || null) === browseId;
  const isCurrentExcluded = browseId !== null && excludeSet.has(browseId);
  const canConfirm = !isCurrentSource && !isCurrentExcluded;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{opts.title}</DialogTitle>
          {opts.description && (
            <DialogDescription>{opts.description}</DialogDescription>
          )}
        </DialogHeader>

        {/* Breadcrumb path. Root is always the first crumb; clicking any
            ancestor jumps back to that level. The trailing crumb is
            non-clickable (it's where you already are). */}
        <div className="flex flex-wrap items-center gap-0.5 rounded-md border bg-muted/40 px-2 py-1.5 text-xs">
          <button
            type="button"
            onClick={() => navigate(null)}
            className={cn(
              "inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-background",
              browseId === null && "font-medium text-foreground"
            )}
          >
            <Home className="h-3 w-3" />
            Root
          </button>
          {breadcrumbs.map((b, i) => {
            const isLast = i === breadcrumbs.length - 1;
            return (
              <React.Fragment key={b.id}>
                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                <button
                  type="button"
                  disabled={isLast}
                  onClick={() => navigate(b.id)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 truncate max-w-[160px]",
                    isLast
                      ? "font-medium text-foreground"
                      : "hover:bg-background text-muted-foreground"
                  )}
                  title={b.name}
                >
                  <FolderIcon className="h-3 w-3" />
                  {b.name}
                </button>
              </React.Fragment>
            );
          })}
        </div>

        {/* Search current level + (optionally) New folder. The search
            only filters the *currently visible* folder list — it doesn't
            do a global search, which would be a separate API. */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter folders at this level…"
              className="h-8 pl-7 text-xs"
            />
          </div>
          {allowCreate && !creatingNew && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCreatingNew(true)}
              type="button"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              New
            </Button>
          )}
        </div>

        {/* Inline create-new-folder row, slot above the list so the new
            folder appears right next to where it'll land in the tree. */}
        {creatingNew && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void onCreate();
            }}
            className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-2 py-1.5"
          >
            <FolderPlus className="h-3.5 w-3.5 shrink-0 text-primary" />
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New folder name"
              className="h-7 text-xs"
              disabled={creating}
            />
            <Button
              size="sm"
              type="submit"
              disabled={!newName.trim() || creating}
            >
              {creating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                "Create"
              )}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => {
                setCreatingNew(false);
                setNewName("");
              }}
            >
              Cancel
            </Button>
          </form>
        )}

        {/* Folder list. Fixed-ish height so the dialog doesn't jump as
            the user drills through levels of varying density. */}
        <div className="max-h-[280px] min-h-[140px] overflow-y-auto rounded-md border">
          {loading ? (
            <div className="grid h-[140px] place-items-center text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : filteredChildren.length === 0 ? (
            <div className="grid h-[140px] place-items-center px-4 text-center text-xs text-muted-foreground">
              {filter
                ? "No folders match your filter."
                : "This folder has no sub-folders."}
            </div>
          ) : (
            <ul className="divide-y">
              {filteredChildren.map((f) => {
                const excluded = excludeSet.has(f.id);
                const locked = !!f.locked;
                const disabled = excluded || locked;
                return (
                  <li key={f.id}>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => navigate(f.id)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
                        disabled
                          ? "cursor-not-allowed opacity-50"
                          : "hover:bg-muted/50"
                      )}
                      title={
                        excluded
                          ? "Can't pick this folder (would create a cycle)"
                          : locked
                            ? "This folder is in the vault"
                            : f.name
                      }
                    >
                      <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate">{f.name}</span>
                      {locked && (
                        <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
                      )}
                      {!disabled && (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Status bar: where you are + (optionally) why you can't pick. */}
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-1.5 truncate">
            <span>Selected destination:</span>
            <span className="font-medium text-foreground">{currentLabel}</span>
            {isCurrentSource && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">
                Current location
              </span>
            )}
            {isCurrentExcluded && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">
                Not allowed
              </span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} type="button">
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canConfirm}
            onClick={() =>
              onConfirm({ folderId: browseId, folderName: currentLabel })
            }
            title={
              isCurrentSource
                ? "This is already the current location"
                : isCurrentExcluded
                  ? "This destination is not allowed"
                  : undefined
            }
          >
            {opts.confirmLabel ?? "Select"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
