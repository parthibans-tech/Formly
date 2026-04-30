"use client";

// Full-screen paywall that replaces the entire app shell when an org's
// trial has ended (or any other "no active subscription" state). No
// sidebar, no header, no breadcrumbs — the only escape hatches are
// "pick a plan", "switch to another org you belong to", and "sign out".
//
// Mounted by AppShell when `useBillingState().requiresUpgrade === true`.
// The gate renders the same plan catalog as /settings/billing but in a
// focused single-purpose layout so admins can't get lost on the way to
// checkout.
//
// Non-admins land on a softer page asking them to nudge their owner —
// only owners/admins can actually start checkout via the API.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  LifeBuoy,
  LogOut,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { api, clearSession, getUser } from "@/lib/api";
import { useBillingState } from "@/lib/billing-state";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/ui/confirm";
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
import { OrgSwitcher } from "@/components/org-switcher";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { BillingDetailsForm } from "@/components/billing-details-form";
import { cn } from "@/lib/utils";

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

// Two-step paywall flow:
//   1. "plan"    — pick a plan from the catalog.
//   2. "details" — confirm billing details (company / tax ID / address).
//                  Required fields are validated here so the very first
//                  invoice already has a correct legal header.
//   On save+continue we POST /v1/billing/checkout and redirect to the
//   provider-hosted checkout page.
type PaywallStep = "plan" | "details";

