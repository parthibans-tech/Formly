"use client";

// Super-admin plan catalog editor.
//
// Org admins land on /settings/billing and see whatever rows the platform
// operator publishes here. Inserting a new row, flipping `active`, or
// changing `amountCents` ripples to the storefront immediately — no
// deploy needed. Subscriptions FK to plan.id, so deletes are a soft
// `active = false` flip; the row stays so existing invoices still resolve.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CreditCard,
  Pencil,
  Plus,
  RefreshCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

type Plan = {
  id: string;
  name: string;
  description: string;
  tier: "free" | "pro" | "enterprise";
  currency: "INR" | "USD";
  interval: "month" | "year" | "none";
  amountCents?: number | null;
  maxUsers?: number | null;
  maxStorageBytes?: number | null;
  features: Record<string, any>;
  sortOrder: number;
  active: boolean;
};

const EMPTY: Plan = {
  id: "",
  name: "",
  description: "",
  tier: "pro",
  currency: "INR",
  interval: "month",
  amountCents: 0,
  maxUsers: null,
  maxStorageBytes: null,
  features: {},
  sortOrder: 100,
  active: true,
};

function formatMoney(cents?: number | null, currency = "INR") {
  if (cents == null) return "—";
  const value = cents / 100;
  try {
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency} ${value}`;
  }
}

function formatBytes(b?: number | null) {
  if (b == null) return "Unlimited";
  if (b === 0) return "0";
  const k = 1024;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return `${(b / Math.pow(k, i)).toFixed(0)} ${units[i]}`;
}

export default function AdminBillingPlansPage() {
  const toast = useToast();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await api<{ plans: Plan[] }>("/v1/admin/plans");
      setPlans(res.plans || []);
      setForbidden(false);
    } catch (e: any) {
      if (e?.status === 403) {
        setForbidden(true);
        setPlans([]);
      } else {
        toast.show("error", "Couldn't load plans", { description: e?.message });
        setPlans([]);
      }
    } finally {
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const startCreate = () => {
    setCreating(true);
    setEditing({ ...EMPTY, id: "" });
  };

  const startEdit = (p: Plan) => {
    setCreating(false);
    setEditing({ ...p });
  };

  const cancel = () => {
    setEditing(null);
    setCreating(false);
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const path = creating
        ? "/v1/admin/plans"
        : `/v1/admin/plans/${encodeURIComponent(editing.id)}`;
      await api(path, {
        method: creating ? "POST" : "PUT",
        body: JSON.stringify(editing),
      });
      toast.show("success", creating ? "Plan created" : "Plan updated");
      setEditing(null);
      setCreating(false);
      await load();
    } catch (e: any) {
      toast.show("error", "Couldn't save plan", { description: e?.message });
    } finally {
      setSaving(false);
    }
  };

  const archive = async (p: Plan) => {
    if (
      !confirm(
        `Archive "${p.name}"? Existing subscriptions stay; the plan disappears from the storefront.`
      )
    ) {
      return;
    }
    try {
      await api(`/v1/admin/plans/${encodeURIComponent(p.id)}`, {
        method: "DELETE",
      });
      toast.show("success", "Plan archived");
      await load();
    } catch (e: any) {
      toast.show("error", "Couldn't archive plan", {
        description: e?.message,
      });
    }
  };

  const groups = useMemo(() => {
    const out: Record<string, Plan[]> = { active: [], archived: [] };
    (plans || []).forEach((p) => {
      out[p.active ? "active" : "archived"].push(p);
    });
    return out;
  }, [plans]);

  if (forbidden) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Super-admin only
          </CardTitle>
          <CardDescription>
            The plan catalog is restricted to platform operators.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <CreditCard className="h-6 w-6" />
            Billing & plans
          </h1>
          <p className="text-sm text-muted-foreground">
            Plans you publish here are what every org sees on{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              /settings/billing
            </code>
            . Active rows show on the storefront in <code>sortOrder</code>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={load}
            disabled={refreshing}
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            Refresh
          </Button>
          <Button size="sm" className="h-8" onClick={startCreate}>
            <Plus className="h-3.5 w-3.5" />
            New plan
          </Button>
        </div>
      </div>

      {editing && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {creating ? "Create plan" : `Edit "${editing.name || editing.id}"`}
            </CardTitle>
            <CardDescription>
              Plan ID is the immutable key referenced by subscriptions; once
              picked, don&apos;t change it. Use sortOrder to control storefront
              order.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Plan ID">
                <Input
                  value={editing.id}
                  disabled={!creating}
                  placeholder="pro_inr_monthly"
                  onChange={(e) =>
                    setEditing({ ...editing, id: e.target.value })
                  }
                />
              </Field>
              <Field label="Display name">
                <Input
                  value={editing.name}
                  onChange={(e) =>
                    setEditing({ ...editing, name: e.target.value })
                  }
                  placeholder="Pro (Monthly)"
                />
              </Field>
              <Field label="Tier">
                <Select
                  value={editing.tier}
                  onValueChange={(v) =>
                    setEditing({ ...editing, tier: v as Plan["tier"] })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="free">Free</SelectItem>
                    <SelectItem value="pro">Pro</SelectItem>
                    <SelectItem value="enterprise">Enterprise</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Currency">
                <Select
                  value={editing.currency}
                  onValueChange={(v) =>
                    setEditing({ ...editing, currency: v as Plan["currency"] })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="INR">INR (₹)</SelectItem>
                    <SelectItem value="USD">USD ($)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Interval">
                <Select
                  value={editing.interval}
                  onValueChange={(v) =>
                    setEditing({ ...editing, interval: v as Plan["interval"] })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="month">Monthly</SelectItem>
                    <SelectItem value="year">Yearly</SelectItem>
                    <SelectItem value="none">None (free / contact)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Sort order">
                <Input
                  type="number"
                  value={editing.sortOrder}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      sortOrder: Number(e.target.value) || 0,
                    })
                  }
                />
              </Field>
              <Field label="Amount (cents) — leave blank for 'contact us'">
                <Input
                  type="number"
                  value={editing.amountCents ?? ""}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      amountCents:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                  placeholder="49900 = ₹499 / $499"
                />
              </Field>
              <Field label="Max users (blank = unlimited)">
                <Input
                  type="number"
                  value={editing.maxUsers ?? ""}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      maxUsers:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </Field>
              <Field label="Max storage bytes (blank = unlimited)">
                <Input
                  type="number"
                  value={editing.maxStorageBytes ?? ""}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      maxStorageBytes:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                  placeholder="10737418240 = 10 GB"
                />
              </Field>
              <Field label="Active" className="sm:col-span-2">
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={editing.active}
                    onChange={(e) =>
                      setEditing({ ...editing, active: e.target.checked })
                    }
                    className="h-4 w-4"
                  />
                  <span className="text-muted-foreground">
                    Show on storefront
                  </span>
                </label>
              </Field>
            </div>

            <Field label="Description">
              <textarea
                className="flex min-h-[64px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={editing.description}
                placeholder="One-line marketing pitch shown under the plan name."
                onChange={(e) =>
                  setEditing({ ...editing, description: e.target.value })
                }
                maxLength={500}
              />
            </Field>

            <Field label="Features (JSON)">
              <textarea
                className="font-mono flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={JSON.stringify(editing.features, null, 2)}
                onChange={(e) => {
                  try {
                    const v = JSON.parse(e.target.value || "{}");
                    setEditing({ ...editing, features: v });
                  } catch {
                    // leave as-is — user is mid-typing
                  }
                }}
              />
            </Field>

            <Separator />
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={cancel}>
                <X className="mr-1 h-3.5 w-3.5" />
                Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={saving}>
                <Save className="mr-1 h-3.5 w-3.5" />
                {saving ? "Saving…" : creating ? "Create plan" : "Save changes"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <PlanList
        title="Active plans"
        plans={groups.active}
        loading={!plans}
        onEdit={startEdit}
        onArchive={archive}
      />

      {groups.archived.length > 0 && (
        <PlanList
          title="Archived"
          plans={groups.archived}
          loading={false}
          onEdit={startEdit}
          onArchive={undefined}
          muted
        />
      )}
    </div>
  );
}

function PlanList({
  title,
  plans,
  loading,
  onEdit,
  onArchive,
  muted,
}: {
  title: string;
  plans: Plan[];
  loading: boolean;
  onEdit: (p: Plan) => void;
  onArchive?: (p: Plan) => void;
  muted?: boolean;
}) {
  return (
    <Card className={cn(muted && "opacity-80")}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{plans.length} row(s)</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : plans.length === 0 ? (
          <div className="grid place-items-center gap-2 p-10 text-center text-sm text-muted-foreground">
            No plans here.
          </div>
        ) : (
          <ul className="divide-y text-sm">
            {plans.map((p) => (
              <li
                key={`${p.id}-${p.currency}`}
                className="flex flex-wrap items-center gap-3 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {p.tier}
                    </Badge>
                    <Badge variant="outline" className="text-[10px]">
                      {p.currency}
                    </Badge>
                    <Badge variant="outline" className="text-[10px]">
                      {p.interval}
                    </Badge>
                    {!p.active && (
                      <Badge variant="secondary" className="text-[10px]">
                        archived
                      </Badge>
                    )}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    {p.id}
                  </div>
                  {p.description && (
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {p.description}
                    </div>
                  )}
                </div>
                <div className="grid gap-x-6 gap-y-0.5 text-right text-xs sm:grid-cols-3">
                  <div>
                    <div className="text-muted-foreground">Price</div>
                    <div className="font-medium">
                      {formatMoney(p.amountCents, p.currency)}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Users</div>
                    <div className="font-medium">
                      {p.maxUsers ?? "Unlimited"}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Storage</div>
                    <div className="font-medium">
                      {formatBytes(p.maxStorageBytes)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8"
                    onClick={() => onEdit(p)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  {onArchive && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 text-destructive hover:text-destructive"
                      onClick={() => onArchive(p)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
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
