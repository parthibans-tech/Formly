"use client";

// Org switcher (Phase 3, multi-org).
//
// Sits in the topbar next to the avatar. Renders nothing until we
// confirm the user belongs to more than one org — for the 99% of
// users with a single workspace it stays out of the way.
//
// Switching orgs:
//   1. POST /v1/me/switch-org → server returns a fresh JWT bound to
//      the target org with the role from the membership row.
//   2. We replace the local session and reload to /drive so every
//      page refetches against the new org.

import { useEffect, useState } from "react";
import { Building2, Check, ChevronsUpDown, Snowflake } from "lucide-react";
import { api, getUser, setSession } from "@/lib/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";

type Membership = {
  orgId: string;
  orgName: string;
  role: string;
  source: string;
  isCurrent: boolean;
  isPrimary: boolean;
  frozen: boolean;
  deleted: boolean;
};

export function OrgSwitcher() {
  const toast = useToast();
  const [list, setList] = useState<Membership[] | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    api<{ memberships: Membership[] }>("/v1/me/memberships")
      .then((r) => setList(r.memberships || []))
      .catch(() => setList([]));
  }, []);

  // Hide entirely until we know — no flicker, and no widget for users
  // who only belong to one org.
  if (!list || list.length <= 1) return null;

  const current = list.find((m) => m.isCurrent) ?? list[0];

  async function pick(m: Membership) {
    if (m.isCurrent || switching) return;
    if (m.deleted) {
      toast.show("error", "That workspace has been deleted");
      return;
    }
    setSwitching(true);
    try {
      const res = await api<{
        token: string;
        orgId: string;
        role: string;
        orgKind?: string;
      }>("/v1/me/switch-org", {
        method: "POST",
        body: JSON.stringify({ orgId: m.orgId }),
      });
      const u = getUser() || {};
      // Merge orgKind alongside id+role so the sidebar's first paint
      // after the upcoming reload already knows whether to render
      // team-only nav (the alternative — a stale cached `kind` from
      // the previous workspace — flashes the Team link briefly when
      // switching from a team org into a personal one).
      setSession(res.token, {
        ...u,
        orgId: res.orgId,
        role: res.role,
        orgKind: res.orgKind ?? u.orgKind ?? "team",
      });
      // Full reload — every page caches data tied to the previous org,
      // so a soft re-render isn't enough. Send the user to /drive so
      // they land on a known-good route in the new workspace.
      window.location.href = "/drive";
    } catch (e: any) {
      toast.show("error", e?.message || "Switch failed");
      setSwitching(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2">
          <Building2 className="h-4 w-4" />
          <span className="max-w-[140px] truncate">{current.orgName}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Switch workspace
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {list.map((m) => (
          <DropdownMenuItem
            key={m.orgId}
            onClick={() => pick(m)}
            disabled={m.isCurrent || switching || m.deleted}
            className="flex items-center gap-2"
          >
            <span className="grid h-6 w-6 place-items-center rounded bg-muted text-[10px] font-semibold uppercase">
              {m.orgName.slice(0, 2)}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {m.orgName}
              <span className="ml-1 text-[10px] text-muted-foreground">
                {m.role}
              </span>
            </span>
            {m.frozen && (
              <Snowflake className="h-3.5 w-3.5 text-blue-500" />
            )}
            {m.isCurrent && <Check className="h-3.5 w-3.5 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
