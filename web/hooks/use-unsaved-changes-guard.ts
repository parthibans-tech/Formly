"use client";

// useUnsavedChangesGuard — warns the user before they lose unsaved work.
//
// Covers two navigation paths:
//   1. Tab/window close, reload, or typing a URL into the address bar:
//      handled by the `beforeunload` event. Browsers render their own
//      generic dialog (the `returnValue` string is ignored in modern
//      browsers but still required to trigger the prompt).
//   2. In-app navigation via Next.js's App Router: App Router has no
//      built-in navigation intercept (`router.events` is Pages Router
//      only), so we expose a `confirmNavigate(cb)` helper that call
//      sites can wrap around any programmatic navigation or Link click.
//
// The hook is a no-op while `dirty` is false so there's no cost when
// the page is clean.

import { useCallback, useEffect, useRef } from "react";

export type UnsavedChangesGuard = {
  /**
   * Wrap any navigation callback (e.g. router.push, a Link onClick) so it
   * prompts the user when dirty is true. Returns true if the navigation
   * should proceed.
   */
  confirmNavigate: (onConfirm: () => void) => boolean;
};

export function useUnsavedChangesGuard(
  dirty: boolean,
  message = "You have unsaved changes. Are you sure you want to leave?"
): UnsavedChangesGuard {
  // Keep a live ref so the beforeunload handler (bound once) always sees
  // the latest dirty flag without needing to re-subscribe on every
  // render.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const messageRef = useRef(message);
  messageRef.current = message;

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!dirtyRef.current) return;
      e.preventDefault();
      // Some browsers still show the legacy custom message; most render
      // their own generic copy regardless.
      e.returnValue = messageRef.current;
      return messageRef.current;
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const confirmNavigate = useCallback(
    (onConfirm: () => void) => {
      if (!dirtyRef.current) {
        onConfirm();
        return true;
      }
      // `window.confirm` is synchronous and returns a boolean — matches
      // the browser's own beforeunload UX closely enough that users
      // don't get whiplash between the two prompt styles.
      if (typeof window !== "undefined" && window.confirm(messageRef.current)) {
        onConfirm();
        return true;
      }
      return false;
    },
    []
  );

  return { confirmNavigate };
}
