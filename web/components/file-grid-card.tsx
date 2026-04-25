"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Check,
  Download,
  Info,
  MoreHorizontal,
  Move,
  PencilLine,
  Share2,
  Star,
  Trash2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  badgeColorsForKind,
  categorizeFile,
  colorForKind,
  iconForKind,
  shortLabelForKind,
} from "@/lib/file-icons";
import { API_URL, getToken } from "@/lib/api";
import { cn } from "@/lib/utils";

export type GridFile = {
  id: string;
  name: string;
  mime: string;
  size: number;
  status: string;
  templateId?: string;
  folderId?: string | null;
  createdAt: string;
  // Per-user starred flag. Rendered as a star overlay on the thumbnail
  // when true; toggles via `onToggleStar`.
  starred?: boolean;
  // Office-doc preview pipeline. Drives a small status chip on the
  // grid card and routes the thumbnail/preview to the converted PDF
  // when ready. Null on files that don't go through soffice.
  previewPdfId?: string | null;
  convertStatus?: "pending" | "ready" | "failed" | "unsupported" | "macro_warning" | null;
  convertWarning?: string | null;
};

export type GridCardMenuItem = {
  label: string;
  icon: React.ReactNode;
  onClick?: () => void;
  href?: string;
  destructive?: boolean;
  separatorBefore?: boolean;
};

type Props = {
  file: GridFile;
  actorInitials: string;
  actorLabel?: string; // e.g. "You modified"
  selected?: boolean;
  highlighted?: boolean;
  onToggleSelect?: () => void;
  onOpenDetails?: () => void;
  // Used when no `menuItems` override is provided (main drive page).
  onDownload?: () => void;
  onShare?: () => void;
  onMove?: () => void;
  onRemove?: () => void;
  // Optional star toggle. When provided, renders a small star button
  // overlaid on the thumbnail's top-right corner (symmetric with the
  // select checkbox on the top-left). Fires on click; the parent is
  // responsible for updating `file.starred`. No callback = no overlay.
  onToggleStar?: () => void;
  // If provided, completely replaces the default action menu.
  menuItems?: GridCardMenuItem[];
  // When true, clicking anywhere on the card (not a button/link) opens
  // details. Defaults to true when `onOpenDetails` is provided.
  clickOpensDetails?: boolean;
  // Enable the selection checkbox. Defaults to true when `onToggleSelect` is
  // provided.
  showSelectCheckbox?: boolean;
  // True when any file in the parent list is already selected — i.e. the
  // user is in "bulk selection" mode. Shows the checkbox on every card
  // unconditionally so the UI is obviously in a multi-select state.
  // When false, the checkbox only fades in on hover (Drive-style).
  bulkSelectActive?: boolean;
  // Whether this card is draggable (drive page) or not (trash/recent/etc.).
  draggable?: boolean;
};

