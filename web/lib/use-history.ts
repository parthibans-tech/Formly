"use client";

// useHistory — a generic undo/redo container for any serialisable state.
// The designer replaces `useState(widgets)` with `useHistory(widgets)` and
// gets Cmd+Z / Cmd+Shift+Z for free. Kept small and untyped at runtime; the
// caller owns the shape.
//
// Design notes:
//   • `commit(next, opts)` pushes a new state onto the undo stack. Call with
//     `{ coalesce: true }` while dragging so a single drag doesn't create
//     dozens of history entries — the last coalesced entry is overwritten
//     until a non-coalesced commit arrives.
//   • Redo stack is cleared on every fresh commit (not on coalesced ones),
//     matching what every editor in the universe does.
//   • `replace(next)` sets state without pushing — useful when you just
//     loaded fresh data from the server.
//   • Capped at 100 entries to bound memory for long-running sessions.

import { useCallback, useRef, useState } from "react";

type CommitOpts = { coalesce?: boolean };

const CAP = 100;

export function useHistory<T>(initial: T) {
  const [state, setState] = useState<T>(initial);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  // Tracks whether the last commit was a coalesced one so we know to
  // overwrite it instead of pushing a new entry.
  const lastWasCoalesced = useRef(false);
  // Bump whenever stacks change so React re-renders consumers that read
  // `canUndo` / `canRedo` via the returned object.
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const commit = useCallback(
    (next: T | ((cur: T) => T), opts?: CommitOpts) => {
      setState((cur) => {
        const resolved =
          typeof next === "function" ? (next as (c: T) => T)(cur) : next;
        if (resolved === cur) return cur;

        if (opts?.coalesce && lastWasCoalesced.current && past.current.length > 0) {
          // Overwrite the last coalesced entry — the user is mid-drag, a
          // single history step should cover the whole motion.
          // Don't push a new entry; the top of `past` is already the state
          // before the coalesced sequence started.
        } else {
          past.current.push(cur);
          if (past.current.length > CAP) past.current.shift();
          future.current = [];
        }
        lastWasCoalesced.current = !!opts?.coalesce;
        bump();
        return resolved;
      });
    },
    [bump]
  );

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (prev === undefined) return;
    setState((cur) => {
      future.current.push(cur);
      if (future.current.length > CAP) future.current.shift();
      lastWasCoalesced.current = false;
      bump();
      return prev;
    });
  }, [bump]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (next === undefined) return;
    setState((cur) => {
      past.current.push(cur);
      if (past.current.length > CAP) past.current.shift();
      lastWasCoalesced.current = false;
      bump();
      return next;
    });
  }, [bump]);

  const replace = useCallback(
    (next: T) => {
      past.current = [];
      future.current = [];
      lastWasCoalesced.current = false;
      setState(next);
      bump();
    },
    [bump]
  );

  // Finalise ends a coalesce sequence — the next commit will start a fresh
  // history entry even if the caller forgets to drop the `coalesce: true`.
  const finalise = useCallback(() => {
    lastWasCoalesced.current = false;
  }, []);

  return {
    state,
    commit,
    undo,
    redo,
    replace,
    finalise,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}
