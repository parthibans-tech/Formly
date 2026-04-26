"use client";

// useAIConfig — single source of truth for whether AI features should
// render. Mirrors the backend's `/v1/ai/config` response so the UI
// can't drift from server capability.
//
// Two contracts to keep in mind:
//
//  1. **Off by default.** When the operator hasn't enabled AI, the
//     backend returns `enabled:false` and this hook resolves to a
//     state where every feature flag is false. Components that wrap
//     buttons in <AIFeature> render nothing.
//
//  2. **Single fetch per page-load.** We cache the response in module
//     scope (one promise across the whole React tree) so a page that
//     mounts five `<AIFeature>` gates makes one HTTP call, not five.
//     Cache busts on logout because `clearSession()` reloads the page.
//
// The shape mirrors `internal/ai/handler.go` exactly. If you change
// the backend's response, change this type or the hook will silently
// hand the UI stale flag names.

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export type AICapabilities = {
  chat: boolean;
  embed: boolean;
  vision: boolean;
};

export type AIFeatureFlags = {
  smartSearch: boolean;
  autoTag: boolean;
  templatePrefill: boolean;
  summarize: boolean;
  piiScan: boolean;
  transcribe: boolean;
};

export type AIConfig = {
  enabled: boolean;
  provider: string;
  capabilities: AICapabilities;
  features: AIFeatureFlags;
};

// Off-state default. Used while the fetch is in flight and as a
// fallback when the request fails (we'd rather hide AI features than
// render broken buttons). Spread by the hook so a consumer can rely
// on every key being present from first paint.
export const AI_DEFAULT_OFF: AIConfig = {
  enabled: false,
  provider: "disabled",
  capabilities: { chat: false, embed: false, vision: false },
  features: {
    smartSearch: false,
    autoTag: false,
    templatePrefill: false,
    summarize: false,
    piiScan: false,
    transcribe: false,
  },
};

// Module-level cache: one in-flight promise across the React tree.
// `null` means "haven't fetched yet". A rejected promise resolves to
// AI_DEFAULT_OFF (handled inside the hook) so a backend hiccup doesn't
// flash the UI on then off.
let cached: Promise<AIConfig> | null = null;

function fetchConfig(): Promise<AIConfig> {
  if (cached) return cached;
  cached = api<AIConfig>("/v1/ai/config")
    .catch(() => AI_DEFAULT_OFF)
    .then((c) => c ?? AI_DEFAULT_OFF);
  return cached;
}

/**
 * Resolves the active AI configuration. Returns `AI_DEFAULT_OFF`
 * during the initial fetch so consumers can render the off-state
 * markup immediately without checking a `loading` flag — AI features
 * stay hidden until the real config comes back, which is the
 * desired UX.
 */
export function useAIConfig(): AIConfig {
  const [cfg, setCfg] = useState<AIConfig>(AI_DEFAULT_OFF);
  useEffect(() => {
    let cancelled = false;
    fetchConfig().then((c) => {
      if (!cancelled) setCfg(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return cfg;
}

/**
 * Refresh the cached config — call after admin actions that flip AI
 * state at runtime (e.g. a future Settings → AI page that updates
 * env config). Currently unused; exported so a future caller doesn't
 * have to monkey-patch the cache from outside.
 */
export function refreshAIConfig(): Promise<AIConfig> {
  cached = null;
  return fetchConfig();
}
