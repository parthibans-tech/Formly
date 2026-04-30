"use client";

// /settings/organization/edit — dedicated page for the company name /
// tax ID / billing address that prints on every invoice. Lives on its
// own route so the Organization page stays a quick at-a-glance view
// (identity, plan, invoices) and the long form is opt-in.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BillingDetailsForm } from "@/components/billing-details-form";
import { getUser } from "@/lib/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ShieldAlert } from "lucide-react";

export default function EditOrganizationDetails() {
  const router = useRouter();
  const cachedUser = typeof window !== "undefined" ? getUser() : null;
  const isAdmin = cachedUser?.role === "admin";
  // Personal-workspace gate. Cached user blob is sync (no flash) and
  // the kind doesn't change without a re-login or org switch, so a
  // single read is enough — no /me/profile re-fetch needed here.
  const isPersonal = cachedUser?.orgKind === "personal";
  const pageTitle = isPersonal
    ? "Workspace details"
    : "Organization details";

  // Non-admins see a friendly explanation rather than a disabled form
  // they can't actually save. Mirrors the read-only branch on the
  // Organization page.
  if (!isAdmin) {
    return (
      <>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Building2 className="h-6 w-6" />
            {pageTitle}
          </h1>
          <p className="text-sm text-muted-foreground">
            Company name, tax ID, and billing address that print on every
            invoice.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldAlert className="h-4 w-4 text-amber-600" />
              Admin only
            </CardTitle>
            <CardDescription>
              Only workspace admins can edit organization details. Ask
              your admin to update them on your behalf.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild size="sm" variant="outline">
              <Link href="/settings/organization">
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to {isPersonal ? "Workspace" : "Organization"}
              </Link>
            </Button>
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Building2 className="h-6 w-6" />
            {pageTitle}
          </h1>
          <p className="text-sm text-muted-foreground">
            Company name, tax ID, and billing address that print on every
            invoice. Saved values are reused automatically when you
            upgrade your plan.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          onClick={() => router.push("/settings/organization")}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Button>
      </div>

      {/* Standalone (default "card") mode of the shared form — same
          PUT /v1/billing/profile under the hood that the inline
          checkout flow uses, so changes propagate everywhere. */}
      <BillingDetailsForm />
    </>
  );
}
