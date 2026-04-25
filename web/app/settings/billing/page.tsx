"use client";

// Self-serve billing page.
//
// Phase 4a shipped read-only catalog + invoice history; Phase 4b wires
// the live Razorpay (INR) / Stripe (USD) checkout flow. Pressing
// "Upgrade" POSTs /v1/billing/checkout — the server picks the provider
// from the plan currency and returns a hosted URL we redirect to. The
// active subscription card gains Cancel / Reactivate controls; webhooks
// reconcile the eventual state, but we optimistically refresh after the
// API call returns.

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  CreditCard,
  Download,
  ExternalLink,
  Inbox,
  Receipt,
  RotateCcw,
  Save,
  Sparkles,
  Tag,
  Timer,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { api, getUser } from "@/lib/api";
import { useToast } from "@/components/toast";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Subscription = {
  id: string;
  status: string;
  provider: string;
  planId: string;
  planName: string;
  tier: string;
  currency: string;
  interval: string;
  amountCents?: number | null;
  trialEndsAt?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt?: string | null;
  pastDueSince?: string | null;
  couponCode?: string | null;
  updatedAt: string;
};

type Plan = {
  id: string;
  name: string;
  tier: string;
  currency: string;
  interval: string;
  amountCents?: number | null;
  maxUsers?: number | null;
  maxStorageBytes?: number | null;
  features: Record<string, any>;
  sortOrder: number;
};

type Coupon = {
  code: string;
  percentOff?: number;
  amountOffCents?: number;
  currency?: string;
  duration: "once" | "forever" | "repeating";
  durationMonths?: number | null;
};

