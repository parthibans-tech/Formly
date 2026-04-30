"use client";

// Plan catalog — the "pick a plan" surface. Current subscription,
// invoice history, and the billing details form all live on
// /settings/organization now. This page exists for two cases:
//   1. An admin without an active sub clicks "Choose a plan" and lands
//      here to start checkout.
//   2. An admin with an active sub clicks "Change plan" and lands here
//      to switch tiers. POST /v1/billing/change-plan handles the swap;
//      providers prorate where supported.
//
// Stripe still redirects back here after checkout (success/cancel
// query params) — we surface a toast and bounce to /settings/organization
// so the user lands on the page that actually manages the sub.

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  CreditCard,
  Sparkles,
  Tag,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useBillingState } from "@/lib/billing-state";
import { useToast } from "@/components/toast";
import { BillingDetailsForm } from "@/components/billing-details-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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

// Subscription has two response shapes — the active-sub payload (with
// `id` and a full plan blob) and the no-sub stub the API returns when
// the trial has expired. We only need a tiny slice here: the planId
// (so we can highlight the current plan card) and provider (so we can
// decide whether to call /change-plan vs /checkout).
type Subscription = {
  id?: string;
  status: string;
  provider?: string;
  planId?: string;
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

export default function BillingSettingsPage() {
  const toast = useToast();
  const router = useRouter();
  const search = useSearchParams();
  // Shared billing state — refresh() lifts the AppShell paywall once a
  // successful checkout activates a sub.
  const billing = useBillingState();
  const [sub, setSub] = useState<Subscription | null>(null);
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [currency, setCurrency] = useState<"INR" | "USD">("INR");
  const [loading, setLoading] = useState(true);
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);
  const [couponInput, setCouponInput] = useState("");
  const [couponBusy, setCouponBusy] = useState(false);
  const [coupon, setCoupon] = useState<CouponPreview | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  // Two-step flow before we hit /checkout (or /change-plan):
  //   "plans"   → catalog (default)
  //   "details" → confirm/edit invoice billing details for the picked
  //               plan, then continue to provider checkout / switch.
  // The details step mounts <BillingDetailsForm /> with
  // `requireForCheckout`, which auto-loads the saved profile via GET
  // /v1/billing/profile. So if the org already filled in company /
  // address fields earlier (org page or paywall), they show up
  // pre-populated and editable. Empty profile → admin fills the form
  // here for the first time.
  //
  // Step + selected plan + mode are mirrored into the URL
  // (?step=details&plan=<id>&mode=<checkout|switch>) so a refresh
  // restores the same step instead of bouncing the admin back to the
  // catalog mid-flow. Plans load asynchronously, so we restore once
  // we have the plan list.
  const stepParam = search.get("step");
  const planParam = search.get("plan");
  const modeParam = search.get("mode");
  const [step, setStep] = useState<"plans" | "details">(
    stepParam === "details" && planParam ? "details" : "plans",
  );
  const [pendingPlan, setPendingPlan] = useState<Plan | null>(null);
  // pendingMode tells the onSaved callback whether to start a new
  // checkout or switch the existing sub onto the chosen plan.
  const [pendingMode, setPendingMode] = useState<"checkout" | "switch">(
    modeParam === "switch" ? "switch" : "checkout",
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, p] = await Promise.all([
        api<Subscription>("/v1/billing/subscription").catch(() => null),
        api<{ plans: Plan[]; currency: string }>(
          `/v1/billing/plans?currency=${currency}`
        ),
      ]);
      setSub(s);
      setPlans(p.plans || []);
    } catch (e: any) {
      toast.show("error", "Couldn't load plans", { description: e?.message });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency]);

  useEffect(() => {
    load();
  }, [load]);

  // Restore the picked plan after the catalog loads when the URL
  // says we're in the details step. If the planId in the URL no
  // longer exists in the catalog (e.g. the plan was retired or
  // currency was switched), we fall back to the catalog so the admin
  // doesn't get stuck on an empty details screen. We also normalise
  // the URL when the plan switches currency (the matching plan id
  // changes so we should drop the stale ?plan=).
  useEffect(() => {
    if (!plans || stepParam !== "details" || !planParam) return;
    const found = plans.find((p) => p.id === planParam);
    if (found) {
      setPendingPlan(found);
      // Stay on the details step; mode was already restored above.
    } else {
      // Stale plan id in URL — go back to catalog and clear params.
      setStep("plans");
      setPendingPlan(null);
      router.replace("/settings/billing");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans, stepParam, planParam]);

  // Surface ?status=success|cancel on return from Stripe Checkout. On
  // success we forward the admin to /settings/organization where the
  // sub now lives — manage/cancel/invoices are all there.
  useEffect(() => {
    const status = search.get("status");
    if (status === "success") {
      toast.show("success", "Payment received", {
        description: "Your subscription is being activated.",
      });
      void billing.refresh();
      router.replace("/settings/organization");
    } else if (status === "cancel") {
      toast.show("info", "Checkout canceled", {
        description: "No charge was made.",
      });
      router.replace("/settings/billing");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // Step 1 → step 2. The plan card click stashes the picked plan and
  // mode (new checkout vs. switch existing sub) and flips to the
  // details step. We intentionally do NOT hit the API yet — we want
  // the admin to confirm the invoice billing details first so the
  // very first invoice carries the right legal header.
  const choosePlan = (plan: Plan, mode: "checkout" | "switch") => {
    if (mode === "switch") {
      if (
        !confirm(
          "Switch your subscription to this plan? Charges will be prorated where supported."
        )
      ) {
        return;
      }
    }
    setPendingPlan(plan);
    setPendingMode(mode);
    setStep("details");
    // Mirror the step into the URL so a refresh keeps the admin on
    // the details screen instead of bouncing them back to the catalog.
    router.replace(
      `/settings/billing?step=details&plan=${encodeURIComponent(plan.id)}&mode=${mode}`,
    );
  };

  // Clear the ?step/&plan/&mode params and return to the catalog. Used
  // by the "Back to plans" buttons and after a stale-plan fallback.
  const backToPlans = () => {
    setStep("plans");
    setPendingPlan(null);
    router.replace("/settings/billing");
  };

  // Fired by <BillingDetailsForm onSaved>. The form has just persisted
  // the profile via PUT /v1/billing/profile, so it's safe to start the
  // provider flow knowing the next invoice has correct details.
  const continueAfterDetails = () => {
    if (!pendingPlan) return;
    if (pendingMode === "switch") {
      void doSwitch(pendingPlan.id);
    } else {
      void doCheckout(pendingPlan.id);
    }
  };

  const doCheckout = async (planId: string) => {
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
  // prorates; Razorpay schedules at the cycle boundary; manual just
  // flips the local plan_id. After we settle, jump to /settings/organization
  // because the user wants to see the resulting sub there.
  const doSwitch = async (planId: string) => {
    setBusyPlanId(planId);
    try {
      await api("/v1/billing/change-plan", {
        method: "POST",
        body: JSON.stringify({ planId }),
      });
      toast.show("success", "Plan changed");
      void billing.refresh();
      router.replace("/settings/organization");
    } catch (e: any) {
      toast.show("error", "Couldn't change plan", { description: e?.message });
    } finally {
      setBusyPlanId(null);
    }
  };

  // Preview a promo code against the first paid plan in the current
  // currency. Server validates expiry + applies-to-plan + currency match.
  const applyCoupon = async () => {
    const code = couponInput.trim();
    if (!code) return;
    if (!plans) return;
    const target = plans.find(
      (p) => p.tier !== "free" && p.tier !== "enterprise"
    );
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

  // Render the details step as a focused card so the admin only sees
  // the form they need to confirm. The catalog / coupon stay mounted
  // but hidden so the picker state (selected currency, applied coupon)
  // survives a "Back" click.
  if (step === "details" && pendingPlan) {
    return (
      <>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
              <CreditCard className="h-6 w-6" />
              Confirm billing details
            </h1>
            <p className="text-sm text-muted-foreground">
              Review the details we'll print on every invoice for{" "}
              <span className="font-medium text-foreground">
                {pendingPlan.name}
              </span>
              . We've pre-filled what's already on file from your
              organization profile — edit anything that needs to change
              before continuing to{" "}
              {pendingMode === "switch" ? "switch your plan" : "payment"}.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8"
            disabled={busyPlanId !== null}
            onClick={backToPlans}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to plans
          </Button>
        </div>

        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                <span className="font-medium">{pendingPlan.name}</span>
                <span className="text-muted-foreground">
                  {pendingPlan.amountCents != null
                    ? `${formatMoney(pendingPlan.amountCents, pendingPlan.currency)} / ${pendingPlan.interval}`
                    : "Custom"}
                </span>
              </div>
              {coupon && (
                <span className="text-xs text-emerald-700">
                  Promo {coupon.coupon.code} applied
                </span>
              )}
            </div>

            <BillingDetailsForm
              mode="inline"
              requireForCheckout
              saveLabel={
                pendingMode === "switch"
                  ? "Save & switch plan"
                  : "Save & continue to payment"
              }
              secondaryAction={
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyPlanId !== null}
                  onClick={backToPlans}
                >
                  Back
                </Button>
              }
              onSaved={continueAfterDetails}
            />
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <CreditCard className="h-6 w-6" />
          Plans
        </h1>
        <p className="text-sm text-muted-foreground">
          Pick a plan or switch your current one. Subscription details,
          invoice history, and billing information live in{" "}
          <a
            href="/settings/organization"
            className="font-medium text-primary hover:underline"
          >
            Organization
          </a>
          .
        </p>
      </div>

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
                  onChange={(e) =>
                    setCouponInput(e.target.value.toUpperCase())
                  }
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
                // Real active sub iff the API returned an id (the stub
                // payload for trial-expired orgs has no id). Manual subs
                // are managed by support, so the in-app picker switches
                // to "checkout new plan" instead of "switch plan" RPC.
                const hasActiveSub =
                  !!sub?.id &&
                  sub.status !== "canceled" &&
                  sub.provider !== "manual";
                const action =
                  hasActiveSub && sub?.planId !== p.id
                    ? () => choosePlan(p, "switch")
                    : () => choosePlan(p, "checkout");
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
    </>
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
        {isCurrent && <CheckCircle2 className="h-4 w-4 text-primary" />}
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
