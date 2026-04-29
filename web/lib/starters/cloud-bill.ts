import type { Starter } from "./types";

export const cloudBillStarter: Starter = {
  id: "cloud-bill",
  name: "Cloud / SaaS billing",
  description:
    "Usage-based cloud bill with metered services, breakdown by product, and credits applied.",
  category: "Billing",
  tags: ["cloud", "saas", "usage", "metered"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Cloud bill — {{ .invoice.period }}</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; color: #0f172a; padding: 48px; max-width: 820px; margin: auto; line-height: 1.5; background: #fff; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 16px; border-bottom: 1px solid #e2e8f0; }
    .brand { display: flex; align-items: center; gap: 10px; }
    .brand .logo { width: 36px; height: 36px; border-radius: 8px; background: linear-gradient(135deg, #06b6d4, #0ea5e9); }
    .brand .name { font-weight: 800; font-size: 20px; letter-spacing: -.01em; }
    h1 { margin: 0; font-size: 22px; letter-spacing: -.01em; }
    .muted { color: #64748b; font-size: 13px; }
    .summary { margin-top: 24px; padding: 24px; border-radius: 14px; background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); color: white; display: grid; grid-template-columns: 2fr 1fr; gap: 24px; align-items: center; }
    .summary .label { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #94a3b8; font-weight: 700; }
    .summary .amount { font-size: 38px; font-weight: 800; letter-spacing: -.02em; line-height: 1; margin-top: 4px; }
    .summary .meta { color: #cbd5e1; font-size: 13px; margin-top: 8px; }
    .summary .right { text-align: right; }
    .summary .pill { display: inline-block; background: #0ea5e9; color: white; padding: 5px 12px; border-radius: 999px; font-size: 11px; font-weight: 600; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 24px; font-size: 13px; }
    .grid b { display: block; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: #64748b; margin-bottom: 2px; font-weight: 700; }
    h2 { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #64748b; margin: 28px 0 8px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 10px 10px; border-bottom: 1px solid #e2e8f0; text-align: left; vertical-align: top; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; font-weight: 700; background: #f8fafc; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .product { font-weight: 600; }
    .usage { font-size: 12px; color: #64748b; }
    tfoot td { border-bottom: 0; padding-top: 10px; font-weight: 600; }
    tfoot .grand { font-size: 16px; }
    .credits { color: #0ea5e9; }
  </style>
</head>
<body>
  <div class="head">
    <div class="brand">
      <div class="logo"></div>
      <div class="name">{{ .vendor.name }}</div>
    </div>
    <div style="text-align: right;">
      <h1>Bill summary</h1>
      <div class="muted">Invoice {{ .invoice.number }}</div>
    </div>
  </div>

  <div class="summary">
    <div>
      <div class="label">Total for {{ .invoice.period }}</div>
      <div class="amount">{{ .totals.total | formatCurrency "USD" }}</div>
      <div class="meta">Will charge {{ .payment.method }} on {{ .invoice.chargeAt | formatDate "Jan 2, 2006" }}</div>
    </div>
    <div class="right">
      <span class="pill">Auto-pay</span>
    </div>
  </div>

  <div class="grid">
    <div><b>Account</b>{{ .account.name }}<br /><span class="muted">{{ .account.id }}</span></div>
    <div><b>Billing period</b>{{ .invoice.start | formatDate "Jan 2" }} – {{ .invoice.end | formatDate "Jan 2, 2006" }}</div>
    <div><b>Issued</b>{{ .invoice.issuedAt | formatDate "Jan 2, 2006" }}</div>
    <div><b>Currency</b>USD</div>
  </div>

  <h2>Charges by product</h2>
  <table>
    <thead><tr><th>Product</th><th>Usage</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
    <tbody>
      {{ range .products }}
      <tr>
        <td>
          <div class="product">{{ .name }}</div>
          <div class="usage">{{ .description }}</div>
        </td>
        <td>
          <div>{{ .usage }}</div>
          <div class="usage">{{ .usageDetail }}</div>
        </td>
        <td class="num">{{ .rate }}</td>
        <td class="num">{{ .amount | formatCurrency "USD" }}</td>
      </tr>
      {{ end }}
    </tbody>
    <tfoot>
      <tr><td colspan="3" class="num muted">Subtotal</td><td class="num">{{ .totals.subtotal | formatCurrency "USD" }}</td></tr>
      <tr class="credits"><td colspan="3" class="num">Promotional credits</td><td class="num">−{{ .totals.credits | formatCurrency "USD" }}</td></tr>
      <tr><td colspan="3" class="num muted">Tax</td><td class="num">{{ .totals.tax | formatCurrency "USD" }}</td></tr>
      <tr class="grand"><td colspan="3" class="num">Total</td><td class="num">{{ .totals.total | formatCurrency "USD" }}</td></tr>
    </tfoot>
  </table>

  <h2>Tips to reduce next month's bill</h2>
  <ul style="font-size: 13px; color: #475569; padding-left: 18px; margin: 0;">
    {{ range .tips }}
    <li style="margin-bottom: 4px;">{{ . }}</li>
    {{ end }}
  </ul>
</body>
</html>
`,
  sampleData: {
    vendor: { name: "Stratus Cloud" },
    account: { name: "Northwind Eng — Production", id: "act_4f29a1b8" },
    invoice: {
      number: "INV-2026-0418",
      period: "April 2026",
      start: "2026-04-01",
      end: "2026-04-30",
      issuedAt: "2026-05-01",
      chargeAt: "2026-05-05",
    },
    products: [
      { name: "Compute (CPU)", description: "Auto-scaling worker pool", usage: "1,284 vCPU-hours", usageDetail: "Avg 1.78 vCPU-h/hour", rate: "$0.024 / vCPU-h", amount: 30.82 },
      { name: "Compute (GPU)", description: "ML inference, A10G", usage: "92 GPU-hours", usageDetail: "Burst usage week of Apr 14", rate: "$1.20 / GPU-h", amount: 110.4 },
      { name: "Storage", description: "Object storage", usage: "412 GB-month", usageDetail: "Plus 38 GB egress", rate: "$0.018 / GB-mo", amount: 7.42 },
      { name: "Database", description: "Postgres 16, 4 vCPU", usage: "720 hours", usageDetail: "1 instance, multi-AZ", rate: "$0.32 / hour", amount: 230.4 },
      { name: "Bandwidth", description: "Egress, North America", usage: "284 GB", usageDetail: "First 100 GB free", rate: "$0.085 / GB", amount: 15.64 },
      { name: "Logs", description: "Indexed, 14-day retention", usage: "62 GB", usageDetail: "—", rate: "$0.50 / GB", amount: 31.0 },
    ],
    totals: { subtotal: 425.68, credits: 50, tax: 30.06, total: 405.74 },
    payment: { method: "Visa •••• 4421" },
    tips: [
      "GPU usage spiked Apr 14–16 — consider switching the inference job to spot instances ($1.20 → $0.45 / GPU-h).",
      "62 GB of logs is unusual for this account; check for verbose-debug services and lower retention to 7 days.",
      "Move cold object storage older than 90 days to Stratus Glacier (saves ~$0.012 / GB-mo).",
    ],
  },
};
