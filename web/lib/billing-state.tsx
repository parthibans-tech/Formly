"use client";

// Org-scoped billing state, loaded once per app shell mount and shared
// via context. The shell uses this to decide whether to render the
// normal nav or the full-screen paywall; child pages can refresh after
// a successful checkout to drop the gate without a page reload.
//
// Backend contract (GET /v1/billing/subscription):
//   - Has active sub  → full Subscription object (id, status, planId, …)
//   - Trial expired or no sub → { status: "none", requiresUpgrade: true,
//                                 trialUsed: boolean, hint: string }
//
// We treat anything without an `id` as "no active sub". `requiresUpgrade`
// from the backend is the source of truth — when true the paywall takes
// over the whole shell.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, getToken } from "@/lib/api";

export type BillingStateValue = {
  /** True while the very first fetch is in flight. */
  loading: boolean;
  /** True when the org has no active paid sub and must pick a plan. */
  requiresUpgrade: boolean;
  /** True when the one-time trial slot has already been used. */
  trialUsed: boolean;
  /** Convenience: did the API return a real subscription row? */
  hasActiveSub: boolean;
  /** Human hint surfaced from the API (paywall page CTA copy). */
  hint?: string;
  /** The full subscription blob when one exists. Pages may inspect this. */
  subscription: any | null;
  /** Re-fetch after checkout success / cancel / plan change. */
  refresh: () => Promise<void>;
};

const DEFAULT: BillingStateValue = {
  loading: true,
  requiresUpgrade: false,
  trialUsed: false,
  hasActiveSub: false,
  hint: undefined,
  subscription: null,
  refresh: async () => {},
};

const Ctx = createContext<BillingStateValue>(DEFAULT);

export function BillingStateProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [state, setState] = useState<BillingStateValue>(DEFAULT);
  // Avoid stale `setState` from concurrent refreshes overwriting newer
  // values (rapid checkout-success → refresh chain).
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const my = ++seq.current;
    // Bail when there's no token — we don't want to ping the API on
    // public/login pages just because someone embedded the provider.
    if (!getToken()) {
      if (my === seq.current) {
        setState({ ...DEFAULT, loading: false, refresh });
      }
      return;
    }
    try {
      const sub = await api<any>("/v1/billing/subscription");
      if (my !== seq.current) return;
      const hasActiveSub = !!sub?.id;
      const requiresUpgrade = !hasActiveSub && !!sub?.requiresUpgrade;
      setState({
        loading: false,
        hasActiveSub,
        requiresUpgrade,
        trialUsed: !!sub?.trialUsed || hasActiveSub,
        hint: sub?.hint,
        subscription: hasActiveSub ? sub : null,
        refresh,
      });
    } catch {
      if (my !== seq.current) return;
      // On infra errors don't engage the paywall — same defensive
      // policy as the server-side helpers (fall open on hiccups).
      setState({
        loading: false,
        requiresUpgrade: false,
        trialUsed: false,
        hasActiveSub: false,
        hint: undefined,
        subscription: null,
        refresh,
      });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo<BillingStateValue>(
    () => ({ ...state, refresh }),
    [state, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBillingState(): BillingStateValue {
  return useContext(Ctx);
}
