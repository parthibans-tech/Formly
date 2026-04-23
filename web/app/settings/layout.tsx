"use client";

import { AppShell } from "@/components/app-shell";

// Settings pages share the unified AppShell (same sidebar + header as the
// rest of the app). Each child supplies its own title + cards; nav lives in
// the sidebar now instead of a per-section second rail.
export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AppShell>
      <div className="space-y-6">{children}</div>
    </AppShell>
  );
}
