"use client";

import { useCallback, useEffect, useState } from "react";

export type ViewMode = "list" | "grid";

const STORAGE_KEY = "formly.viewMode";

function readStored(): ViewMode {
  if (typeof window === "undefined") return "grid";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "list" || v === "grid" ? v : "grid";
  } catch {
    return "grid";
  }
}

/**
 * Grid-default view-mode preference that persists across pages and sessions
 * via localStorage. Listens to `storage` events so a change in one tab
 * propagates to other open tabs (and to sibling hook instances on the same
 * page).
 */
export function useViewMode(): [ViewMode, (v: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>("grid");

  useEffect(() => {
    setMode(readStored());
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY && (e.newValue === "list" || e.newValue === "grid")) {
        setMode(e.newValue);
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const update = useCallback((v: ViewMode) => {
    setMode(v);
    try {
      window.localStorage.setItem(STORAGE_KEY, v);
      // Manually notify other hook instances on the same page (storage events
      // don't fire in the tab that made the change).
      window.dispatchEvent(
        new StorageEvent("storage", { key: STORAGE_KEY, newValue: v })
      );
    } catch {
      /* ignore */
    }
  }, []);

  return [mode, update];
}
