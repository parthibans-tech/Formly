"use client";

// useAcroformFixtures — persisted, multi-fixture sample-data registry for
// one AcroForm template.
//
// Why a registry instead of a single blob
// ---------------------------------------
// The designer originally stored sample data as a single JSON blob under
// `acroform-sample-<tplId>`. Users who wanted to test multiple scenarios
// (happy path, edge case, empty state) had to hand-edit the JSON each
// time. A fixture registry lets them save each scenario by name and
// switch between them with one click.
//
// Storage shape
// -------------
// `acroform-fixtures-<tplId>` → {
//   activeId: string | null,
//   fixtures: Array<{ id: string, name: string, data: Record<string, any> }>,
// }
//
// On first mount we migrate any legacy `acroform-sample-<tplId>` blob
// into a single fixture named "Default" so existing users don't lose
// their sample data. The legacy key is then deleted.

import { useCallback, useEffect, useRef, useState } from "react";

export type Fixture = {
  id: string;
  name: string;
  data: Record<string, any>;
};

export type FixturesState = {
  activeId: string | null;
  fixtures: Fixture[];
};

export type UseFixtures = {
  fixtures: Fixture[];
  activeId: string | null;
  active: Fixture | null;
  data: Record<string, any>;
  setData: (next: Record<string, any>) => void;
  setActive: (id: string) => void;
  create: (name: string, data?: Record<string, any>) => string;
  rename: (id: string, name: string) => void;
  duplicate: (id: string, nameOverride?: string) => string | null;
  remove: (id: string) => void;
  importOne: (name: string, data: Record<string, any>) => string;
};

function storageKey(tplId: string) {
  return `acroform-fixtures-${tplId}`;
}

function legacyKey(tplId: string) {
  return `acroform-sample-${tplId}`;
}

function makeId(): string {
  // Short, collision-safe enough for per-template lists.
  return "fx_" + Math.random().toString(36).slice(2, 10);
}

function uniqueName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}

export function useAcroformFixtures(tplId: string): UseFixtures {
  const [state, setState] = useState<FixturesState>({
    activeId: null,
    fixtures: [],
  });
  // Gate the write-through effect so the initial hydration read doesn't
  // immediately re-write what it just loaded.
  const hydratedRef = useRef(false);

  // Hydrate once per template. Runs the legacy migration in the same
  // tick so the transition is invisible to callers.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey(tplId));
      if (raw) {
        const parsed = JSON.parse(raw) as FixturesState;
        if (parsed && Array.isArray(parsed.fixtures)) {
          setState({
            activeId: parsed.activeId ?? parsed.fixtures[0]?.id ?? null,
            fixtures: parsed.fixtures,
          });
          hydratedRef.current = true;
          return;
        }
      }
      // Migration: old single-blob path.
      const legacy = localStorage.getItem(legacyKey(tplId));
      if (legacy) {
        try {
          const data = JSON.parse(legacy);
          if (data && typeof data === "object") {
            const fx: Fixture = {
              id: makeId(),
              name: "Default",
              data,
            };
            setState({ activeId: fx.id, fixtures: [fx] });
            localStorage.removeItem(legacyKey(tplId));
          }
        } catch {
          // corrupt legacy blob — drop it.
          localStorage.removeItem(legacyKey(tplId));
        }
      }
    } catch {
      // localStorage may be unavailable (SSR, disabled). Start empty.
    }
    hydratedRef.current = true;
  }, [tplId]);

  // Persist on every change. `hydratedRef` keeps us from overwriting
  // the load-time value with an empty state before hydration finishes.
  useEffect(() => {
    if (!hydratedRef.current) return;
    try {
      localStorage.setItem(storageKey(tplId), JSON.stringify(state));
    } catch {
      // Quota or disabled — non-fatal.
    }
  }, [state, tplId]);

  const active = state.fixtures.find((f) => f.id === state.activeId) ?? null;
  const data = active?.data ?? {};

  const setData = useCallback((next: Record<string, any>) => {
    setState((prev) => {
      if (!prev.activeId) {
        // No active fixture — implicitly create a "Default" one so the
        // existing editor UI (which just mutates sampleData) continues
        // to work without requiring the user to name anything upfront.
        const fx: Fixture = { id: makeId(), name: "Default", data: next };
        return { activeId: fx.id, fixtures: [fx] };
      }
      return {
        ...prev,
        fixtures: prev.fixtures.map((f) =>
          f.id === prev.activeId ? { ...f, data: next } : f
        ),
      };
    });
  }, []);

  const setActive = useCallback((id: string) => {
    setState((prev) => ({ ...prev, activeId: id }));
  }, []);

  const create = useCallback(
    (name: string, data: Record<string, any> = {}) => {
      const id = makeId();
      setState((prev) => {
        const names = prev.fixtures.map((f) => f.name);
        const fx: Fixture = {
          id,
          name: uniqueName(name.trim() || "Untitled", names),
          data,
        };
        return { activeId: id, fixtures: [...prev.fixtures, fx] };
      });
      return id;
    },
    []
  );

  const rename = useCallback((id: string, name: string) => {
    setState((prev) => {
      const others = prev.fixtures.filter((f) => f.id !== id).map((f) => f.name);
      return {
        ...prev,
        fixtures: prev.fixtures.map((f) =>
          f.id === id
            ? { ...f, name: uniqueName(name.trim() || f.name, others) }
            : f
        ),
      };
    });
  }, []);

  const duplicate = useCallback(
    (id: string, nameOverride?: string) => {
      let newId: string | null = null;
      setState((prev) => {
        const src = prev.fixtures.find((f) => f.id === id);
        if (!src) return prev;
        const names = prev.fixtures.map((f) => f.name);
        newId = makeId();
        const fx: Fixture = {
          id: newId,
          name: uniqueName(nameOverride ?? `${src.name} copy`, names),
          data: JSON.parse(JSON.stringify(src.data)),
        };
        return { activeId: fx.id, fixtures: [...prev.fixtures, fx] };
      });
      return newId;
    },
    []
  );

  const remove = useCallback((id: string) => {
    setState((prev) => {
      const fixtures = prev.fixtures.filter((f) => f.id !== id);
      const activeId =
        prev.activeId === id ? fixtures[0]?.id ?? null : prev.activeId;
      return { activeId, fixtures };
    });
  }, []);

  const importOne = useCallback(
    (name: string, data: Record<string, any>) => create(name, data),
    [create]
  );

  return {
    fixtures: state.fixtures,
    activeId: state.activeId,
    active,
    data,
    setData,
    setActive,
    create,
    rename,
    duplicate,
    remove,
    importOne,
  };
}
