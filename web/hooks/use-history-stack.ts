"use client";

// useHistoryStack — generic undo/redo stack over a single stateful
// value. Designed for the AcroForm mapping editor (where the state is
// the `{mappings, crossValidations}` tuple) but it's value-agnostic.
//
// Behavior
// --------
// • Snapshots are taken on a trailing debounce so rapid edits
//   (typing a data key character-by-character) coalesce into one
//   undoable step instead of 20. The debounce window is `debounceMs`.
// • `commit()` forces an immediate snapshot — callers use it on
//   discrete actions (auto-map, bulk rename) where coalescing would be
//   wrong.
// • Calling the returned `undo()` / `redo()` fires `onRestore` with the
//   target snapshot; the caller is responsible for writing it back to
//   state. We don't set state directly so the hook stays decoupled
//   from whatever `useState`/reducer setup the consumer has.
// • The internal `replayingRef` suppresses the snapshot that would
//   otherwise be taken when the consumer applies the restored value,
//   so undo followed by another edit doesn't double-push.
//
// Limits
// ------
// `maxDepth` caps the past stack. Old entries fall off the bottom so
// a long editing session can't leak memory.

import { useCallback, useEffect, useRef } from "react";

export type HistoryStack<T> = {
  undo: () => void;
  redo: () => void;
  commit: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  /**
   * Notifies the hook that the consumer is about to apply a value it
   * received from onRestore. Used to suppress the subsequent snapshot
   * that the debounce would otherwise take.
   */
  markReplay: () => void;
};

type Options<T> = {
  debounceMs?: number;
  maxDepth?: number;
  /** Equality check — if the new value equals the last snapshot, skip. */
  equals?: (a: T, b: T) => boolean;
  /** Called with the snapshot to restore. Consumer applies it. */
  onRestore: (snapshot: T) => void;
};

export function useHistoryStack<T>(
  value: T,
  { debounceMs = 500, maxDepth = 50, equals, onRestore }: Options<T>
): HistoryStack<T> {
  const pastRef = useRef<T[]>([]);
  const futureRef = useRef<T[]>([]);
  const lastSnapshotRef = useRef<T>(value);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const replayingRef = useRef(false);

  const eq = useCallback(
    (a: T, b: T) => (equals ? equals(a, b) : Object.is(a, b)),
    [equals]
  );

  const pushSnapshot = useCallback(
    (prev: T) => {
      if (eq(prev, lastSnapshotRef.current)) return;
      pastRef.current.push(lastSnapshotRef.current);
      if (pastRef.current.length > maxDepth) pastRef.current.shift();
      lastSnapshotRef.current = prev;
      // New edit invalidates the redo stack, same as every undo UI.
      futureRef.current = [];
    },
    [eq, maxDepth]
  );

  // Debounced snapshot on every value change. The value we push is the
  // PREVIOUS snapshot — i.e. undo takes the user back to what the state
  // looked like before they started this burst of edits.
  useEffect(() => {
    if (replayingRef.current) {
      // Consumer is applying a restored value; don't treat it as a new
      // edit. Reset the marker and sync lastSnapshot without pushing.
      replayingRef.current = false;
      lastSnapshotRef.current = value;
      return;
    }
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    const prev = lastSnapshotRef.current;
    pendingTimerRef.current = setTimeout(() => {
      pushSnapshot(prev);
      lastSnapshotRef.current = value;
    }, debounceMs);
    return () => {
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    };
  }, [value, debounceMs, pushSnapshot]);

  const commit = useCallback(() => {
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    pushSnapshot(lastSnapshotRef.current);
    lastSnapshotRef.current = value;
  }, [pushSnapshot, value]);

  const undo = useCallback(() => {
    // Flush any pending debounced snapshot first — otherwise a mid-burst
    // undo would skip the user's most recent burst.
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
      pushSnapshot(lastSnapshotRef.current);
    }
    const snap = pastRef.current.pop();
    if (snap === undefined) return;
    futureRef.current.push(lastSnapshotRef.current);
    lastSnapshotRef.current = snap;
    replayingRef.current = true;
    onRestore(snap);
  }, [pushSnapshot, onRestore]);

  const redo = useCallback(() => {
    const snap = futureRef.current.pop();
    if (snap === undefined) return;
    pastRef.current.push(lastSnapshotRef.current);
    lastSnapshotRef.current = snap;
    replayingRef.current = true;
    onRestore(snap);
  }, [onRestore]);

  const canUndo = useCallback(() => pastRef.current.length > 0, []);
  const canRedo = useCallback(() => futureRef.current.length > 0, []);
  const markReplay = useCallback(() => {
    replayingRef.current = true;
  }, []);

  return { undo, redo, commit, canUndo, canRedo, markReplay };
}
