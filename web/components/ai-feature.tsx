"use client";

// <AIFeature> — wrap any AI-powered UI element so it only renders
// when (a) AI is globally enabled and (b) the specific feature flag
// is on. The pattern beats inline `{aiCfg.enabled && ...}` checks
// because:
//
//  - it handles the loading state (returns null until the config
//    fetch resolves, so the AI button never flashes-then-disappears),
//  - it lets us add a "Powered by Claude" / provider label later in
//    one place,
//  - it forces every AI affordance through one gate, so flipping
//    AI off truly hides everything.
//
// Usage:
//
//   <AIFeature feature="summarize">
//     <Button onClick={summarize}>Summarize with AI</Button>
//   </AIFeature>
//
// Or render-prop style if you need the config object:
//
//   <AIFeature feature="smartSearch">
//     {(cfg) => <SearchTab provider={cfg.provider} />}
//   </AIFeature>

import { ReactNode } from "react";
import { useAIConfig, type AIConfig, type AIFeatureFlags } from "@/hooks/use-ai-config";

type AIFeatureProps = {
  /**
   * The feature flag to gate on. Maps 1:1 to keys on the backend's
   * FeatureFlags struct. Omitting it gates only on the master
   * `enabled` flag — useful for "AI section header" wrappers.
   */
  feature?: keyof AIFeatureFlags;
  /**
   * Optional fallback content rendered when the gate is closed.
   * Defaults to nothing — AI features should silently disappear when
   * disabled, not show "AI is off" placeholders.
   */
  fallback?: ReactNode;
  children: ReactNode | ((cfg: AIConfig) => ReactNode);
};

export function AIFeature({ feature, fallback = null, children }: AIFeatureProps) {
  const cfg = useAIConfig();
  const open = cfg.enabled && (feature ? cfg.features[feature] : true);
  if (!open) return <>{fallback}</>;
  if (typeof children === "function") return <>{children(cfg)}</>;
  return <>{children}</>;
}

/**
 * Hook-style alternative for branching that doesn't fit cleanly into
 * a wrapper — e.g. building a menu items array conditionally:
 *
 *   const menu = [
 *     ...(useIsAIFeatureOn("summarize") ? [{ label: "Summarize", ...}] : []),
 *     ...
 *   ];
 */
export function useIsAIFeatureOn(feature?: keyof AIFeatureFlags): boolean {
  const cfg = useAIConfig();
  return cfg.enabled && (feature ? cfg.features[feature] : true);
}
