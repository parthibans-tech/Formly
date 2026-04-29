import type { Starter } from "./types";

export const statementStarter: Starter = {
  id: "statement",
  name: "Account statement",
  description:
    "Customer account statement listing invoices, payments, and outstanding balance.",
  category: "Billing",
  tags: ["statement", "billing", "account"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Statement {{ .statement.number }}</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; color: #0f172a; padding: 48px; max-width: 820px; margin: auto; line-height: 1.5; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 14px; border-bottom: 2px solid #0f172a; }
    .brand { font-weight: 800; font-size: 22px; letter-spacing: -.01em; color: #0f172a; }
    h1 { margin: 0; font-size: 26px; letter-spacing: -.01em; }
    .muted { color: #64748b; font-size: 13px; }
    .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 22px; }
    .card { padding: 14px 16px; border-radius: 10px; border: 1px solid #e2e8f0; }
    .card .label { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: #64748b; font-weight: 700; }
    .card .value { font-size: 18px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
    .card.highlight { background: #0f172a; color: white; border-color: #0f172a; }
    .card.highlight .label { color: #cbd5e1; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 22px; font-size: 13px; }
    .grid b { display: block; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #64748b; margin-bottom: 4px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; margin-top: 28px; font-size: 13px; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-align: left; }
    th { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: #64748b; font-weight: 700; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .pos { color: #166534; font-weight: 600; }
    .neg { color: #991b1b; font-weight: 600; }
    tfoot td { font-weight: 700; border-bottom: 0; padding-top: 12px; font-size: 15px; }
    .pay { margin-top: 28px; padding: 16px 18px; border: 1px solid #e2e8f0; border-radius: 10px; background: #f8fafc; font-size: 13px; color: #475569; }
    .pay b { color: #0f172a; }
  </style>
</head>
<body>
  <div class="head">
    <div>
      <div class="brand">{{ .from.company }}</div>
      <div class="muted">{{ .from.address }}</div>
    </div>
    <div style="text-align: right;">
      <h1>Statement</h1>
      <div class="muted">#{{ .statement.number }}</div>
      <div class="muted">{{ .statement.periodStart | formatDate "Jan 2" }} – {{ .statement.periodEnd | formatDate "Jan 2, 2006" }}</div>
    </div>
  </div>

  <div class="grid">
    <div>
      <b>Bill to</b>
      <div style="font-weight: 600; font-size: 14px;">{{ .to.name }}</div>
      <div class="muted">{{ .to.contact }}</div>
      <div class="muted">{{ .to.address }}</div>
    </div>
    <div>
      <b>Account</b>
      <div style="font-weight: 600; font-size: 14px;">{{ .account.number }}</div>
      <div class="muted">Terms: {{ .account.terms }}</div>
      <div class="muted">Due: {{ .statement.dueAt | formatDate "Jan 2, 2006" }}</div>
    </div>
  </div>

  <div class="summary">
    <div class="card"><div class="label">Opening balance</div><div class="value">{{ .summary.opening | formatCurrency "USD" }}</div></div>
    <div class="card"><div class="label">Charges</div><div class="value">{{ .summary.charges | formatCurrency "USD" }}</div></div>
    <div class="card"><div class="label">Payments</div><div class="value">−{{ .summary.payments | formatCurrency "USD" }}</div></div>
    <div class="card highlight"><div class="label">Amount due</div><div class="value">{{ .summary.due | formatCurrency "USD" }}</div></div>
  </div>

  <table>
    <thead>
      <tr><th>Date</th><th>Description</th><th>Reference</th><th class="num">Charge</th><th class="num">Payment</th><th class="num">Balance</th></tr>
    </thead>
    <tbody>
      {{ range .activity }}
      <tr>
        <td>{{ .date | formatDate "Jan 2" }}</td>
        <td>{{ .description }}</td>
        <td class="muted">{{ .reference }}</td>
        <td class="num">{{ if .charge }}<span class="neg">{{ .charge | formatCurrency "USD" }}</span>{{ end }}</td>
        <td class="num">{{ if .payment }}<span class="pos">−{{ .payment | formatCurrency "USD" }}</span>{{ end }}</td>
        <td class="num">{{ .balance | formatCurrency "USD" }}</td>
      </tr>
      {{ end }}
    </tbody>
    <tfoot>
      <tr><td colspan="5" class="num">Balance due</td><td class="num">{{ .summary.due | formatCurrency "USD" }}</td></tr>
    </tfoot>
  </table>

  <div class="pay">
    <b>Remit payment to</b> {{ .from.company }} · ACH routing {{ .payment.routing }} · account {{ .payment.account }} · or pay online at <b>{{ .payment.portal }}</b>
  </div>
</body>
</html>
`,
  sampleData: {
    from: { company: "Acme Studios", address: "100 Main Street, Portland, OR 97201" },
    to: {
      name: "Globex Corporation",
      contact: "Accounts Payable",
      address: "500 Market St, San Francisco, CA 94103",
    },
    account: { number: "ACME-GLBX-0042", terms: "Net 30" },
    statement: {
      number: "ST-2026-04",
      periodStart: "2026-04-01",
      periodEnd: "2026-04-30",
      dueAt: "2026-05-30",
    },
    summary: { opening: 1200, charges: 4760, payments: 1200, due: 4760 },
    activity: [
      { date: "2026-04-01", description: "Opening balance carried forward", reference: "INV-2026-038", balance: 1200 },
      { date: "2026-04-08", description: "Payment received — thank you", reference: "ACH-882910", payment: 1200, balance: 0 },
      { date: "2026-04-12", description: "Brand strategy workshop", reference: "INV-2026-041", charge: 850, balance: 850 },
      { date: "2026-04-12", description: "Logo exploration (3 routes)", reference: "INV-2026-041", charge: 400, balance: 1250 },
      { date: "2026-04-23", description: "Visual identity sprint", reference: "INV-2026-044", charge: 2400, balance: 3650 },
      { date: "2026-04-28", description: "Web design — homepage", reference: "INV-2026-047", charge: 1110, balance: 4760 },
    ],
    payment: { routing: "121000358", account: "•••• 7421", portal: "pay.acmestudios.example" },
  },
};
