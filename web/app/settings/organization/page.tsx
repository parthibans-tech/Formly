"use client";

// Organization settings — admin-only page that consolidates everything
// "about the workspace" in one screen: identity (name + ID), current
// subscription with full lifecycle controls (cancel / reactivate /
// portal / banners), invoice history, and the billing details printed
// on every invoice. /settings/billing is now just the "pick / switch
// plan" catalog — once an admin has chosen a plan, they manage
// everything else from this page.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Building2,
  Calendar,
  Copy,
  CreditCard,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Inbox,
  Loader2,
  Pencil,
  Receipt,
  RefreshCcw,
  RotateCcw,
  ShieldAlert,
  Timer,
  Trash2,
  Upload,
  Users as UsersIcon,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/toast";
import { api, getUser } from "@/lib/api";
import { useBillingState } from "@/lib/billing-state";

// We reuse /v1/me/profile here rather than introducing a new
// /v1/orgs/me endpoint — the profile blob already carries every field
// we need (orgId, orgName, role, membershipCount) and is cached by the
// browser anyway because /settings/account hits it on mount too.
type Profile = {
  id: string;
  email: string;
  name: string;
  role: string;
  isSuperAdmin: boolean;
  orgId: string;
  orgName: string;
  // "team" or "personal". Drives copy + which surfaces render —
  // personal workspaces hide the "Manage team" CTA, the
  // "members linked" line, and re-titles the page so the user
  // sees "Personal workspace" instead of "Organization".
  orgKind?: "team" | "personal";
  // Presigned GET URL minted by /v1/me/profile when a logo is on file.
  // Empty/undefined when the workspace has not uploaded one yet — the
  // header falls back to the wordmark.
  orgLogoUrl?: string;
  createdAt: string;
  membershipCount: number;
};

// Two response shapes from /v1/billing/subscription:
//   - active sub  → full row with `id`
//   - no active   → stub `{status, requiresUpgrade, trialUsed, hint}`
type Subscription = {
  id?: string;
  status: string;
  provider?: string;
  planId?: string;
  planName?: string;
  tier?: string;
  currency?: string;
  interval?: string;
  amountCents?: number | null;
  trialEndsAt?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: string | null;
  pastDueSince?: string | null;
  couponCode?: string | null;
  updatedAt?: string;
  requiresUpgrade?: boolean;
  trialUsed?: boolean;
  hint?: string;
};

type Invoice = {
  id: string;
  number: string;
  status: string;
  provider: string;
  currency: string;
  totalCents: number;
  issuedAt: string;
  paidAt?: string | null;
  hostedUrl?: string | null;
  pdfUrl?: string | null;
};

const CURRENCY_SYMBOL: Record<string, string> = { INR: "₹", USD: "$" };