export function PaywallGate() {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const { trialUsed, hint, refresh } = useBillingState();
  const [step, setStep] = useState<PaywallStep>("plan");
  const [selectedPlan, setSelectedPlan] = useState<Plan | null>(null);
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [currency, setCurrency] = useState<"INR" | "USD">("INR");
  const [loadingPlans, setLoadingPlans] = useState(true);
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);

  const user = getUser();
  const isAdmin = user?.role === "admin";

  // Initial currency from browser locale — INR for India, USD elsewhere.
  // The user can flip via the Select.
  useEffect(() => {
    try {
      const lang = navigator.language?.toLowerCase() || "";
      if (lang.includes("-in") || lang.startsWith("hi")) setCurrency("INR");
      else setCurrency("USD");
    } catch {}
  }, []);

  const loadPlans = useCallback(async () => {
    setLoadingPlans(true);
    try {
      const res = await api<{ plans: Plan[] }>(
        `/v1/billing/plans?currency=${currency}`,
      );
      setPlans(res.plans || []);
    } catch (e: any) {
      toast.show("error", "Couldn't load plans", { description: e?.message });
    } finally {
      setLoadingPlans(false);
    }
  }, [currency, toast]);

  useEffect(() => {
    loadPlans();
  }, [loadPlans]);

  // Step 1 → step 2: stash the chosen plan and switch to the details
  // form. We do NOT hit /checkout yet — the user gets a chance to
  // confirm the billing address that will appear on the invoice first.
  const choosePlan = (plan: Plan) => {
    setSelectedPlan(plan);
    setStep("details");
  };

  // Step 2 → checkout: BillingDetailsForm has just persisted the
  // profile via PUT /v1/billing/profile, so we can safely call
  // /checkout knowing the next invoice will carry the right details.
  const startCheckout = async (planId: string) => {
    setBusyPlanId(planId);
    try {
      const successURL = `${window.location.origin}/settings/billing?status=success`;
      const cancelURL = `${window.location.origin}/settings/billing?status=cancel`;
      const res = await api<{ url: string }>("/v1/billing/checkout", {
        method: "POST",
        body: JSON.stringify({
          planId,
          successUrl: successURL,
          cancelUrl: cancelURL,
        }),
      });
      if (res.url) {
        window.location.href = res.url;
        return;
      }
      // Manual / no-redirect provider — refresh state and let the shell
      // unblock if the new sub took.
      await refresh();
    } catch (e: any) {
      toast.show("error", "Couldn't start checkout", {
        description: e?.message,
      });
      setBusyPlanId(null);
    }
  };

  async function logout() {
    const ok = await confirm({
      title: "Sign out?",
      description: "You'll need to sign in again to continue.",
      confirmLabel: "Sign out",
    });
    if (!ok) return;
    clearSession();
    router.replace("/login");
  }

  // Filter to "actionable" plans for the picker — drop the free row
  // (trial is already used; free isn't an option) and the enterprise
  // row (sales-led; we surface a separate contact card below).
  const payable = (plans || []).filter(
    (p) => p.tier !== "free" && p.tier !== "enterprise",
  );
  const enterprise = (plans || []).find((p) => p.tier === "enterprise");

  return (
    <div className="min-h-screen bg-background">
      {/* Minimal top bar — just account controls, no nav. */}
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-4 md:px-6">
          <CreditCard className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Choose a plan</span>
          <Badge variant="outline" className="ml-1 text-[10px] uppercase">
            {trialUsed ? "Trial ended" : "Action required"}
          </Badge>
          <div className="ml-auto flex items-center gap-1">
            <OrgSwitcher />
            <ThemeToggle />
            <Button variant="ghost" size="sm" onClick={logout}>
              <LogOut className="mr-1 h-4 w-4" />
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-10 md:px-6">
        {/* Step indicator — two crumbs (plan, details) the admin can
            see at a glance so it's clear there's a second step before
            checkout. Hidden for non-admins (they can't act on either). */}
        {isAdmin && (
          <ol className="mb-6 flex items-center justify-center gap-3 text-xs text-muted-foreground">
            <li
              className={cn(
                "flex items-center gap-1.5",
                step === "plan" && "font-medium text-foreground",
              )}
            >
              <span
                className={cn(
                  "grid h-5 w-5 place-items-center rounded-full border text-[10px]",
                  step === "plan"
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-emerald-500 bg-emerald-500 text-white",
                )}
              >
                {step === "plan" ? "1" : "✓"}
              </span>
              Choose plan
            </li>
            <span aria-hidden className="h-px w-8 bg-border" />
            <li
              className={cn(
                "flex items-center gap-1.5",
                step === "details" && "font-medium text-foreground",
              )}
            >
              <span
                className={cn(
                  "grid h-5 w-5 place-items-center rounded-full border text-[10px]",
                  step === "details"
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground/30",
                )}
              >
                2
              </span>
              Billing details
            </li>
          </ol>
        )}

        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            {step === "details"
              ? "Confirm your billing details"
              : trialUsed
                ? "Your trial has ended"
                : "Pick a plan to continue"}
          </h1>
          <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
            {step === "details"
              ? `Review the details we'll print on every invoice for ${selectedPlan?.name ?? "your plan"}. We've pre-filled what's already on file — edit anything that needs to change before you continue to payment. You can update them later from Settings → Organization.`
              : hint ||
                (trialUsed
                  ? "Choose a plan to keep using your workspace. Your data is preserved — uploads, invites, and integrations resume the moment checkout completes."
                  : "Your workspace doesn't have an active subscription. Pick a plan below to get started.")}
          </p>
        </div>

        {!isAdmin ? (
          <NonAdminNotice ownerEmail={user?.email} />
        ) : step === "plan" ? (
          <>
            <div className="mb-4 flex items-center justify-end gap-2">
              <span className="text-xs text-muted-foreground">Currency</span>
              <div className="w-32">
                <Select
                  value={currency}
                  onValueChange={(v) => setCurrency(v as "INR" | "USD")}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="INR">INR (₹)</SelectItem>
                    <SelectItem value="USD">USD ($)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {loadingPlans ? (
              <div className="grid gap-3 md:grid-cols-2">
                <Skeleton className="h-64 w-full" />
                <Skeleton className="h-64 w-full" />
              </div>
            ) : payable.length === 0 ? (
              <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
                No plans available in {currency}. Try the other currency or
                contact support.
              </div>
            ) : (
              <div
                className={cn(
                  "grid gap-3",
                  payable.length === 1
                    ? "md:grid-cols-1 md:max-w-md md:mx-auto"
                    : "md:grid-cols-2",
                )}
              >
                {payable.map((p) => (
                  <PaywallPlanCard
                    key={p.id}
                    plan={p}
                    busy={busyPlanId === p.id}
                    onChoose={() => choosePlan(p)}
                  />
                ))}
              </div>
            )}

            {enterprise && (
              <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-4">
                <div>
                  <div className="text-sm font-medium">
                    Need more seats, SSO, or a custom SLA?
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Enterprise is sales-led. We'll get back within one
                    business day.
                  </div>
                </div>
                <Button variant="outline" size="sm" asChild>
                  <a href="mailto:sales@drive360.app?subject=Enterprise%20plan">
                    <Sparkles className="mr-1 h-3.5 w-3.5" />
                    Contact sales
                  </a>
                </Button>
              </div>
            )}
          </>
        ) : (
          // Step 2 — details form. Required fields are enforced via
          // `requireForCheckout`. On save the form's onSaved callback
          // fires startCheckout(), which redirects to the provider.
          <div className="mx-auto max-w-3xl rounded-lg border bg-card p-5">
            {selectedPlan && (
              <div className="mb-4 flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
                <div className="flex items-center gap-2 text-sm">
                  <Sparkles className="h-4 w-4 text-primary" />
                  <span className="font-medium">{selectedPlan.name}</span>
                  <span className="text-muted-foreground">
                    {selectedPlan.amountCents != null
                      ? `${formatMoney(selectedPlan.amountCents, selectedPlan.currency)} / ${selectedPlan.interval}`
                      : "Custom"}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  onClick={() => setStep("plan")}
                  disabled={busyPlanId !== null}
                >
                  <ArrowLeft className="mr-1 h-3.5 w-3.5" />
                  Change plan
                </Button>
              </div>
            )}
            <BillingDetailsForm
              mode="inline"
              requireForCheckout
              saveLabel="Save & continue to checkout"
              secondaryAction={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setStep("plan")}
                  disabled={busyPlanId !== null}
                >
                  Back
                </Button>
              }
              onSaved={() => {
                if (selectedPlan) startCheckout(selectedPlan.id);
              }}
            />
          </div>
        )}

        <div className="mt-10 flex flex-wrap items-center justify-center gap-4 text-xs text-muted-foreground">
          <a
            href="mailto:support@drive360.app"
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            <LifeBuoy className="h-3.5 w-3.5" />
            Need help? Contact support
          </a>
        </div>
      </main>
    </div>
  );
}

