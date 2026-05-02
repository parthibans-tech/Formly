// /admin/finance — the super-admin "Revenue & Expenses" P&L console.
//
// One page deliberately. Operators want a single scrollable surface
// when they're answering "are we making money this month?": KPI strip
// at the top, time series, then per-currency breakdowns, then the
// expense ledger they actually edit. Splitting overview vs ledger into
// two routes would force a tab-dance on every visit.
//
// Multi-currency notes
// --------------------
// We never sum across currencies — there is no FX layer. Every total
// is presented per currency, side by side. The headline KPI tiles
// repeat per-currency (one row per currency present in the data) so
// nothing gets silently rolled up into a fake "global total".
//
// MRR vs MRE
// ----------
// MRR comes from active/trialing/past_due subscriptions (yearly→/12).
// MRE is the operator-side mirror: recurring expense rows normalised
// the same way (yearly/12, quarterly/3, monthly as-is). The "Net
// recurring" tile subtracts them per currency so you instantly see
// whether the run-rate is positive.
//
// Edit surface
// ------------
// Inline expense CRUD lives at the bottom. Create dialog + per-row
// edit + soft-delete with confirm. Categories use a datalist of
// canonical buckets (infrastructure, payroll, software, marketing,
// payment_fees, taxes, legal, office, other) but accept anything the
// operator types — the dashboard re-aggregates by whatever lands.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Download,
  LineChart as LineChartIcon,
  Pencil,
  Plus,
  RefreshCcw,
  Trash2,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import {
  KpiTile,
  LineChart,
  TopList,
  formatCount,
  type LineSeries,
} from "@/components/admin-charts";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm";
import { api, getToken, API_URL } from "@/lib/api";
import { useToast } from "@/components/toast";

// ---------------------------------------------------------------------------
// API shapes — mirror platformfinance handlers.
// ---------------------------------------------------------------------------

type Money = { label: string; currency: string; cents: number };
type Counted = { label: string; count: number; cents: number };
type SeriesPoint = { bucket: string; revenueCents: number; expenseCents: number };
type NetRow = {
  currency: string;
  revenueCents: number;
  expenseCents: number;
  netCents: number;
  marginPercent: number;
};
type TopOrg = {
  orgId: string;
  orgName: string;
  currency: string;
  cents: number;
  invoices: number;
};
type TopVendor = {
  vendor: string;
  currency: string;
  cents: number;
  entries: number;
};
type RecentInvoice = {
  id: string;
  number: string;
  orgName: string;
  currency: string;
  cents: number;
  status: string;
  issuedAt: string;
};
type RecentExpense = {
  id: string;
  category: string;
  vendor: string;
  currency: string;
  cents: number;
  recurrence: string;
  occurredOn: string;
};

type Overview = {
  window: string;
  bucket: string;
  generated: string;
  revenueByCurrency: Money[];
  writeoffByCurrency: Money[];
  mrr: Money[];
  arr: Money[];
  subscriptionStates: Counted[];
  topPayingOrgs: TopOrg[];
  planMix: Money[];
  expenseByCurrency: Money[];
  mre: Money[];
  expenseByCategory: Money[];
  topVendors: TopVendor[];
  timeSeries: SeriesPoint[];
  netByCurrency: NetRow[];
  recentInvoices: RecentInvoice[];
  recentExpenses: RecentExpense[];
};

type Expense = {
  id: string;
  category: string;
  vendor: string;
  amountCents: number;
  currency: string;
  occurredOn: string;
  recurrence: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

type ExpensesResp = {
  expenses: Expense[];
  totals: { currency: string; cents: number }[];
};

const WINDOWS = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "180d", label: "180 days" },
  { value: "365d", label: "365 days" },
];

const CATEGORIES = [
  "infrastructure",
  "payroll",
  "software",
  "marketing",
  "payment_fees",
  "taxes",
  "legal",
  "office",
  "other",
];

