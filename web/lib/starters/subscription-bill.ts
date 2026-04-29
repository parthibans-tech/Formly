import type { Starter } from "./types";

export const subscriptionBillStarter: Starter = {
  id: "subscription-bill",
  name: "Subscription billing",
  description:
    "Recurring SaaS subscription invoice with plan, seats, prorations, and next-renewal block.",
  category: "Billing",
  tags: ["subscription", "saas", "recurring"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Subscription invoice {{ .invoice.number }}</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; color: #0f172a; padding: 48px; max-width: 820px; margin: auto; line-height: 1.5; }
    .head { display: flex; justify-content: space-between; padding-bottom: 14px; border-bottom: 1px solid #e2e8f0; }
    .brand { font-weight: 800; font-size: 22px; color: #7c3aed; letter-spacing: -.01em; }
    h1 { margin: 0; font-size: 24px; letter-spacing: -.01em; }
    .muted { color: #64748b; font-size: 13px; }
    .pill { display: inline-block; background: #ede9fe; color: #6d28d9; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; margin-left: 8px; vertical-align: 2px; }
    .plan { display: grid; grid-template-columns: 1.4fr 1fr; gap: 18px; margin-top: 24px; align-items: stretch; }
    .plan-card { padding: 22px 24px; border-radius: 14px; background: linear-gradient(135deg, #7c3aed, #6d28d9); color: white; }
    .plan-card .label { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: #ddd6fe; font-weight: 700; }
    .plan-card .name { font-size: 24px; font-weight: 800; letter-spacing: -.01em; margin-top: 4px; }
    .plan-card .seats { color: #ddd6fe; font-size: 13px; margin-top: 4px; }
    .plan-card .price { font-size: 30px; font-weight: 800; letter-spacing: -.02em; margin-top: 18px; line-height: 1; }
    .plan-card .price small { font-size: 13px; color: #ddd6fe; font-weight: 500; }
    .plan-card .next { color: #ddd6fe; font-size: 12px; margin-top: 8px; }
    .meta { padding: 20px 22px; border-radius: 14px; border: 1px solid #e2e8f0; font-size: 13px; }
    .meta .row { display: flex; justify-content: space-between; padding: 6px 0; }
    .meta .row b { color: #0f172a; font-weight: 600; }
    .meta .row.muted { color: #64748b; }
    h2 { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #64748b; margin: 28px 0 8px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-align: left; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; font-weight: 700; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    tfoot td { font-weight: 700; border-bottom: 0; padding-top: 12px; }
    tfoot .grand { font-size: 16px; }
    .renewal { margin-top: 26px; padding: 16px 18px; border-radius: 10px; background: #f8fafc; border-left: 4px solid #7c3aed; font-size: 13px; }
    .renewal b { color: #0f172a; }
  </style>
</head>
<body>
  <div class="head">
    <div>
      <div class="brand">{{ .vendor.name }}</div>
      <div class="muted">Invoice {{ .invoice.number }} · {{ .invoice.issuedAt | formatDate "Jan 2, 2006" }}</div>
    </div>
    <div style="text-align: right;">
      <h1>Subscription <span class="pill">Active</span></h1>
      <div class="muted">{{ .customer.name }} · {{ .customer.email }}</div>
    </div>
  </div>

  <div class="plan">
    <div class="plan-card">
      <div class="label">Current plan</div>
      <div class="name">{{ .plan.name }}</div>
      <div class="seats">{{ .plan.seats }} seats · billed {{ .plan.cycle }}</div>
      <div class="price">{{ .plan.price | formatCurrency "USD" }}<small> / {{ .plan.cycle }}</small></div>
      <div class="next">Next charge {{ .plan.nextChargeAt | formatDate "Jan 2, 2006" }}</div>
    </div>
    <div class="meta">
      <div class="row"><span class="muted">Started</span><b>{{ .plan.startedAt | formatDate "Jan 2, 2006" }}</b></div>
      <div class="row"><span class="muted">Period</span><b>{{ .invoice.start | formatDate "Jan 2" }} – {{ .invoice.end | formatDate "Jan 2, 2006" }}</b></div>
      <div class="row"><span class="muted">Payment</span><b>{{ .payment.method }}</b></div>
      <div class="row"><span class="muted">Status</span><b style="color: #16a34a;">Paid</b></div>
    </div>
  </div>

  <h2>This invoice</h2>
  <table>
    <thead><tr><th>Item</th><th>Period</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead>
    <tbody>
      {{ range .lineItems }}
      <tr>
        <td>
          <div style="font-weight: 600;">{{ .name }}</div>
          {{ if .detail }}<div style="font-size: 12px; color: #64748b;">{{ .detail }}</div>{{ end }}
        </td>
        <td class="muted">{{ .period }}</td>
        <td class="num">{{ .qty }}</td>
        <td class="num">{{ .amount | formatCurrency "USD" }}</td>
      </tr>
      {{ end }}
    </tbody>
    <tfoot>
      <tr><td colspan="3" class="num muted">Subtotal</td><td class="num">{{ .totals.subtotal | formatCurrency "USD" }}</td></tr>
      {{ if .totals.discount }}
      <tr><td colspan="3" class="num muted">Discount ({{ .totals.discountLabel }})</td><td class="num">−{{ .totals.discount | formatCurrency "USD" }}</td></tr>
      {{ end }}
      <tr><td colspan="3" class="num muted">Tax</td><td class="num">{{ .totals.tax | formatCurrency "USD" }}</td></tr>
      <tr class="grand"><td colspan="3" class="num">Total charged</td><td class="num">{{ .totals.total | formatCurrency "USD" }}</td></tr>
    </tfoot>
  </table>

  <div class="renewal">
    <b>Auto-renewal.</b> Your {{ .plan.name }} subscription will renew on
    <b>{{ .plan.nextChargeAt | formatDate "Jan 2, 2006" }}</b> for
    <b>{{ .plan.price | formatCurrency "USD" }}</b>. Manage your plan or cancel anytime
    at <b>{{ .vendor.portal }}</b>.
  </div>
</body>
</html>
`,
  sampleData: {
    vendor: { name: "Lumen Health Pro", portal: "billing.lumenhealth.example" },
    customer: { name: "Northwind Partners", email: "ap@northwind.example" },
    invoice: {
      number: "INV-SUB-2026-0418",
      issuedAt: "2026-04-22",
      start: "2026-04-22",
      end: "2026-05-22",
    },
    plan: {
      name: "Team — Annual",
      seats: 24,
      cycle: "month",
      price: 720,
      startedAt: "2025-08-01",
      nextChargeAt: "2026-05-22",
    },
    lineItems: [
      { name: "Team plan — base", detail: "Up to 25 seats, 12-month commitment", period: "Apr 22 – May 22", qty: 1, amount: 720 },
      { name: "Additional seats", detail: "Prorated for 4 seats added Apr 14", period: "Apr 14 – May 22", qty: 4, amount: 96 },
      { name: "Compliance add-on", detail: "HIPAA BAA + audit logs", period: "Apr 22 – May 22", qty: 1, amount: 99 },
    ],
    totals: { subtotal: 915, discount: 91.5, discountLabel: "Annual 10%", tax: 65.86, total: 889.36 },
    payment: { method: "Visa •••• 4421 (auto-pay)" },
  },
};