// NonAdminNotice — shown to members/viewers who can't start checkout
// themselves. Tells them whose attention they need.
function NonAdminNotice({ ownerEmail }: { ownerEmail?: string }) {
  return (
    <div className="mx-auto max-w-md rounded-lg border bg-card p-6 text-center">
      <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-amber-500" />
      <h2 className="text-base font-semibold">Ask your workspace owner</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Only an owner or admin can choose a plan and complete checkout.
        {ownerEmail
          ? " You can ping them and forward this URL once billing is sorted."
          : ""}
      </p>
      <Separator className="my-4" />
      <p className="text-xs text-muted-foreground">
        Your account stays signed in — refresh this page after the workspace is
        upgraded and you'll go straight back to work.
      </p>
    </div>
  );
}

function PaywallPlanCard({
  plan,
  busy,
  onChoose,
}: {
  plan: Plan;
  busy: boolean;
  onChoose: () => void;
}) {
  const featured = plan.tier === "pro";
  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border p-5",
        featured && "border-primary/40 bg-primary/5",
      )}
    >
      <div className="flex items-center justify-between">
        <div className="text-base font-semibold">{plan.name}</div>
        {featured && <Sparkles className="h-4 w-4 text-primary" />}
      </div>
      <div className="mt-3 text-3xl font-semibold">
        {plan.amountCents != null
          ? formatMoney(plan.amountCents, plan.currency)
          : "Custom"}
        {plan.amountCents != null && plan.interval !== "none" && (
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            / {plan.interval}
          </span>
        )}
      </div>
      <Separator className="my-4" />
      <ul className="space-y-1.5 text-sm">
        <li className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
          <span>
            {plan.maxUsers == null
              ? "Unlimited users"
              : `Up to ${plan.maxUsers} users`}
          </span>
        </li>
        <li className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
          <span>
            {plan.maxStorageBytes == null
              ? "Unlimited storage"
              : `${(plan.maxStorageBytes / 1024 ** 3).toFixed(0)} GB storage`}
          </span>
        </li>
        {plan.features?.api_keys && (
          <li className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
            <span>API keys</span>
          </li>
        )}
        {plan.features?.webhooks && (
          <li className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
            <span>Webhooks</span>
          </li>
        )}
        {plan.features?.sso && (
          <li className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
            <span>SSO</span>
          </li>
        )}
      </ul>
      <div className="mt-5">
        <Button
          size="default"
          variant={featured ? "default" : "outline"}
          className="w-full"
          disabled={busy}
          onClick={onChoose}
        >
          {busy ? (
            "Redirecting…"
          ) : (
            <>
              Choose {plan.name}
              <ExternalLink className="ml-1 h-3.5 w-3.5" />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