function formatMoney(cents: number | null | undefined, currency: string) {
  if (cents == null) return "—";
  const major = cents / 100;
  const sym = CURRENCY_SYMBOL[currency] || "";
  return `${sym}${major.toLocaleString(undefined, {
    minimumFractionDigits: major % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function daysUntil(iso?: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

export default function OrganizationSettings() {
  const toast = useToast();
  const router = useRouter();
  const search = useSearchParams();
  // Shared billing state — refresh() lifts the AppShell paywall once a
  // cancel/reactivate / new sub takes effect.
  const billing = useBillingState();

  const [data, setData] = useState<Profile | null>(null);
  const [sub, setSub] = useState<Subscription | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [reactivateBusy, setReactivateBusy] = useState(false);
  const [portalBusy, setPortalBusy] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const logoInputRef = useRef<HTMLInputElement | null>(null);

  const cachedUser = typeof window !== "undefined" ? getUser() : null;
  const isAdmin = cachedUser?.role === "admin";
  // Personal-workspace gate. Source of truth is the loaded profile
  // (server-authoritative) once it lands, with the cached user blob as
  // fallback for the first paint so we don't briefly flash the team
  // copy on a personal workspace. Default "team" keeps every existing
  // org rendering exactly as before.
  const isPersonal =
    (data?.orgKind ?? cachedUser?.orgKind) === "personal";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, s, inv] = await Promise.all([
        api<Profile>("/v1/me/profile"),
        api<Subscription>("/v1/billing/subscription").catch(() => null),
        api<{ invoices: Invoice[] }>("/v1/billing/invoices").catch(() => ({
          invoices: [],
        })),
      ]);
      setData(p);
      setSub(s);
      setInvoices(inv.invoices || []);
    } catch (e: any) {
      toast.show("error", "Couldn't load organization", {
        description: e?.message,
      });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Surface ?status=success|cancel — providers redirect back to
  // /settings/billing after checkout, but if a deep link or a portal
  // redirect lands here we still want to react gracefully and keep the
  // sub/invoice list in sync.
  useEffect(() => {
    const status = search.get("status");
    if (status === "success") {
      toast.show("success", "Payment received", {
        description: "Your subscription is being activated.",
      });
      void load();
      void billing.refresh();
      router.replace("/settings/organization");
    } else if (status === "cancel") {
      toast.show("info", "Checkout canceled", {
        description: "No charge was made.",
      });
      router.replace("/settings/organization");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      toast.show("success", `${label} copied`);
    });
  };

  const reactivate = async () => {
    setReactivateBusy(true);
    try {
      await api("/v1/billing/reactivate", { method: "POST" });
      toast.show("success", "Subscription reactivated");
      await load();
      void billing.refresh();
    } catch (e: any) {
      toast.show("error", "Couldn't reactivate", { description: e?.message });
    } finally {
      setReactivateBusy(false);
    }
  };

  const openPortal = async () => {
    setPortalBusy(true);
    try {
      const returnURL = `${window.location.origin}/settings/organization`;
      const res = await api<{ url: string }>(
        `/v1/billing/portal?returnUrl=${encodeURIComponent(returnURL)}`,
        { method: "POST" }
      );
      if (res.url) window.location.href = res.url;
    } catch (e: any) {
      toast.show("error", "Couldn't open billing portal", {
        description: e?.message,
      });
      setPortalBusy(false);
    }
  };

  const cancelSub = async (atPeriodEnd: boolean) => {
    if (
      !confirm(
        atPeriodEnd
          ? "Cancel at the end of the current billing period?"
          : "Cancel immediately? This may end access right away."
      )
    ) {
      return;
    }
    setCancelBusy(true);
    try {
      await api("/v1/billing/cancel", {
        method: "POST",
        body: JSON.stringify({ atPeriodEnd }),
      });
      toast.show("success", "Subscription canceled");
      await load();
      void billing.refresh();
    } catch (e: any) {
      toast.show("error", "Cancel failed", { description: e?.message });
    } finally {
      setCancelBusy(false);
    }
  };

  // Logo upload: small (<= 512 KB) PNG/JPEG/WebP/GIF. Validation also
  // happens server-side, but a fast client check saves a network round
  // trip for the obvious cases.
  const MAX_LOGO_BYTES = 512 * 1024;
  const ALLOWED_LOGO_MIMES = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
  ]);

  const onPickLogo = () => logoInputRef.current?.click();

  const onLogoSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so re-selecting the same file still fires onChange.
    e.target.value = "";
    if (!file) return;
    if (!ALLOWED_LOGO_MIMES.has(file.type)) {
      toast.show("error", "Unsupported image", {
        description: "Use a PNG, JPEG, WebP, or GIF logo.",
      });
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.show("error", "Logo too large", {
        description: "Logos must be 512 KB or smaller.",
      });
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    setLogoBusy(true);
    try {
      const res = await api<{ logoUrl: string }>("/v1/orgs/me/logo", {
        method: "POST",
        body: fd,
      });
      // Optimistic local update — also reload to pick up any other
      // server-side mutations and to confirm the URL round-trips.
      setData((d) => (d ? { ...d, orgLogoUrl: res.logoUrl } : d));
      toast.show("success", "Logo updated");
      // Tell the app shell to re-read the profile so the header repaints
      // immediately. We dispatch a custom event the shell listens for.
      window.dispatchEvent(new Event("org-logo-updated"));
      void load();
    } catch (err: any) {
      toast.show("error", "Upload failed", { description: err?.message });
    } finally {
      setLogoBusy(false);
    }
  };

  const onLogoRemove = async () => {
    if (!confirm("Remove the workspace logo?")) return;
    setLogoBusy(true);
    try {
      await api("/v1/orgs/me/logo", { method: "DELETE" });
      setData((d) => (d ? { ...d, orgLogoUrl: undefined } : d));
      toast.show("success", "Logo removed");
      window.dispatchEvent(new Event("org-logo-updated"));
      void load();
    } catch (err: any) {
      toast.show("error", "Remove failed", { description: err?.message });
    } finally {
      setLogoBusy(false);
    }
  };

  // Members below admin role get a read-only view: they can see who
  // they belong to but the plan / invoice / billing-details surfaces
  // only make sense for an admin.
  if (!isAdmin) {
    return (
      <>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Building2 className="h-6 w-6" />
            {isPersonal ? "Personal workspace" : "Organization"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isPersonal
              ? "Your personal workspace and billing details."
              : "Workspace identity and billing details."}
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldAlert className="h-4 w-4 text-amber-600" />
              Admin only
            </CardTitle>
            <CardDescription>
              Organization details, plan management, invoices, and the
              billing information printed on invoices are managed by
              workspace admins. Ask your admin if you need a change here.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <DetailRow
              label="Organization"
              value={data ? data.orgName || "—" : undefined}
            />
            <DetailRow
              label="Your role"
              value={
                data ? (
                  <Badge variant="outline" className="capitalize">
                    {data.role || "—"}
                  </Badge>
                ) : undefined
              }
            />
          </CardContent>
        </Card>
      </>
    );
  }

  const trialDays =
    sub?.id && sub.status === "trialing" ? daysUntil(sub.trialEndsAt) : null;

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Building2 className="h-6 w-6" />
            {isPersonal ? "Personal workspace" : "Organization"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isPersonal
              ? "Your personal workspace, current plan, invoice history, and the billing details printed on every invoice."
              : "Workspace identity, current plan, invoice history, and the billing details printed on every invoice."}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          onClick={() => {
            load();
            billing.refresh();
          }}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCcw className="h-3.5 w-3.5" />
          )}
          Refresh
        </Button>
      </div>

      {/* Identity card — read-only here. To rename the workspace, an
          admin uses the dedicated team page (team workspaces) or
          /settings/organization/edit (both kinds). */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="h-4 w-4" />
            Identity
          </CardTitle>
          <CardDescription>
            {isPersonal
              ? "This is your personal workspace. The workspace ID is what support and integrations reference."
              : "The workspace your account belongs to. The org ID is what support and integrations reference."}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm md:grid-cols-2">
          <ReadOnlyField
            label={isPersonal ? "Workspace name" : "Organization name"}
            value={data ? data.orgName || "—" : undefined}
          />
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              {isPersonal ? "Workspace ID" : "Org ID"}
            </Label>
            <div className="flex h-9 items-center gap-2 rounded-md border bg-muted/30 px-3 text-sm">
              {!data ? (
                <Skeleton className="h-4 w-40" />
              ) : (
                <button
                  type="button"
                  className="group inline-flex min-w-0 flex-1 items-center gap-1 truncate font-mono text-xs hover:text-foreground"
                  onClick={() =>
                    copy(data.orgId, isPersonal ? "Workspace ID" : "Org ID")
                  }
                  aria-label={
                    isPersonal ? "Copy workspace ID" : "Copy org ID"
                  }
                >
                  <span className="truncate">{data.orgId}</span>
                  <Copy className="h-3 w-3 opacity-50 group-hover:opacity-100" />
                </button>
              )}
            </div>
          </div>
          {/* Workspaces-linked counter only makes sense for team
              orgs — a personal user is, by definition, the sole
              member, so the line would always read "1 organization
              linked" and just add noise. */}
          {!isPersonal && (
            <DetailRow
              label="Members"
              icon={
                <UsersIcon className="h-3.5 w-3.5 text-muted-foreground" />
              }
              value={
                data
                  ? data.membershipCount === 1
                    ? "1 organization linked"
                    : `${data.membershipCount} organizations linked`
                  : undefined
              }
            />
          )}
          <DetailRow
            label="Your role"
            value={
              data ? (
                <Badge variant="outline" className="capitalize">
                  {/* Personal users are technically "admin" of their
                      own workspace, but the label "Owner" reads more
                      naturally for a single-member org. */}
                  {isPersonal ? "Owner" : data.role || "—"}
                </Badge>
              ) : undefined
            }
          />
          <div className="md:col-span-2">
            <Separator className="my-1" />
            <div className="flex flex-wrap gap-2 pt-3">
              {/* "Edit details" jumps to the dedicated form page for
                  the company name / tax ID / address that prints on
                  every invoice. Keeping the form on its own route
                  removes the long scroll on this page and makes the
                  edit intent explicit. */}
              <Button asChild size="sm" className="h-8">
                <Link href="/settings/organization/edit">
                  <Pencil className="h-3.5 w-3.5" />
                  {isPersonal
                    ? "Edit workspace details"
                    : "Edit organization details"}
                </Link>
              </Button>
              {/* Personal workspaces have no team to manage — the
                  server refuses CreateInvite against them with
                  `personal_org_no_invites`. Hiding the CTA matches
                  the sidebar's teamOnly gate so both surfaces stay
                  consistent. */}
              {!isPersonal && (
                <Button asChild size="sm" variant="outline" className="h-8">
                  <Link href="/settings/team">
                    <UsersIcon className="h-3.5 w-3.5" />
                    Manage team
                  </Link>
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Workspace logo — surfaced in the app shell header. Same upload
          piece is used regardless of provider (admin uploads once, every
          user in the org sees it on next reload). */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ImageIcon className="h-4 w-4" />
            Workspace logo
          </CardTitle>
          <CardDescription>
            {isPersonal
              ? "Shown in the top-left of the app. PNG, JPEG, WebP, or GIF up to 512 KB. A square crop around 256×256 looks best."
              : "Shown in the top-left of the app for every member of this workspace. PNG, JPEG, WebP, or GIF up to 512 KB. A square crop around 256×256 looks best."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-4">
            <div className="grid h-20 w-20 place-items-center overflow-hidden rounded-md border bg-muted/30">
              {data?.orgLogoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={data.orgLogoUrl}
                  alt={`${data.orgName || "Organization"} logo`}
                  className="h-full w-full object-contain"
                />
              ) : (
                <Building2 className="h-8 w-8 text-muted-foreground" />
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                ref={logoInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={onLogoSelected}
              />
              <Button
                size="sm"
                className="h-8"
                onClick={onPickLogo}
                disabled={logoBusy}
              >
                {logoBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                {data?.orgLogoUrl ? "Replace logo" : "Upload logo"}
              </Button>
              {data?.orgLogoUrl && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={onLogoRemove}
                  disabled={logoBusy}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Current plan — full lifecycle controls. The plan catalog (for
          picking / switching) lives on /settings/billing. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CreditCard className="h-4 w-4" />
            Current plan
          </CardTitle>
          <CardDescription>
            Your active subscription and its lifecycle. Use "Change plan"
            to pick a different tier or currency.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-20 w-full" />
          ) : !sub?.id ? (
            // No active sub — either trial used (paywall is also showing
            // app-wide) or the workspace has never had a sub. We surface
            // the same explanation here so deep-links to this page still
            // make sense.
            <div className="space-y-3">
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <div className="flex items-center gap-2 font-medium text-amber-700">
                  <AlertTriangle className="h-4 w-4" />
                  {sub?.trialUsed
                    ? "Trial ended — choose a plan to continue"
                    : "No active subscription"}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {sub?.hint ||
                    (sub?.trialUsed
                      ? "Your free trial has been used. Pick a plan to restore uploads, invites, and integrations. Trials cannot be reissued for the same workspace."
                      : "Pick a plan to activate billing for this workspace.")}
                </p>
              </div>
              <Button asChild size="sm">
                <Link href="/settings/billing">
                  <CreditCard className="mr-1 h-3.5 w-3.5" />
                  Choose a plan
                </Link>
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="text-xl font-semibold">{sub.planName}</span>
                <Badge
                  variant={sub.status === "trialing" ? "default" : "outline"}
                >
                  {sub.status}
                </Badge>
                {sub.cancelAtPeriodEnd && (
                  <Badge variant="outline" className="text-amber-700">
                    Cancels at period end
                  </Badge>
                )}
              </div>

              <div className="grid gap-3 text-xs sm:grid-cols-2">
                <Row
                  label="Price"
                  value={
                    sub.amountCents != null
                      ? `${formatMoney(sub.amountCents, sub.currency || "INR")} / ${sub.interval || ""}`
                      : "Custom"
                  }
                />
                <Row
                  label="Provider"
                  value={
                    sub.provider === "manual"
                      ? "Assigned by support"
                      : sub.provider || "—"
                  }
                />
                {sub.currentPeriodEnd && (
                  <Row
                    label="Renews on"
                    value={new Date(sub.currentPeriodEnd).toLocaleDateString()}
                  />
                )}
                {sub.canceledAt && (
                  <Row
                    label="Canceled"
                    value={new Date(sub.canceledAt).toLocaleString()}
                  />
                )}
                {sub.couponCode && (
                  <Row label="Promo applied" value={sub.couponCode} />
                )}
              </div>

              <Separator />

              {/* Action row: change plan + lifecycle controls. Manual
                  subs are managed by support; cancel/reactivate are
                  hidden for them. Stripe portal handles card updates. */}
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" variant="outline" className="h-8">
                  <Link href="/settings/billing">
                    <CreditCard className="h-3.5 w-3.5" />
                    Change plan
                  </Link>
                </Button>
                {sub.provider !== "manual" && sub.status !== "canceled" && (
                  <>
                    {sub.cancelAtPeriodEnd ? (
                      <Button
                        size="sm"
                        className="h-8"
                        disabled={reactivateBusy}
                        onClick={reactivate}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        {reactivateBusy ? "Reactivating…" : "Reactivate"}
                      </Button>
                    ) : (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8"
                          disabled={cancelBusy}
                          onClick={() => cancelSub(true)}
                        >
                          Cancel at period end
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8"
                          disabled={cancelBusy}
                          onClick={() => cancelSub(false)}
                        >
                          Cancel now
                        </Button>
                      </>
                    )}
                    {sub.provider === "stripe" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        disabled={portalBusy}
                        onClick={openPortal}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        {portalBusy ? "Opening…" : "Manage payment method"}
                      </Button>
                    )}
                  </>
                )}
              </div>

              {/* Past-due banner — payment failed and we're inside the
                  grace window. */}
              {sub.status === "past_due" && (
                <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm">
                  <div className="flex items-center gap-2 font-medium text-red-700">
                    <AlertTriangle className="h-4 w-4" />
                    Payment past due
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Your last payment didn't go through
                    {sub.pastDueSince &&
                      ` on ${new Date(sub.pastDueSince).toLocaleDateString()}`}
                    . Update your payment method to keep the subscription
                    active — repeated failures will cancel it
                    automatically.
                  </p>
                  {sub.provider === "stripe" && (
                    <Button
                      size="sm"
                      className="mt-2"
                      disabled={portalBusy}
                      onClick={openPortal}
                    >
                      {portalBusy ? "Opening…" : "Update payment method"}
                    </Button>
                  )}
                </div>
              )}

              {trialDays != null && (
                <div className="rounded-md border border-blue-500/30 bg-blue-500/10 p-3 text-sm">
                  <div className="flex items-center gap-2 font-medium text-blue-700">
                    <Timer className="h-4 w-4" />
                    {trialDays === 0
                      ? "Trial ends today"
                      : `${trialDays} day${trialDays === 1 ? "" : "s"} left in trial`}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Your trial of {sub.planName} ends{" "}
                    {sub.trialEndsAt &&
                      new Date(sub.trialEndsAt).toLocaleDateString()}
                    . Add a payment method to continue without
                    interruption.
                  </p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Invoices — paid history. Hosted URL + PDF come straight from
          the provider; the manual provider stores PDFs in object
          storage. Empty state is fine for trialing orgs. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Receipt className="h-4 w-4" />
            Invoices
          </CardTitle>
          <CardDescription>
            Every invoice this workspace has been billed. Hosted links
            and PDFs are mirrored from the payment provider.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading || !invoices ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : invoices.length === 0 ? (
            <div className="grid place-items-center gap-2 p-10 text-center text-sm text-muted-foreground">
              <Inbox className="h-8 w-8" />
              No invoices yet.
            </div>
          ) : (
            <ul className="divide-y text-sm">
              {invoices.map((inv) => (
                <li
                  key={inv.id}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">{inv.number}</span>
                      <Badge
                        variant={
                          inv.status === "paid" ? "default" : "outline"
                        }
                        className="text-[10px]"
                      >
                        {inv.status}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(inv.issuedAt).toLocaleDateString()} ·{" "}
                      {inv.provider}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-medium">
                      {formatMoney(inv.totalCents, inv.currency)}
                    </div>
                    <div className="flex items-center justify-end gap-2 text-[11px]">
                      {inv.hostedUrl && (
                        <a
                          href={inv.hostedUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          <ExternalLink className="h-3 w-3" />
                          View
                        </a>
                      )}
                      {inv.pdfUrl && (
                        <a
                          href={inv.pdfUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          <Download className="h-3 w-3" />
                          PDF
                        </a>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Editing the company / tax / address details (printed on every
          invoice) lives on /settings/organization/edit — the Identity
          card's "Edit organization details" button takes you there. */}
    </>
  );
}

function ReadOnlyField({
  label,
  value,
}: {
  label: string;
  value?: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex h-9 items-center gap-2 rounded-md border bg-muted/30 px-3 text-sm">
        {value === undefined ? (
          <Skeleton className="h-4 w-32" />
        ) : (
          <span className="min-w-0 flex-1 truncate">{value}</span>
        )}
      </div>
    </div>
  );
}

function DetailRow({
  label,
  icon,
  value,
}: {
  label: string;
  icon?: React.ReactNode;
  value?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="min-w-0 truncate text-sm">
        {value === undefined ? <Skeleton className="h-4 w-24" /> : value}
      </span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}
