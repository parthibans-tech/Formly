"use client";

// Super-admin (platform operator) console layout.
//
// This route lives at /admin/* — deliberately NOT under /settings, because
// these surfaces are not "settings of my org": they're the cross-tenant
// platform-operator console (manage every workspace, every user, billing
// across all customers, platform observability).
//
// The actual access gate is server-side: every /v1/admin/* endpoint sits
// behind requireSuperAdmin (users.is_super_admin). This layout is purely
// chrome — same AppShell sidebar/header as the rest of the app, so an
// operator can flip back into their own /drive without losing context.

import { AppShell } from "@/components/app-shell";

export default function AdminLayout({
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