const RECURRENCES = [
  { value: "one_time", label: "One-time" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
];

// formatMoney: cents → "₹12,345.67" / "$123.45" / "EUR 12.00".
// We only special-case the symbols we actually charge in (INR, USD);
// everything else falls back to the ISO code so a future region
// rollout doesn't render as "$$$".
function formatMoney(cents: number, currency: string): string {
  const v = cents / 100;
  const abs = Math.abs(v);
  const formatted = abs.toLocaleString(undefined, {
    minimumFractionDigits: abs >= 1000 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  const sign = v < 0 ? "-" : "";
  switch (currency.toUpperCase()) {
    case "INR":
      return `${sign}₹${formatted}`;
    case "USD":
      return `${sign}$${formatted}`;
    case "EUR":
      return `${sign}€${formatted}`;
    case "GBP":
      return `${sign}£${formatted}`;
    default:
      return `${sign}${currency.toUpperCase()} ${formatted}`;
  }
}

// Render a per-currency stack as one tile per currency. If the
// breakdown is empty we still render a placeholder so the row layout
// doesn't collapse on a fresh install.
function MoneyStack({
  rows,
  emptyLabel,
  className,
}: {
  rows: { currency: string; cents: number }[];
  emptyLabel: string;
  className?: string;
}) {
  if (rows.length === 0) {
    return (
      <div className={"text-sm text-muted-foreground " + (className ?? "")}>
        {emptyLabel}
      </div>
    );
  }
  return (
    <div className={"space-y-0.5 " + (className ?? "")}>
      {rows.map((r) => (
        <div key={r.currency} className="text-lg font-semibold tabular-nums">
          {formatMoney(r.cents, r.currency)}
          <span className="ml-1 text-[10px] font-normal text-muted-foreground">
            {r.currency}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function FinancePage() {
  const toast = useToast();
  const confirm = useConfirm();

  const [windowKey, setWindowKey] = useState<string>("30d");
  const [data, setData] = useState<Overview | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [expenseTotals, setExpenseTotals] = useState<
    { currency: string; cents: number }[]
  >([]);
  const [refreshing, setRefreshing] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  // Filters for the expense ledger.
  const [filter, setFilter] = useState({
    category: "",
    currency: "",
    recurrence: "",
    vendor: "",
  });

  // Dialog state — null = closed, "new" = create mode, Expense = edit.
  const [editing, setEditing] = useState<Expense | "new" | null>(null);

  const loadOverview = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await api<Overview>(
        `/v1/admin/finance/overview?window=${windowKey}`,
      );
      setData(r);
      setForbidden(false);
    } catch (e: any) {
      if (e?.status === 403) setForbidden(true);
      else
        toast.show("error", "Couldn't load finance overview", {
          description: e?.message,
        });
    } finally {
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowKey]);

  const loadExpenses = useCallback(async () => {
    const params = new URLSearchParams();
    if (filter.category) params.set("category", filter.category);
    if (filter.currency) params.set("currency", filter.currency);
    if (filter.recurrence) params.set("recurrence", filter.recurrence);
    if (filter.vendor) params.set("vendor", filter.vendor);
    try {
      const r = await api<ExpensesResp>(
        `/v1/admin/finance/expenses?${params.toString()}`,
      );
      setExpenses(r.expenses ?? []);
      setExpenseTotals(r.totals ?? []);
    } catch (e: any) {
      if (e?.status === 403) setForbidden(true);
      else
        toast.show("error", "Couldn't load expenses", {
          description: e?.message,
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter.category, filter.currency, filter.recurrence, filter.vendor]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);
  useEffect(() => {
    loadExpenses();
  }, [loadExpenses]);

  // Time series: revenue + expense as two LineSeries on the same x axis.
  const series: LineSeries[] = useMemo(() => {
    if (!data?.timeSeries?.length) return [];
    return [
      {
        name: "Revenue",
        color: "hsl(142, 70%, 45%)",
        data: data.timeSeries.map((p) => ({
          bucket: p.bucket,
          value: p.revenueCents / 100,
        })),
      },
      {
        name: "Expense",
        color: "hsl(0, 75%, 55%)",
        data: data.timeSeries.map((p) => ({
          bucket: p.bucket,
          value: p.expenseCents / 100,
        })),
      },
    ];
  }, [data?.timeSeries]);

  // Net recurring per currency: MRR - MRE. Built client-side because
  // neither table alone has both halves; we already have the per-
  // currency MRR + MRE arrays so a quick map merge is cheaper than a
  // dedicated server endpoint.
  const netRecurring = useMemo(() => {
    const m = new Map<string, { mrr: number; mre: number }>();
    for (const r of data?.mrr ?? [])
      m.set(r.currency, { mrr: r.cents, mre: 0 });
    for (const r of data?.mre ?? []) {
      const v = m.get(r.currency) ?? { mrr: 0, mre: 0 };
      v.mre = r.cents;
      m.set(r.currency, v);
    }
    return Array.from(m.entries()).map(([currency, v]) => ({
      currency,
      mrr: v.mrr,
      mre: v.mre,
      net: v.mrr - v.mre,
    }));
  }, [data?.mrr, data?.mre]);

  async function handleDelete(row: Expense) {
    const ok = await confirm({
      title: "Delete this expense?",
      description: `Soft-delete the ${formatMoney(
        row.amountCents,
        row.currency,
      )} ${row.category} entry from ${row.occurredOn}. The row stays in the audit trail and can be restored by a DBA.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/admin/finance/expenses/${row.id}`, { method: "DELETE" });
      toast.show("success", "Expense deleted");
      loadExpenses();
      loadOverview();
    } catch (e: any) {
      toast.show("error", "Delete failed", { description: e?.message });
    }
  }

  // CSV export hits /export.csv with the same window and the bearer
  // token glued onto the URL via fetch (the API client returns JSON
  // by default, so we drop down to fetch for the file download).
  function exportCSV() {
    const token = getToken();
    fetch(`${API_URL}/v1/admin/finance/export.csv?window=${windowKey}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => {
        if (!r.ok) throw new Error("Export failed");
        return r.blob();
      })
      .then((b) => {
        const url = URL.createObjectURL(b);
        const a = document.createElement("a");
        a.href = url;
        a.download = `formly-finance-${windowKey}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch((e) => toast.show("error", "Export failed", { description: e?.message }));
  }

  if (forbidden) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Super-admin only
          </CardTitle>
          <CardDescription>
            Revenue & expenses is restricted to platform operators.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header + window picker + actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <LineChartIcon className="h-6 w-6" /> Revenue &amp; expenses
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Per-currency P&amp;L across every workspace. Revenue from paid
            invoices, expenses from your operator-tracked ledger.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={windowKey} onValueChange={setWindowKey}>
            <SelectTrigger className="h-9 w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WINDOWS.map((w) => (
                <SelectItem key={w.value} value={w.value}>
                  Last {w.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={exportCSV}>
            <Download className="mr-1.5 h-4 w-4" /> CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              loadOverview();
              loadExpenses();
            }}
            disabled={refreshing}
          >
            <RefreshCcw
              className={"mr-1.5 h-4 w-4 " + (refreshing ? "animate-spin" : "")}
            />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="mr-1.5 h-4 w-4" /> New expense
          </Button>
        </div>
      </div>

      {/* Headline KPIs — per-currency stacks. Repeated for each
          currency present in the data so we never silently combine
          them into a fake "global total". */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {!data ? (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-md" />)
        ) : (
          <>
            <KpiTile
              label={`Revenue · last ${windowKey}`}
              value={
                <MoneyStack
                  rows={data.revenueByCurrency.map((r) => ({
                    currency: r.currency,
                    cents: r.cents,
                  }))}
                  emptyLabel="No paid invoices"
                />
              }
              sublabel={
                data.writeoffByCurrency.length > 0
                  ? `${data.writeoffByCurrency
                      .map((w) => formatMoney(w.cents, w.currency))
                      .join(" · ")} written off`
                  : "no write-offs in window"
              }
            />
            <KpiTile
              label={`Expense · last ${windowKey}`}
              value={
                <MoneyStack
                  rows={data.expenseByCurrency.map((r) => ({
                    currency: r.currency,
                    cents: r.cents,
                  }))}
                  emptyLabel="No expenses recorded"
                />
              }
              sublabel={`${expenses.length} ledger entries · ${data.expenseByCategory.length} categories`}
            />
            <KpiTile
              label="Net (revenue − expense)"
              value={
                <MoneyStack
                  rows={data.netByCurrency.map((r) => ({
                    currency: r.currency,
                    cents: r.netCents,
                  }))}
                  emptyLabel="—"
                />
              }
              sublabel={
                data.netByCurrency.length > 0 ? (
                  <span className="space-x-2">
                    {data.netByCurrency.map((r) => (
                      <span
                        key={r.currency}
                        className={
                          r.marginPercent >= 0
                            ? "text-emerald-600"
                            : "text-red-600"
                        }
                      >
                        {r.currency}: {r.marginPercent.toFixed(1)}%
                      </span>
                    ))}
                  </span>
                ) : (
                  "margin unavailable"
                )
              }
            />
            <KpiTile
              label="MRR · MRE · Net recurring"
              value={
                <MoneyStack
                  rows={netRecurring.map((r) => ({
                    currency: r.currency,
                    cents: r.net,
                  }))}
                  emptyLabel="No recurring activity"
                />
              }
              sublabel={
                netRecurring.length > 0
                  ? netRecurring
                      .map(
                        (r) =>
                          `${r.currency}: MRR ${formatMoney(
                            r.mrr,
                            r.currency,
                          )} − MRE ${formatMoney(r.mre, r.currency)}`,
                      )
                      .join(" · ")
                  : "—"
              }
            />
          </>
        )}
      </div>

      {/* Time series + per-currency net table */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Revenue vs expense</CardTitle>
            <CardDescription>
              Per {data?.bucket ?? "day"} totals, currency-collapsed for the
              trend. Per-currency split lives in the headline cards.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!data ? (
              <Skeleton className="h-[180px] w-full rounded" />
            ) : series.length === 0 ? (
              <div className="rounded border border-dashed bg-muted/20 p-6 text-center text-sm text-muted-foreground">
                No activity in the selected window yet.
              </div>
            ) : (
              <>
                <LineChart series={series} formatY={(v) => v.toLocaleString()} />
                <div className="mt-2 flex items-center gap-4 text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-[hsl(142,70%,45%)]" />
                    Revenue
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-[hsl(0,75%,55%)]" />
                    Expense
                  </span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Per currency</CardTitle>
            <CardDescription>Revenue, expense, net, margin.</CardDescription>
          </CardHeader>
          <CardContent>
            {!data ? (
              <Skeleton className="h-32 w-full rounded" />
            ) : data.netByCurrency.length === 0 ? (
              <div className="rounded border border-dashed bg-muted/20 p-6 text-center text-xs text-muted-foreground">
                Nothing yet — add a paid invoice or expense.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1 font-medium">CCY</th>
                      <th className="py-1 text-right font-medium">Revenue</th>
                      <th className="py-1 text-right font-medium">Expense</th>
                      <th className="py-1 text-right font-medium">Net</th>
                      <th className="py-1 text-right font-medium">Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.netByCurrency.map((r) => (
                      <tr key={r.currency} className="border-t">
                        <td className="py-1.5 font-mono">{r.currency}</td>
                        <td className="py-1.5 text-right tabular-nums">
                          {formatMoney(r.revenueCents, r.currency)}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {formatMoney(r.expenseCents, r.currency)}
                        </td>
                        <td
                          className={
                            "py-1.5 text-right tabular-nums " +
                            (r.netCents >= 0 ? "text-emerald-600" : "text-red-600")
                          }
                        >
                          {formatMoney(r.netCents, r.currency)}
                        </td>
                        <td
                          className={
                            "py-1.5 text-right tabular-nums " +
                            (r.marginPercent >= 0
                              ? "text-emerald-600"
                              : "text-red-600")
                          }
                        >
                          {r.marginPercent.toFixed(1)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Sub-section row: top paying orgs, top vendors, expense by category */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-4 w-4 text-emerald-600" /> Top paying orgs
            </CardTitle>
            <CardDescription>Last {windowKey} · paid invoices.</CardDescription>
          </CardHeader>
          <CardContent>
            {!data ? (
              <Skeleton className="h-32 w-full rounded" />
            ) : (
              <TopList
                items={(data.topPayingOrgs ?? []).map((o) => ({
                  id: o.orgId,
                  label: o.orgName || "(unnamed org)",
                  value: o.cents,
                  sub: `${o.invoices} invoice${o.invoices === 1 ? "" : "s"} · ${o.currency}`,
                }))}
                formatV={(v) => formatMoney(v, data.topPayingOrgs[0]?.currency ?? "INR")}
                href={(id) => `/admin/orgs/${id}/analytics`}
                emptyLabel="No paid invoices in window."
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingDown className="h-4 w-4 text-red-600" /> Top vendors
            </CardTitle>
            <CardDescription>Largest expense recipients in window.</CardDescription>
          </CardHeader>
          <CardContent>
            {!data ? (
              <Skeleton className="h-32 w-full rounded" />
            ) : (
              <TopList
                items={(data.topVendors ?? []).map((v) => ({
                  label: v.vendor,
                  value: v.cents,
                  sub: `${v.entries} entr${v.entries === 1 ? "y" : "ies"} · ${v.currency}`,
                }))}
                formatV={(v) =>
                  formatMoney(v, data.topVendors[0]?.currency ?? "INR")
                }
                emptyLabel="No vendor expenses in window."
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Wallet className="h-4 w-4" /> Expense by category
            </CardTitle>
            <CardDescription>Per-currency, in window.</CardDescription>
          </CardHeader>
          <CardContent>
            {!data ? (
              <Skeleton className="h-32 w-full rounded" />
            ) : (
              <TopList
                items={(data.expenseByCategory ?? []).map((c) => ({
                  label: c.label,
                  value: c.cents,
                  sub: c.currency,
                }))}
                formatV={(v) =>
                  formatMoney(v, data.expenseByCategory[0]?.currency ?? "INR")
                }
                emptyLabel="No expenses recorded yet."
              />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Subscription state + plan mix — light-touch revenue context. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Subscription states</CardTitle>
            <CardDescription>
              A spike in past_due tends to lead a revenue dip.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2 text-sm">
            {!data ? (
              <Skeleton className="h-16 w-full rounded" />
            ) : data.subscriptionStates.length === 0 ? (
              <span className="text-muted-foreground">No subscriptions yet.</span>
            ) : (
              data.subscriptionStates.map((s) => (
                <Badge
                  key={s.label}
                  variant="outline"
                  className={
                    s.label === "active" || s.label === "trialing"
                      ? "border-emerald-500/40 text-emerald-700"
                      : s.label === "past_due"
                        ? "border-amber-500/40 text-amber-700"
                        : "border-muted-foreground/40"
                  }
                >
                  {s.label} · {formatCount(s.count)}
                </Badge>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Plan-tier revenue mix</CardTitle>
            <CardDescription>Paid invoices in window, by plan tier.</CardDescription>
          </CardHeader>
          <CardContent>
            {!data ? (
              <Skeleton className="h-32 w-full rounded" />
            ) : (
              <TopList
                items={(data.planMix ?? []).map((p) => ({
                  label: p.label || "unknown",
                  value: p.cents,
                  sub: p.currency,
                }))}
                formatV={(v) => formatMoney(v, data.planMix[0]?.currency ?? "INR")}
                emptyLabel="No paid invoices yet."
              />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Expense ledger — the actual edit surface. */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <CardTitle className="text-base">Expense ledger</CardTitle>
              <CardDescription>
                Operator-tracked rows. Totals at the bottom respect the active
                filters.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                placeholder="vendor"
                value={filter.vendor}
                onChange={(e) => setFilter({ ...filter, vendor: e.target.value })}
                className="h-8 w-32"
              />
              <Select
                value={filter.category || "__all"}
                onValueChange={(v) =>
                  setFilter({ ...filter, category: v === "__all" ? "" : v })
                }
              >
                <SelectTrigger className="h-8 w-[140px]">
                  <SelectValue placeholder="category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">All categories</SelectItem>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={filter.recurrence || "__all"}
                onValueChange={(v) =>
                  setFilter({ ...filter, recurrence: v === "__all" ? "" : v })
                }
              >
                <SelectTrigger className="h-8 w-[140px]">
                  <SelectValue placeholder="recurrence" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">All cadences</SelectItem>
                  {RECURRENCES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={filter.currency || "__all"}
                onValueChange={(v) =>
                  setFilter({ ...filter, currency: v === "__all" ? "" : v })
                }
              >
                <SelectTrigger className="h-8 w-[100px]">
                  <SelectValue placeholder="currency" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">All CCY</SelectItem>
                  <SelectItem value="INR">INR</SelectItem>
                  <SelectItem value="USD">USD</SelectItem>
                  <SelectItem value="EUR">EUR</SelectItem>
                  <SelectItem value="GBP">GBP</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="py-1 font-medium">Date</th>
                  <th className="py-1 font-medium">Category</th>
                  <th className="py-1 font-medium">Vendor</th>
                  <th className="py-1 font-medium">Cadence</th>
                  <th className="py-1 text-right font-medium">Amount</th>
                  <th className="py-1 font-medium">Notes</th>
                  <th className="py-1 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {expenses.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="py-6 text-center text-xs text-muted-foreground"
                    >
                      No expense rows match the current filters.
                    </td>
                  </tr>
                ) : (
                  expenses.map((row) => (
                    <tr key={row.id} className="border-t">
                      <td className="py-1.5 font-mono text-xs">
                        {row.occurredOn}
                      </td>
                      <td className="py-1.5">{row.category}</td>
                      <td className="py-1.5">
                        {row.vendor || (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-1.5">
                        <Badge
                          variant="outline"
                          className={
                            row.recurrence === "one_time"
                              ? "border-muted-foreground/30"
                              : "border-blue-500/40 text-blue-700"
                          }
                        >
                          {row.recurrence}
                        </Badge>
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatMoney(row.amountCents, row.currency)}
                      </td>
                      <td className="max-w-[260px] truncate py-1.5 text-xs text-muted-foreground">
                        {row.notes}
                      </td>
                      <td className="py-1.5 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2"
                          onClick={() => setEditing(row)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-red-600 hover:text-red-700"
                          onClick={() => handleDelete(row)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {expenseTotals.length > 0 && (
                <tfoot>
                  <tr className="border-t bg-muted/30 text-sm">
                    <td colSpan={4} className="py-2 font-medium">
                      Filtered totals
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex flex-col items-end">
                        {expenseTotals.map((t) => (
                          <span
                            key={t.currency}
                            className="font-semibold tabular-nums"
                          >
                            {formatMoney(t.cents, t.currency)}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Recent activity feed — invoices on the left, expenses on the
          right. Keeps the operator's "what just happened" answer one
          scroll away from the headline. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Recent invoices</CardTitle>
            <CardDescription>Latest 8 across every workspace.</CardDescription>
          </CardHeader>
          <CardContent>
            {!data ? (
              <Skeleton className="h-32 w-full rounded" />
            ) : data.recentInvoices.length === 0 ? (
              <div className="rounded border border-dashed bg-muted/20 p-4 text-center text-xs text-muted-foreground">
                No invoices yet.
              </div>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {data.recentInvoices.map((i) => (
                  <li
                    key={i.id}
                    className="flex items-baseline justify-between gap-2 border-b pb-1.5 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {i.number || i.id.slice(0, 8)}{" "}
                        <span className="font-normal text-muted-foreground">
                          · {i.orgName}
                        </span>
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {new Date(i.issuedAt).toLocaleString()} · {i.status}
                      </div>
                    </div>
                    <div className="tabular-nums">
                      {formatMoney(i.cents, i.currency)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Recent expenses</CardTitle>
            <CardDescription>Latest 8 ledger entries.</CardDescription>
          </CardHeader>
          <CardContent>
            {!data ? (
              <Skeleton className="h-32 w-full rounded" />
            ) : data.recentExpenses.length === 0 ? (
              <div className="rounded border border-dashed bg-muted/20 p-4 text-center text-xs text-muted-foreground">
                No expenses yet.
              </div>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {data.recentExpenses.map((x) => (
                  <li
                    key={x.id}
                    className="flex items-baseline justify-between gap-2 border-b pb-1.5 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {x.category}
                        {x.vendor ? (
                          <span className="font-normal text-muted-foreground">
                            {" "}
                            · {x.vendor}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {x.occurredOn} · {x.recurrence}
                      </div>
                    </div>
                    <div className="tabular-nums">
                      {formatMoney(x.cents, x.currency)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Create / edit dialog */}
      <ExpenseDialog
        open={editing !== null}
        initial={editing === "new" ? null : (editing as Expense | null)}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          loadExpenses();
          loadOverview();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExpenseDialog — create + edit share one form. Validation matches
// validateUpsert on the server so the API rarely says no.
// ---------------------------------------------------------------------------

function ExpenseDialog({
  open,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: Expense | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  // Form state — money handled in dollars for input, converted to
  // cents on submit. Keeps the UX natural ("12.50" not "1250").
  const [form, setForm] = useState({
    category: "",
    vendor: "",
    amount: "",
    currency: "INR",
    occurredOn: "",
    recurrence: "one_time",
    notes: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setForm({
        category: initial.category,
        vendor: initial.vendor,
        amount: (initial.amountCents / 100).toFixed(2),
        currency: initial.currency,
        occurredOn: initial.occurredOn,
        recurrence: initial.recurrence,
        notes: initial.notes,
      });
    } else {
      const today = new Date().toISOString().slice(0, 10);
      setForm({
        category: "",
        vendor: "",
        amount: "",
        currency: "INR",
        occurredOn: today,
        recurrence: "one_time",
        notes: "",
      });
    }
  }, [open, initial]);

  async function submit() {
    const amt = parseFloat(form.amount);
    if (!form.category.trim()) {
      toast.show("error", "Category is required");
      return;
    }
    if (!Number.isFinite(amt) || amt < 0) {
      toast.show("error", "Amount must be a non-negative number");
      return;
    }
    setSaving(true);
    try {
      const body = JSON.stringify({
        category: form.category.trim(),
        vendor: form.vendor.trim(),
        amountCents: Math.round(amt * 100),
        currency: form.currency.trim().toUpperCase(),
        occurredOn: form.occurredOn,
        recurrence: form.recurrence,
        notes: form.notes,
      });
      if (initial) {
        await api(`/v1/admin/finance/expenses/${initial.id}`, {
          method: "PATCH",
          body,
        });
        toast.show("success", "Expense updated");
      } else {
        await api(`/v1/admin/finance/expenses`, { method: "POST", body });
        toast.show("success", "Expense added");
      }
      onSaved();
    } catch (e: any) {
      toast.show("error", "Save failed", { description: e?.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {initial ? "Edit expense" : "New expense"}
          </DialogTitle>
          <DialogDescription>
            Operator-tracked entry. Recurring rows roll up into MRE.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="exp-category" className="text-xs">
                Category
              </Label>
              <Input
                id="exp-category"
                list="exp-cat-list"
                placeholder="e.g. infrastructure"
                value={form.category}
                onChange={(e) =>
                  setForm({ ...form, category: e.target.value })
                }
              />
              <datalist id="exp-cat-list">
                {CATEGORIES.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
            <div>
              <Label htmlFor="exp-vendor" className="text-xs">
                Vendor
              </Label>
              <Input
                id="exp-vendor"
                placeholder="e.g. AWS"
                value={form.vendor}
                onChange={(e) => setForm({ ...form, vendor: e.target.value })}
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Label htmlFor="exp-amount" className="text-xs">
                Amount
              </Label>
              <Input
                id="exp-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="exp-currency" className="text-xs">
                Currency
              </Label>
              <Select
                value={form.currency}
                onValueChange={(v) => setForm({ ...form, currency: v })}
              >
                <SelectTrigger id="exp-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="INR">INR</SelectItem>
                  <SelectItem value="USD">USD</SelectItem>
                  <SelectItem value="EUR">EUR</SelectItem>
                  <SelectItem value="GBP">GBP</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="exp-date" className="text-xs">
                Occurred on
              </Label>
              <Input
                id="exp-date"
                type="date"
                value={form.occurredOn}
                onChange={(e) =>
                  setForm({ ...form, occurredOn: e.target.value })
                }
              />
            </div>
            <div>
              <Label htmlFor="exp-rec" className="text-xs">
                Recurrence
              </Label>
              <Select
                value={form.recurrence}
                onValueChange={(v) => setForm({ ...form, recurrence: v })}
              >
                <SelectTrigger id="exp-rec">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECURRENCES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="exp-notes" className="text-xs">
              Notes
            </Label>
            <Input
              id="exp-notes"
              placeholder="Optional"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : initial ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