export function FileGridCard({
  file,
  actorInitials,
  actorLabel = "You modified",
  selected = false,
  highlighted = false,
  onToggleSelect,
  onOpenDetails,
  onDownload,
  onShare,
  onMove,
  onRemove,
  onToggleStar,
  menuItems,
  clickOpensDetails,
  showSelectCheckbox,
  bulkSelectActive = false,
  draggable = true,
}: Props) {
  const kind = categorizeFile(file.mime, file.name);
  const canOpenDetails =
    clickOpensDetails ?? (typeof onOpenDetails === "function");
  const canToggleSelect =
    showSelectCheckbox ?? (typeof onToggleSelect === "function");

  // Resolve the menu: caller-provided wins; otherwise build defaults from the
  // per-action props (back-compat with the original drive-page callers).
  const resolvedMenu: GridCardMenuItem[] =
    menuItems ??
    [
      file.templateId && {
        label: "Open designer",
        icon: <PencilLine className="h-4 w-4" />,
        href: `/templates/${file.templateId}/designer`,
      },
      onOpenDetails && {
        label: "View details",
        icon: <Info className="h-4 w-4" />,
        onClick: onOpenDetails,
      },
      onDownload && {
        label: "Download",
        icon: <Download className="h-4 w-4" />,
        onClick: onDownload,
      },
      onShare && {
        label: "Share",
        icon: <Share2 className="h-4 w-4" />,
        onClick: onShare,
      },
      onMove && {
        label: "Move…",
        icon: <Move className="h-4 w-4" />,
        onClick: onMove,
      },
      onRemove && {
        label: "Move to trash",
        icon: <Trash2 className="h-4 w-4" />,
        onClick: onRemove,
        destructive: true,
        separatorBefore: true,
      },
    ].filter(Boolean) as GridCardMenuItem[];

  return (
    <div
      draggable={draggable}
      onDragStart={(e) => {
        if (!draggable) return;
        e.dataTransfer.setData("application/x-formly-file", file.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={(e) => {
        if (!canOpenDetails) return;
        const target = e.target as HTMLElement;
        // Skip if the click came from any interactive element OR from
        // inside a popover/menu that renders into a Portal. Radix
        // usually keeps portaled clicks out of the card's bubbling
        // path, but tagging these selectors explicitly is cheap
        // insurance against a menu-item click registering as a card
        // click (which previously made every menu action also
        // download/open the file — hence the "card acts like it was
        // clicked after I picked a menu item" bug).
        if (
          target.closest(
            "button,a,input,[role='menu'],[role='menuitem'],[data-radix-popper-content-wrapper]"
          )
        ) {
          return;
        }
        onOpenDetails?.();
      }}
      onDoubleClick={(e) => {
        const target = e.target as HTMLElement;
        if (
          target.closest(
            "button,a,input,[role='menu'],[role='menuitem'],[data-radix-popper-content-wrapper]"
          )
        ) {
          return;
        }
        if (file.templateId) {
          window.location.href = `/templates/${file.templateId}/designer`;
        } else if (onDownload) {
          onDownload();
        }
      }}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-xl border bg-card shadow-subtle transition-all hover:-translate-y-0.5 hover:border-border hover:shadow-card",
        canOpenDetails && "cursor-pointer",
        selected && "border-primary shadow-card ring-1 ring-primary/30",
        highlighted && "border-primary/60 ring-2 ring-primary/20"
      )}
    >
      {/* Header: type badge + filename + menu */}
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <FileTypeBadge kind={kind} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-foreground">
            {file.name}
          </div>
        </div>
        {resolvedMenu.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Actions for ${file.name}`}
                className="h-7 w-7 shrink-0 opacity-60 transition-opacity group-hover:opacity-100"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {resolvedMenu.map((item, idx) => (
                <div key={`${item.label}-${idx}`}>
                  {item.separatorBefore && <DropdownMenuSeparator />}
                  {item.href ? (
                    <DropdownMenuItem asChild destructive={item.destructive}>
                      <Link href={item.href}>
                        {item.icon}
                        {item.label}
                      </Link>
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      onClick={item.onClick}
                      destructive={item.destructive}
                    >
                      {item.icon}
                      {item.label}
                    </DropdownMenuItem>
                  )}
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Preview / thumbnail, with select checkbox overlaid top-left.
          Previously the checkbox lived in the header next to the
          three-dots menu and faded in on hover — so right after a
          menu item was clicked, the dropdown closed, the mouse was
          still hovering, and the checkbox appeared *exactly where
          the menu just was*. Users read that as a confirmation
          checkmark for whichever action they'd just picked. Moving
          it to the top-left corner kills the spatial overlap; the
          `bulkSelectActive` prop makes the checkbox always visible
          whenever any file is selected (bulk-select mode). */}
      <div className="relative">
        <FileThumbnail file={file} />
        {canToggleSelect && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect?.();
            }}
            aria-label={selected ? "Deselect" : "Select"}
            aria-pressed={selected}
            className={cn(
              "absolute left-2 top-2 z-10 grid h-5 w-5 place-items-center rounded-md border bg-background/90 shadow-sm backdrop-blur transition-opacity",
              selected || bulkSelectActive
                ? "border-primary opacity-100"
                : "opacity-0 group-hover:opacity-100",
              selected && "border-primary bg-primary text-primary-foreground"
            )}
          >
            {selected ? <Check className="h-3 w-3" /> : null}
          </button>
        )}
        {onToggleStar && (
          // Top-right mirror of the select checkbox. Always visible
          // when starred (so the user can see the state at a glance);
          // fades in on hover otherwise so an unstarred grid isn't
          // noisy. Stop-propagation keeps the card's open-details
          // handler from firing on click.
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleStar();
            }}
            aria-label={file.starred ? "Unstar" : "Star"}
            aria-pressed={!!file.starred}
            title={file.starred ? "Starred — click to unstar" : "Star"}
            className={cn(
              "absolute right-2 top-2 z-10 grid h-6 w-6 place-items-center rounded-md border bg-background/90 shadow-sm backdrop-blur transition-opacity",
              file.starred
                ? "border-amber-400/40 opacity-100"
                : "border-border opacity-0 group-hover:opacity-100"
            )}
          >
            <Star
              className={cn(
                "h-3.5 w-3.5",
                file.starred
                  ? "fill-amber-400 text-amber-500"
                  : "text-muted-foreground"
              )}
            />
          </button>
        )}
      </div>

      {/* Footer: actor + activity */}
      <div className="flex items-center gap-2 border-t px-3 py-2">
        <Avatar className="h-5 w-5">
          <AvatarFallback className="text-[9px]">
            {actorInitials || "?"}
          </AvatarFallback>
        </Avatar>
        <span className="truncate text-[11px] text-muted-foreground">
          {actorLabel} · {formatActivityDate(file.createdAt)}
        </span>
        {file.templateId && (
          <Badge variant="secondary" className="ml-auto text-[9px]">
            Template
          </Badge>
        )}
        <ConvertChip file={file} />
      </div>
    </div>
  );
}

// ConvertChip: same status semantics as the FileList chip — only shown
// when the file goes through the office-doc conversion pipeline. Sized
// for the grid-card footer (text-[9px], tucked to the right with ml-auto
// when no Template badge is present).
function ConvertChip({ file }: { file: GridFile }) {
  const s = file.convertStatus;
  if (!s) return null;
  const base = "text-[9px]" + (file.templateId ? "" : " ml-auto");
  switch (s) {
    case "pending":
      return (
        <Badge variant="secondary" className={base}>
          Converting…
        </Badge>
      );
    case "failed":
      return (
        <Badge
          variant="secondary"
          className={`${base} border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300`}
        >
          Preview unavailable
        </Badge>
      );
    case "unsupported":
      return (
        <Badge variant="secondary" className={base}>
          No preview
        </Badge>
      );
    case "macro_warning":
      return (
        <Badge
          variant="secondary"
          className={`${base} border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200`}
          title={file.convertWarning ?? "Macros stripped during conversion"}
        >
          Macros stripped
        </Badge>
      );
    default:
      return null;
  }
}

/* ---------------- FileTypeBadge ---------------- */

function FileTypeBadge({
  kind,
  size = "sm",
}: {
  kind: ReturnType<typeof categorizeFile>;
  size?: "sm" | "md";
}) {
  const Icon = iconForKind(kind);
  const { bg, fg } = badgeColorsForKind(kind);
  const dim = size === "md" ? "h-8 w-8" : "h-6 w-6";
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-md shadow-subtle",
        dim,
        bg,
        fg
      )}
    >
      <Icon className={cn(size === "md" ? "h-4 w-4" : "h-3.5 w-3.5")} />
    </span>
  );
}

/* ---------------- FileThumbnail ---------------- */

function FileThumbnail({ file }: { file: GridFile }) {
  const kind = categorizeFile(file.mime, file.name);

  if (kind === "image") {
    return <ImageThumb file={file} />;
  }

  if (kind === "sheet") {
    return <SheetPreview />;
  }

  if (kind === "slides") {
    return <SlidesPreview />;
  }

  // Default: paper-style preview with colored accent + large type label
  return <PaperPreview kind={kind} />;
}

function PaperPreview({
  kind,
}: {
  kind: ReturnType<typeof categorizeFile>;
}) {
  const Icon = iconForKind(kind);
  const label = shortLabelForKind(kind);
  const fg = colorForKind(kind);
  // Subtle accent stripe color (uses the same hue as fg).
  const accent = fg.replace("text-", "bg-").replace("-500", "-500/20");

  return (
    <div className="relative flex aspect-[5/3] w-full items-center justify-center bg-gradient-to-b from-muted/20 to-muted/40 p-4">
      {/* "Paper" sheet */}
      <div className="relative flex h-full w-[70%] flex-col overflow-hidden rounded-md border bg-background shadow-subtle">
        {/* Accent header bar */}
        <div className={cn("h-2 w-full", accent)} />
        {/* Fake text lines */}
        <div className="flex-1 space-y-1.5 px-3 py-3">
          <div className="h-1.5 w-[90%] rounded-sm bg-muted" />
          <div className="h-1.5 w-[70%] rounded-sm bg-muted" />
          <div className="h-1.5 w-[85%] rounded-sm bg-muted" />
          <div className="h-1.5 w-[55%] rounded-sm bg-muted" />
          <div className="mt-2 h-1.5 w-[80%] rounded-sm bg-muted" />
          <div className="h-1.5 w-[65%] rounded-sm bg-muted" />
        </div>
        {/* Big centered icon overlay */}
        <div
          className={cn(
            "pointer-events-none absolute inset-0 grid place-items-center",
            fg
          )}
        >
          <div className="flex flex-col items-center gap-1 opacity-80">
            <Icon className="h-10 w-10" strokeWidth={1.5} />
            <span className="font-mono text-[9px] font-bold tracking-wider">
              {label}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function SheetPreview() {
  // Mimic spreadsheet grid
  return (
    <div className="relative flex aspect-[5/3] w-full items-center justify-center bg-gradient-to-b from-muted/20 to-muted/40 p-4">
      <div className="relative flex h-full w-[80%] flex-col overflow-hidden rounded-md border bg-background shadow-subtle">
        <div className="flex h-5 border-b bg-emerald-500/10">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="flex-1 border-r border-emerald-500/20 last:border-r-0"
            />
          ))}
        </div>
        <div className="flex-1">
          {Array.from({ length: 6 }).map((_, r) => (
            <div key={r} className="flex h-4 border-b last:border-b-0">
              {Array.from({ length: 6 }).map((__, c) => (
                <div
                  key={c}
                  className="flex-1 border-r last:border-r-0"
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SlidesPreview() {
  return (
    <div className="relative flex aspect-[5/3] w-full items-center justify-center bg-gradient-to-b from-muted/20 to-muted/40 p-4">
      <div className="relative h-full w-[80%] overflow-hidden rounded-md border bg-background shadow-subtle">
        <div className="h-8 border-b bg-orange-500/10" />
        <div className="space-y-2 p-3">
          <div className="h-2 w-[60%] rounded-sm bg-orange-500/30" />
          <div className="h-1.5 w-[90%] rounded-sm bg-muted" />
          <div className="h-1.5 w-[80%] rounded-sm bg-muted" />
          <div className="h-1.5 w-[70%] rounded-sm bg-muted" />
        </div>
      </div>
    </div>
  );
}

function ImageThumb({ file }: { file: GridFile }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const token = getToken();
    if (!token) {
      setFailed(true);
      return;
    }
    (async () => {
      try {
        const r = await fetch(`${API_URL}/v1/files/${file.id}/download`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) throw new Error("bad download url");
        const j = await r.json();
        if (!cancelled && j.downloadUrl) setUrl(j.downloadUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file.id]);

  if (failed) {
    return <PaperPreview kind="image" />;
  }

  return (
    <div className="relative aspect-[5/3] w-full overflow-hidden bg-gradient-to-b from-muted/20 to-muted/50">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={file.name}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="grid h-full w-full place-items-center">
          <div className="h-6 w-6 animate-pulse rounded-full bg-muted" />
        </div>
      )}
    </div>
  );
}

/* ---------------- Helpers ---------------- */

function formatActivityDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
