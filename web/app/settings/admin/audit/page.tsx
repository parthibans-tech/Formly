"use client";

// Legacy URL — the audit module was unified at /settings/audit. Bookmarks
// to the old super-admin-only path still work via this redirect.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LegacyPlatformAuditPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/settings/audit");
  }, [router]);
  return null;
}
