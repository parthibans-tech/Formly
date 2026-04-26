"use client";

// Sticky download-progress card — fixed bottom-right of the viewport,
// drives the bulk-ZIP download UX. Toasts can't host a long-lived row
// with a Cancel button (they're fire-and-forget shadcn shims), so this
// is a purpose-built component the drive page mounts when a download
// is in flight.
//
// Lifecycle:
//   1. caller calls `start()` to declare a download (label + AbortController)
//   2. caller calls `tick(bytes)` as each chunk arrives (cumulative byte count)
//   3. caller calls `done()` on success or `fail(message)` on error/abort
//
// We deliberately don't show a percentage bar. The server streams a
// chunked ZIP with no Content-Length, so we have nothing to divide by.
// What we DO show is "labels • bytes downloaded" plus a spinner —
// enough signal that the download is alive without lying about ETA.

import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/upload";
import { cn } from "@/lib/utils";

export type DownloadProgressState = {
  /** Caller-supplied label, e.g. "3 files + 2 folders". */
  label: string;
  /** Cumulative bytes received so far. */
  bytes: number;
  /** Phase: pre-flight (server is gating files), streaming, finishing, errored. */
  phase: "preflight" | "streaming" | "done" | "error" | "cancelled";
  /** Error message when phase==="error". */
  error?: string;
};

type Props = {
  state: DownloadProgressState | null;
  /**
   * Caller's cancel handler. We don't own the AbortController — the
   * caller (drive page) does — so we just bubble the click. When null
   * the cancel button is hidden (e.g. once the download finishes).
   */
  onCancel?: () => void;
  /** Dismiss the card after a terminal phase. */
  onDismiss?: () => void;
};

export function DownloadProgressCard({ state, onCancel, onDismiss }: Props) {
  // Auto-dismiss after a successful download so the card doesn't sit
  // around forever. Errors stick around until the user closes them so
  // they have time to read the message.
  const dismissTimer = useRef<number | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!state) return;
    setHidden(false);
    if (state.phase === "done") {
      if (dismissTimer.current) window.clearTimeout(dismissTimer.current);
      dismissTimer.current = window.setTimeout(() => {
        onDismiss?.();
      }, 4000);
    }
    return () => {
      if (dismissTimer.current) window.clearTimeout(dismissTimer.current);
    };
  }, [state, onDismiss]);

  if (!state || hidden) return null;

  const isTerminal =
    state.phase === "done" ||
    state.phase === "error" ||
    state.phase === "cancelled";

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "fixed bottom-4 right-4 z-50 w-[320px] rounded-lg border bg-card p-3 shadow-lg",
        state.phase === "error" && "border-destructive/40",
        state.phase === "done" && "border-emerald-500/40"
      )}
    >
      <div className="flex items-start gap-2">
        <div className="mt-0.5">
          {state.phase === "preflight" || state.phase === "streaming" ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : state.phase === "done" ? (
            <span className="grid h-4 w-4 place-items-center rounded-full bg-emerald-500 text-[10px] font-bold text-white">
              ✓
            </span>
          ) : (
            <span className="grid h-4 w-4 place-items-center rounded-full bg-destructive text-[10px] font-bold text-destructive-foreground">
              !
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {state.phase === "preflight"
              ? "Preparing download…"
              : state.phase === "streaming"
                ? "Downloading…"
                : state.phase === "done"
                  ? "Download saved"
                  : state.phase === "cancelled"
                    ? "Download cancelled"
                    : "Download failed"}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {state.label}
            {state.bytes > 0 && (
              <>
                {" · "}
                {formatBytes(state.bytes)}
              </>
            )}
          </div>
          {state.phase === "error" && state.error && (
            <div className="mt-1 text-xs text-destructive">{state.error}</div>
          )}
        </div>
        {!isTerminal && onCancel && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Cancel download"
            className="h-6 w-6 shrink-0"
            onClick={onCancel}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
        {isTerminal && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Dismiss"
            className="h-6 w-6 shrink-0"
            onClick={() => {
              setHidden(true);
              onDismiss?.();
            }}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