type CouponPreview = {
  coupon: Coupon;
  originalCents: number;
  discountedCents: number;
  currency: string;
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

const CURRENCY_SYMBOL: Record<string, string> = {
  INR: "₹",
  USD: "$",
};

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

type BillingProfile = {
  companyName: string;
  billingEmail: string;
  billingPhone: string;
  taxId: string;
  taxIdLabel: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  notes: string;
  updatedAt?: string | null;
  updatedBy?: string | null;
};

const EMPTY_PROFILE: BillingProfile = {
  companyName: "",
  billingEmail: "",
  billingPhone: "",
  taxId: "",
  taxIdLabel: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  region: "",
  postalCode: "",
  country: "",
  notes: "",
};

const TAX_LABELS = ["", "GSTIN", "VAT", "ABN", "EIN", "PAN", "Other"];

export default function BillingSettingsPage() {
  const toast = useToast();
  const router = useRouter();
  const search = useSearchParams();
  const [sub, setSub] = useState<Subscription | null>(null);
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [currency, setCurrency] = useState<"INR" | "USD">("INR");
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<BillingProfile>(EMPTY_PROFILE);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileDirty, setProfileDirty] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [reactivateBusy, setReactivateBusy] = useState(false);
  const [portalBusy, setPortalBusy] = useState(false);
  const [couponInput, setCouponInput] = useState("");
  const [couponBusy, setCouponBusy] = useState(false);
  const [coupon, setCoupon] = useState<CouponPreview | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, p, i] = await Promise.all([
        api<Subscription>("/v1/billing/subscription").catch(() => null),
        api<{ plans: Plan[]; currency: string }>(
          `/v1/billing/plans?currency=${currency}`
        ),
        api<{ invoices: Invoice[] }>("/v1/billing/invoices").catch(() => ({
          invoices: [],
        })),
      ]);
      setSub(s);
      setPlans(p.plans || []);
      setInvoices(i.invoices || []);
    } catch (e: any) {
      toast.show("error", "Couldn't load billing", { description: e?.message });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency]);

  useEffect(() => {
    load();
  }, [load]);

  // Load billing profile + admin role once on mount. Profile is shared
  // by all members (it's invoice content) but only admins can edit.
  useEffect(() => {
    setIsAdmin(getUser()?.role === "admin");
    api<BillingProfile>("/v1/billing/profile")
      .then((p) => {
        setProfile({ ...EMPTY_PROFILE, ...p });
        setProfileLoaded(true);
      })
      .catch(() => setProfileLoaded(true));
  }, []);

  const updateProfile = (patch: Partial<BillingProfile>) => {
    setProfile((prev) => ({ ...prev, ...patch }));
    setProfileDirty(true);
  };

  const saveProfile = async () => {
    setProfileSaving(true);
    try {
      const res = await api<BillingProfile>("/v1/billing/profile", {
        method: "PUT",
        body: JSON.stringify(profile),
      });
      setProfile({ ...EMPTY_PROFILE, ...res });
      setProfileDirty(false);
      toast.show("success", "Billing details saved");
    } catch (e: any) {
      toast.show("error", "Couldn't save billing details", {
        description: e?.message,
      });
    } finally {
      setProfileSaving(false);
    }
  };

  // Surface ?status=success|cancel on return from Stripe Checkout. We
  // strip the param so a refresh doesn't re-toast.
  useEffect(() => {
    const status = search.get("status");
    if (status === "success") {
      toast.show("success", "Payment received", {
        description: "Your subscription is being activated.",
      });
      router.replace("/settings/billing");
    } else if (status === "cancel") {
      toast.show("info", "Checkout canceled", {
        description: "No charge was made.",
      });
      router.replace("/settings/billing");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const trialDays = sub?.status === "trialing" ? daysUntil(sub.trialEndsAt) : null;

  const startCheckout = async (planId: string) => {
    setBusyPlanId(planId);
    try {
      const successURL = `${window.location.origin}/settings/billing?status=success`;
      const cancelURL = `${window.location.origin}/settings/billing?status=cancel`;
      const res = await api<{ url: string; provider: string }>(
        "/v1/billing/checkout",
        {
          method: "POST",
          body: JSON.stringify({
            planId,
            successUrl: successURL,
            cancelUrl: cancelURL,
            couponCode: coupon?.coupon.code || undefined,
          }),
        }
      );
      if (res.url) {
        window.location.href = res.url;
      }
    } catch (e: any) {
      toast.show("error", "Couldn't start checkout", {
        description: e?.message,
      });
      setBusyPlanId(null);
    }
  };

  // Switch the active sub onto a different plan via /change-plan. Stripe
  // prorates; Razorpay schedules at the cycle boundary; manual just flips
  // the local plan_id. Webhooks reconcile after.
  const switchPlan = async (planId: string) => {
    if (
      !confirm(
        "Switch your subscription to this plan? Charges will be prorated where supported."
      )
    ) {
      return;
    }
    setBusyPlanId(planId);
    try {
      await api("/v1/billing/change-plan", {
        method: "POST",
        body: JSON.stringify({ planId }),
      });
      toast.show("success", "Plan changed");
      await load();
    } catch (e: any) {
      toast.show("error", "Couldn't change plan", { description: e?.message });
    } finally {
      setBusyPlanId(null);
    }
  };

  const reactivate = async () => {
    setReactivateBusy(true);
    try {
      await api("/v1/billing/reactivate", { method: "POST" });
      toast.show("success", "Subscription reactivated");
      await load();
    } catch (e: any) {
      toast.show("error", "Couldn't reactivate", { description: e?.message });
    } finally {
      setReactivateBusy(false);
    }
  };

  const openPortal = async () => {
    setPortalBusy(true);
    try {
      const returnURL = `${window.location.origin}/settings/billing`;
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

  // Preview a promo code against the first paid plan in the current
  // currency. Server validates expiry + applies-to-plan + currency match.
  const applyCoupon = async () => {
    const code = couponInput.trim();
    if (!code) return;
    if (!plans) return;
    const target = plans.find((p) => p.tier !== "free" && p.tier !== "enterprise");
    if (!target) {
      setCouponError("No paid plan available to apply this code to.");
      return;
    }
    setCouponBusy(true);
    setCouponError(null);
    try {
      const res = await api<CouponPreview>(
        `/v1/billing/coupons/preview?code=${encodeURIComponent(code)}&planId=${encodeURIComponent(target.id)}`
      );
      setCoupon(res);
    } catch (e: any) {
      setCoupon(null);
      setCouponError(e?.message || "Invalid coupon");
    } finally {
      setCouponBusy(false);
    }
  };

  const clearCoupon = () => {
    setCoupon(null);
    setCouponInput("");
    setCouponError(null);
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
    } catch (e: any) {
      toast.show("error", "Cancel failed", { description: e?.message });
    } finally {
      setCancelBusy(false);
    }
  };

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <CreditCard className="h-6 w-6" />
          Billing
        </h1>
        <p className="text-sm text-muted-foreground">
          Your plan, trial status, and invoice history.
        </p>
      </div>

      {/* Current plan card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Current plan</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-20 w-full" />
          ) : !sub ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <div className="flex items-center gap-2 font-medium text-amber-700">
                <AlertTriangle className="h-4 w-4" />
                No active subscription
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Contact support to set up billing for this workspace.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="text-xl font-semibold">{sub.planName}</span>
                <Badge variant={sub.status === "trialing" ? "default" : "outline"}>
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
                      ? `${formatMoney(sub.amountCents, sub.currency)} / ${sub.interval}`
                      : "Custom"
                  }
                />
                <Row
                  label="Provider"
                  value={
                    sub.provider === "manual" ? "Assigned by support" : sub.provider
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

              {/* Cancel / Reactivate / Portal. Manual subs are managed
                  by support. Reactivate only shows when a cancel is
                  pending; Portal is Stripe-only on the server. */}
              {sub.provider !== "manual" && sub.status !== "canceled" && (
                <div className="flex flex-wrap gap-2">
                  {sub.cancelAtPeriodEnd ? (
                    <Button
                      variant="default"
                      size="sm"
                      disabled={reactivateBusy}
                      onClick={reactivate}
                    >
                      <RotateCcw className="mr-1 h-3 w-3" />
                      {reactivateBusy ? "Reactivating…" : "Reactivate"}
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={cancelBusy}
                        onClick={() => cancelSub(true)}
                      >
                        Cancel at period end
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
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
                      disabled={portalBusy}
                      onClick={openPortal}
                    >
                      <ExternalLink className="mr-1 h-3 w-3" />
                      {portalBusy ? "Opening…" : "Manage payment method"}
                    </Button>
                  )}
                </div>
              )}

              {/* Past-due banner — payment failed and we're inside the
                  grace window. Tells the admin exactly what to do. */}
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
                    active — repeated failures will cancel it automatically.
                  </p>
                  {sub.provider === "stripe" && (
                    <Button
                      size="sm"
                      variant="default"
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
                    . Add a payment method to continue without interruption.
                  </p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Plan catalog */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Available plans</CardTitle>
            <CardDescription>
              INR plans run through Razorpay; USD plans through Stripe.
              Enterprise is sales-led.
            </CardDescription>
          </div>
          <div className="w-32">
            <Select
              value={currency}
              onValueChange={(v) => setCurrency(v as "INR" | "USD")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="INR">INR (₹)</SelectItem>
                <SelectItem value="USD">USD ($)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Promo code. Validates against the first paid plan in the
              current currency; the same code is then forwarded to
              checkout / change-plan so the provider records it too. */}
          <div className="rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Tag className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Promo code</span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Input
                  value={couponInput}
                  onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                  placeholder="LAUNCH20"
                  className="h-8 w-40"
                  disabled={couponBusy || !!coupon}
                />
                {coupon ? (
                  <Button size="sm" variant="ghost" onClick={clearCoupon}>
                    Remove
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={couponBusy || !couponInput.trim()}
                    onClick={applyCoupon}
                  >
                    {couponBusy ? "Checking…" : "Apply"}
                  </Button>
                )}
              </div>
            </div>
            {coupon && (
              <p className="mt-2 text-xs text-emerald-700">
                <CheckCircle2 className="mr-1 inline h-3 w-3" />
                {coupon.coupon.percentOff
                  ? `${coupon.coupon.percentOff}% off`
                  : coupon.coupon.amountOffCents
                    ? `${formatMoney(coupon.coupon.amountOffCents, coupon.currency)} off`
                    : "Discount"}
                {" — "}
                {formatMoney(coupon.originalCents, coupon.currency)} →{" "}
                <span className="font-semibold">
                  {formatMoney(coupon.discountedCents, coupon.currency)}
                </span>
                {coupon.coupon.duration === "once"
                  ? " on first invoice"
                  : coupon.coupon.duration === "repeating"
                    ? ` for ${coupon.coupon.durationMonths ?? ""} months`
                    : " for the lifetime of the subscription"}
              </p>
            )}
            {couponError && (
              <p className="mt-2 text-xs text-destructive">{couponError}</p>
            )}
          </div>

          {loading || !plans ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <div className="grid gap-3 md:grid-cols-3">
              {plans.map((p) => {
                const hasActiveSub =
                  !!sub &&
                  sub.status !== "canceled" &&
                  sub.provider !== "manual";
                const action =
                  hasActiveSub && sub!.planId !== p.id
                    ? () => switchPlan(p.id)
                    : () => startCheckout(p.id);
                return (
                  <PlanCard
                    key={p.id}
                    plan={p}
                    isCurrent={sub?.planId === p.id}
                    hasActiveSub={hasActiveSub}
                    busy={busyPlanId === p.id}
                    onAction={action}
                  />
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Billing details — printed on invoices, sent to providers as
          customer.address. Read-only for non-admin members. */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              Billing details
            </CardTitle>
            <CardDescription>
              Company name, tax ID, and address that appear on every invoice.
              {!isAdmin && " Only admins can edit."}
            </CardDescription>
          </div>
          {profile.updatedAt && (
            <span className="text-[11px] text-muted-foreground whitespace-nowrap">
              Updated {new Date(profile.updatedAt).toLocaleDateString()}
            </span>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {!profileLoaded ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Company / legal name">
                  <Input
                    value={profile.companyName}
                    disabled={!isAdmin}
                    placeholder="Acme Inc."
                    onChange={(e) =>
                      updateProfile({ companyName: e.target.value })
                    }
                  />
                </Field>
                <Field label="Billing email">
                  <Input
                    type="email"
                    value={profile.billingEmail}
                    disabled={!isAdmin}
                    placeholder="ap@acme.com"
                    onChange={(e) =>
                      updateProfile({ billingEmail: e.target.value })
                    }
                  />
                </Field>
                <Field label="Billing phone">
                  <Input
                    value={profile.billingPhone}
                    disabled={!isAdmin}
                    placeholder="+1 555 0100"
                    onChange={(e) =>
                      updateProfile({ billingPhone: e.target.value })
                    }
                  />
                </Field>
                <Field label="Tax ID type">
                  <Select
                    value={profile.taxIdLabel || "__none"}
                    disabled={!isAdmin}
                    onValueChange={(v) =>
                      updateProfile({ taxIdLabel: v === "__none" ? "" : v })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">None</SelectItem>
                      {TAX_LABELS.filter(Boolean).map((l) => (
                        <SelectItem key={l} value={l}>
                          {l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field
                  label={`Tax ID number${profile.taxIdLabel ? ` (${profile.taxIdLabel})` : ""}`}
                  className="sm:col-span-2"
                >
                  <Input
                    value={profile.taxId}
                    disabled={!isAdmin}
                    placeholder="29ABCDE1234F1Z5"
                    onChange={(e) => updateProfile({ taxId: e.target.value })}
                  />
                </Field>
              </div>

              <Separator />

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Address line 1" className="sm:col-span-2">
                  <Input
                    value={profile.addressLine1}
                    disabled={!isAdmin}
                    placeholder="221B Baker Street"
                    onChange={(e) =>
                      updateProfile({ addressLine1: e.target.value })
                    }
                  />
                </Field>
                <Field label="Address line 2" className="sm:col-span-2">
                  <Input
                    value={profile.addressLine2}
                    disabled={!isAdmin}
                    placeholder="Suite, floor, etc."
                    onChange={(e) =>
                      updateProfile({ addressLine2: e.target.value })
                    }
                  />
                </Field>
                <Field label="City">
                  <Input
                    value={profile.city}
                    disabled={!isAdmin}
                    onChange={(e) => updateProfile({ city: e.target.value })}
                  />
                </Field>
                <Field label="State / region">
                  <Input
                    value={profile.region}
                    disabled={!isAdmin}
                    onChange={(e) => updateProfile({ region: e.target.value })}
                  />
                </Field>
                <Field label="Postal code">
                  <Input
                    value={profile.postalCode}
                    disabled={!isAdmin}
                    onChange={(e) =>
                      updateProfile({ postalCode: e.target.value })
                    }
                  />
                </Field>
                <Field label="Country (ISO code)">
                  <Input
                    value={profile.country}
                    disabled={!isAdmin}
                    placeholder="IN, US, GB…"
                    maxLength={80}
                    onChange={(e) =>
                      updateProfile({ country: e.target.value.toUpperCase() })
                    }
                  />
                </Field>
              </div>

              <Field label="Notes for finance team">
                <textarea
                  className="flex min-h-[72px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  value={profile.notes}
                  disabled={!isAdmin}
                  placeholder="PO number, accounts payable instructions, etc."
                  maxLength={1000}
                  onChange={(e) => updateProfile({ notes: e.target.value })}
                />
              </Field>

              {isAdmin && (
                <div className="flex items-center justify-end gap-2 pt-1">
                  <span className="text-xs text-muted-foreground">
                    {profileDirty ? "Unsaved changes" : "Up to date"}
                  </span>
                  <Button
                    size="sm"
                    onClick={saveProfile}
                    disabled={!profileDirty || profileSaving}
                  >
                    <Save className="mr-1 h-3.5 w-3.5" />
                    {profileSaving ? "Saving…" : "Save"}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Invoice history */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Receipt className="h-4 w-4" />
            Invoices
          </CardTitle>
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
                        variant={inv.status === "paid" ? "default" : "outline"}
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
    </>
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

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5 text-sm", className)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function PlanCard({
  plan,
  isCurrent,
  hasActiveSub,
  busy,
  onAction,
}: {
  plan: Plan;
  isCurrent: boolean;
  hasActiveSub: boolean;
  busy: boolean;
  onAction: () => void;
}) {
  const featured = plan.tier === "pro";
  const isFree = plan.tier === "free";
  const isEnterprise = plan.tier === "enterprise";
  const cta = isCurrent
    ? "Current plan"
    : isEnterprise
      ? "Contact sales"
      : isFree
        ? "Downgrade"
        : busy
          ? hasActiveSub
            ? "Switching…"
            : "Redirecting…"
          : hasActiveSub
            ? "Switch to this plan"
            : "Upgrade";
  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border p-4",
        featured && "border-primary/40 bg-primary/5",
        isCurrent && "ring-2 ring-primary"
      )}
    >
      <div className="flex items-center justify-between">
        <div className="font-medium">{plan.name}</div>
        {isCurrent && (
          <CheckCircle2 className="h-4 w-4 text-primary" />
        )}
        {featured && !isCurrent && (
          <Sparkles className="h-4 w-4 text-primary" />
        )}
      </div>
      <div className="mt-2 text-2xl font-semibold">
        {plan.amountCents != null
          ? formatMoney(plan.amountCents, plan.currency)
          : "Custom"}
        {plan.amountCents != null && plan.interval !== "none" && (
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            / {plan.interval}
          </span>
        )}
      </div>
      <Separator className="my-3" />
      <ul className="space-y-1 text-xs text-muted-foreground">
        <li>
          {plan.maxUsers == null
            ? "Unlimited users"
            : `Up to ${plan.maxUsers} users`}
        </li>
        <li>
          {plan.maxStorageBytes == null
            ? "Unlimited storage"
            : `${(plan.maxStorageBytes / 1024 ** 3).toFixed(0)} GB storage`}
        </li>
        {plan.features?.api_keys && <li>API keys</li>}
        {plan.features?.webhooks && <li>Webhooks</li>}
        {plan.features?.sso && <li>SSO</li>}
        {plan.features?.sla && <li>Enterprise SLA</li>}
      </ul>
      <div className="mt-4">
        <Button
          size="sm"
          variant={isCurrent ? "outline" : "default"}
          className="w-full"
          disabled={isCurrent || isEnterprise || isFree || busy}
          onClick={onAction}
        >
          {cta}
        </Button>
      </div>
    </div>
  );
}
