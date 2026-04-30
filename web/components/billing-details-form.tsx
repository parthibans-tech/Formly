"use client";

// Shared "Billing details" form — company name, tax ID, address. The
// fields here are printed verbatim on every invoice and forwarded to
// the provider as customer.address, so this is the single source of
// truth for who an org actually is from a finance/legal standpoint.
//
// Mounted in three places, all backed by GET/PUT /v1/billing/profile:
//
//   1. /settings/billing   — the long-running "manage billing" page.
//   2. /settings/account   — admin-only card so workspace owners can
//                            keep these details current without leaving
//                            their profile screen.
//   3. PaywallGate         — the "trial ended → pick a plan" flow.
//                            We collect details *before* sending the
//                            user to provider checkout so the very first
//                            invoice already has the right billing
//                            address on it.
//
// The component is dumb about routing: callers pass `mode` to control
// the surface (full card with header, or a tighter inline panel for
// the paywall), and `onSaved` to react to a successful save (e.g. the
// paywall continues to checkout once details are stored).

import { useEffect, useState } from "react";
import { Building2, Loader2, Save } from "lucide-react";
import { api, getUser } from "@/lib/api";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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

export type BillingProfile = {
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

export const EMPTY_BILLING_PROFILE: BillingProfile = {
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

const TAX_LABELS = ["GSTIN", "VAT", "ABN", "EIN", "PAN", "Other"];

// Minimum fields the provider needs to issue a tax-correct invoice.
// We surface inline validation only when `requireForCheckout` is true
// (paywall flow); the standalone settings forms just save whatever the
// admin types so partial updates aren't blocked.
const REQUIRED_FOR_CHECKOUT: Array<keyof BillingProfile> = [
  "companyName",
  "billingEmail",
  "addressLine1",
  "city",
  "country",
];

type Props = {
  /**
   * Visual surface:
   *   - "card"   → wraps the form in a <Card> with header + description.
   *               Use on /settings/billing and /settings/account.
   *   - "inline" → no card chrome, suitable for embedding inside another
   *               container (paywall step).
   */
  mode?: "card" | "inline";
  /**
   * When true, the Save button label flips to "Save & continue" and the
   * required-fields list is enforced before save. The paywall passes
   * this so it can route to checkout only once the invoice header is
   * actually fillable.
   */
  requireForCheckout?: boolean;
  /**
   * Called with the persisted profile after a successful PUT. The
   * paywall uses this to advance to the provider checkout redirect.
   */
  onSaved?: (profile: BillingProfile) => void;
  /**
   * Override the save button label. Defaults to "Save" / "Save &
   * continue" depending on `requireForCheckout`.
   */
  saveLabel?: string;
  /** Optional secondary action rendered next to Save (e.g. "Back"). */
  secondaryAction?: React.ReactNode;
};

export function BillingDetailsForm({
  mode = "card",
  requireForCheckout = false,
  onSaved,
  saveLabel,
  secondaryAction,
}: Props) {
  const toast = useToast();
  const [profile, setProfile] = useState<BillingProfile>(EMPTY_BILLING_PROFILE);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isAdmin, setIsAdmin] = useState(false);

  // companyAutoFilled / emailAutoFilled track whether the value in the
  // input came from the org/user identity (true) or from a saved
  // billing_profile row / admin typing (false). Auto-filled fields get
  // a `disabled` lock + helper hint so admins know where the value
  // comes from and that it's authoritative — to change them, they go
  // to Organization (rename) or Account (email), not the invoice form.
  const [companyAutoFilled, setCompanyAutoFilled] = useState(false);
  const [emailAutoFilled, setEmailAutoFilled] = useState(false);

  useEffect(() => {
    const u = getUser();
    setIsAdmin(u?.role === "admin");
    // The cached user blob from login may or may not carry orgName —
    // it depends on the auth response shape. /v1/me/profile is the
    // authoritative source: it always returns orgName and email. We
    // fetch both endpoints in parallel and overlay org/user identity
    // onto any blank required fields in the saved billing profile.
    // A profile that's already been saved keeps whatever the admin
    // typed previously; we only fill blanks.
    Promise.all([
      api<BillingProfile>("/v1/billing/profile").catch(
        () => EMPTY_BILLING_PROFILE,
      ),
      api<{ orgName: string; email: string }>("/v1/me/profile").catch(
        () => null,
      ),
    ])
      .then(([p, me]) => {
        const next: BillingProfile = { ...EMPTY_BILLING_PROFILE, ...p };
        const orgName = me?.orgName || u?.orgName || "";
        const userEmail = me?.email || u?.email || "";
        let prefilled = false;
        let companyAuto = false;
        let emailAuto = false;
        if (!next.companyName?.trim() && orgName) {
          next.companyName = orgName;
          prefilled = true;
          companyAuto = true;
        }
        if (!next.billingEmail?.trim() && userEmail) {
          next.billingEmail = userEmail;
          prefilled = true;
          emailAuto = true;
        }
        setProfile(next);
        setCompanyAutoFilled(companyAuto);
        setEmailAutoFilled(emailAuto);
        // Mark dirty so the admin sees the prefilled values aren't
        // persisted yet — clicking "Save" / "Save & continue" then
        // commits them. Without this the standalone settings form
        // would show "Up to date" while the database is actually
        // empty, which is misleading.
        if (prefilled) setDirty(true);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const update = (patch: Partial<BillingProfile>) => {
    setProfile((prev) => ({ ...prev, ...patch }));
    setDirty(true);
    // Clear any error for the fields being typed into so the admin
    // sees errors clear in real time, not just on the next save.
    const cleared = { ...errors };
    let touched = false;
    for (const k of Object.keys(patch)) {
      if (cleared[k]) {
        delete cleared[k];
        touched = true;
      }
    }
    if (touched) setErrors(cleared);
  };

  function validate(): boolean {
    if (!requireForCheckout) {
      setErrors({});
      return true;
    }
    const next: Record<string, string> = {};
    for (const k of REQUIRED_FOR_CHECKOUT) {
      if (!String(profile[k] ?? "").trim()) {
        next[k] = "Required for invoice";
      }
    }
    // Country is a 2-letter ISO code; nudge admins typing the full name.
    if (profile.country && profile.country.trim().length > 3) {
      next.country = "Use the 2-letter country code (IN, US, …)";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  const save = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const res = await api<BillingProfile>("/v1/billing/profile", {
        method: "PUT",
        body: JSON.stringify(profile),
      });
      const persisted = { ...EMPTY_BILLING_PROFILE, ...res };
      setProfile(persisted);
      setDirty(false);
      toast.show("success", "Billing details saved");
      onSaved?.(persisted);
    } catch (e: any) {
      toast.show("error", "Couldn't save billing details", {
        description: e?.message,
      });
    } finally {
      setSaving(false);
    }
  };

  const Body = (
    <>
      {!loaded ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Company / legal name"
              required={requireForCheckout}
              error={errors.companyName}
              hint={
                companyAutoFilled
                  ? "Pulled from your organization name. Rename the workspace to change."
                  : undefined
              }
            >
              <Input
                value={profile.companyName}
                // Lock when the value came from the org identity. The
                // admin can still rename the workspace via the team
                // page; we keep this field consistent with that source
                // of truth so an invoice never disagrees with the
                // org name shown elsewhere.
                disabled={!isAdmin || companyAutoFilled}
                placeholder="Acme Inc."
                onChange={(e) => update({ companyName: e.target.value })}
              />
            </Field>
            <Field
              label="Billing email"
              required={requireForCheckout}
              error={errors.billingEmail}
              hint={
                emailAutoFilled
                  ? "Your account email. Update it from Profile to change."
                  : undefined
              }
            >
              <Input
                type="email"
                value={profile.billingEmail}
                // Lock when auto-filled from the admin's own email.
                // We don't want a fat-fingered typo on a sensitive
                // delivery channel — provider receipts and dunning
                // notices go here. Account email changes happen on
                // the Profile page where the auth flow protects them.
                disabled={!isAdmin || emailAutoFilled}
                placeholder="ap@acme.com"
                onChange={(e) => update({ billingEmail: e.target.value })}
              />
            </Field>
            <Field label="Billing phone">
              <Input
                value={profile.billingPhone}
                disabled={!isAdmin}
                placeholder="+1 555 0100"
                onChange={(e) => update({ billingPhone: e.target.value })}
              />
            </Field>
            <Field label="Tax ID type">
              <Select
                value={profile.taxIdLabel || "__none"}
                disabled={!isAdmin}
                onValueChange={(v) =>
                  update({ taxIdLabel: v === "__none" ? "" : v })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">None</SelectItem>
                  {TAX_LABELS.map((l) => (
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
                onChange={(e) => update({ taxId: e.target.value })}
              />
            </Field>
          </div>

          <Separator />

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Address line 1"
              className="sm:col-span-2"
              required={requireForCheckout}
              error={errors.addressLine1}
            >
              <Input
                value={profile.addressLine1}
                disabled={!isAdmin}
                placeholder="221B Baker Street"
                onChange={(e) => update({ addressLine1: e.target.value })}
              />
            </Field>
            <Field label="Address line 2" className="sm:col-span-2">
              <Input
                value={profile.addressLine2}
                disabled={!isAdmin}
                placeholder="Suite, floor, etc."
                onChange={(e) => update({ addressLine2: e.target.value })}
              />
            </Field>
            <Field
              label="City"
              required={requireForCheckout}
              error={errors.city}
            >
              <Input
                value={profile.city}
                disabled={!isAdmin}
                onChange={(e) => update({ city: e.target.value })}
              />
            </Field>
            <Field label="State / region">
              <Input
                value={profile.region}
                disabled={!isAdmin}
                onChange={(e) => update({ region: e.target.value })}
              />
            </Field>
            <Field label="Postal code">
              <Input
                value={profile.postalCode}
                disabled={!isAdmin}
                onChange={(e) => update({ postalCode: e.target.value })}
              />
            </Field>
            <Field
              label="Country (ISO code)"
              required={requireForCheckout}
              error={errors.country}
            >
              <Input
                value={profile.country}
                disabled={!isAdmin}
                placeholder="IN, US, GB…"
                maxLength={80}
                onChange={(e) =>
                  update({ country: e.target.value.toUpperCase() })
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
              onChange={(e) => update({ notes: e.target.value })}
            />
          </Field>

          {isAdmin && (
            <div className="flex items-center justify-end gap-2 pt-1">
              <span className="mr-auto text-xs text-muted-foreground">
                {dirty ? "Unsaved changes" : "Up to date"}
              </span>
              {secondaryAction}
              <Button
                size="sm"
                onClick={save}
                disabled={saving || (!dirty && !requireForCheckout)}
              >
                {saving ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="mr-1 h-3.5 w-3.5" />
                )}
                {saving
                  ? "Saving…"
                  : saveLabel ||
                    (requireForCheckout ? "Save & continue" : "Save")}
              </Button>
            </div>
          )}
          {!isAdmin && (
            <p className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
              Only workspace admins can edit billing details. Members see
              the saved values but can't change them.
            </p>
          )}
        </div>
      )}
    </>
  );

  if (mode === "inline") return Body;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="h-4 w-4" />
            Organization details
          </CardTitle>
          <CardDescription>
            Company name, tax ID, and address that appear on every invoice.
            {!isAdmin && " Only admins can edit."}
          </CardDescription>
        </div>
        {profile.updatedAt && (
          <span className="whitespace-nowrap text-[11px] text-muted-foreground">
            Updated {new Date(profile.updatedAt).toLocaleDateString()}
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-4">{Body}</CardContent>
    </Card>
  );
}

function Field({
  label,
  required,
  error,
  hint,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  // Small grey helper line under the input. Used for "From your
  // organization profile — change there to update" notes on locked
  // identity fields. Hidden when an error is shown so the more
  // urgent message wins the slot.
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5 text-sm", className)}>
      <span className="text-xs font-medium text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </span>
      {children}
      {error ? (
        <span className="text-xs text-destructive">{error}</span>
      ) : hint ? (
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}
