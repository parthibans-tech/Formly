import type { Starter } from "./types";

export const invoiceStarter: Starter = {
  id: "invoice",
  name: "Invoice",
  description:
    "Itemized invoice with line items, subtotal, tax, and total. Uses range + sum.",
  category: "Billing",
  tags: ["invoice", "billing", "loop"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Invoice {{ .invoice.number }}</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; color: #111; padding: 48px; max-width: 780px; margin: auto; }
    .row { display: flex; justify-content: space-between; align-items: flex-start; }
    .brand { font-weight: 700; font-size: 22px; color: #047857; }
    h1 { font-size: 28px; margin: 0; }
    .muted { color: #666; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; margin-top: 32px; }
    th, td { padding: 12px 10px; text-align: left; border-bottom: 1px solid #e5e7eb; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #666; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    tfoot td { border-bottom: 0; font-weight: 600; }
    .totals { margin-top: 8px; }
    .stamp { display: inline-block; padding: 4px 10px; border: 2px solid #047857; color: #047857;
             font-weight: 700; letter-spacing: .08em; text-transform: uppercase; font-size: 11px;
             border-radius: 4px; transform: rotate(-4deg); }
  </style>
</head>
<body>
  <div class="row">
    <div>
      <div class="brand">{{ .from.company }}</div>
      <div class="muted">{{ .from.address }}</div>
    </div>
    <div style="text-align: right;">
      <h1>Invoice</h1>
      <div class="muted">#{{ .invoice.number }}</div>
      <div class="muted">Issued {{ .invoice.issuedAt | formatDate "Jan 2, 2006" }}</div>
      <div class="muted">Due {{ .invoice.dueAt | formatDate "Jan 2, 2006" }}</div>
      {{ if .invoice.paid }}<div style="margin-top: 10px;"><span class="stamp">Paid</span></div>{{ end }}
    </div>
  </div>

  <div class="row" style="margin-top: 32px;">
    <div>
      <div class="muted">Bill to</div>
      <div style="font-weight: 600;">{{ .to.name }}</div>
      <div class="muted">{{ .to.email }}</div>
      <div class="muted">{{ .to.address }}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Description</th>
        <th class="num">Qty</th>
        <th class="num">Rate</th>
        <th class="num">Amount</th>
      </tr>
    </thead>
    <tbody>
      {{ range .items }}
      <tr>
        <td>{{ .name }}</td>
        <td class="num">{{ .qty }}</td>
        <td class="num">{{ .rate | formatCurrency "USD" }}</td>
        <td class="num">{{ .amount | formatCurrency "USD" }}</td>
      </tr>
      {{ end }}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="3" class="num muted">Subtotal</td>
        <td class="num">{{ sum .items "amount" | formatCurrency "USD" }}</td>
      </tr>
      <tr>
        <td colspan="3" class="num muted">Tax ({{ .invoice.taxLabel }})</td>
        <td class="num">{{ .invoice.tax | formatCurrency "USD" }}</td>
      </tr>
      <tr>
        <td colspan="3" class="num">Total</td>
        <td class="num">{{ .invoice.total | formatCurrency "USD" }}</td>
      </tr>
    </tfoot>
  </table>

  {{ if .notes }}
    <p class="muted" style="margin-top: 32px; border-top: 1px solid #e5e7eb; padding-top: 16px;">
      {{ .notes }}
    </p>
  {{ end }}
</body>
</html>
`,
  sampleData: {
    from: {
      company: "Acme Studios",
      address: "100 Main Street, Portland, OR 97201",
    },
    to: {
      name: "Globex Corporation",
      email: "billing@globex.example",
      address: "500 Market St, San Francisco, CA 94103",
    },
    invoice: {
      number: "INV-2026-041",
      issuedAt: "2026-04-23",
      dueAt: "2026-05-07",
      paid: false,
      tax: 112.5,
      taxLabel: "9%",
      total: 1362.5,
    },
    items: [
      { name: "Brand strategy workshop", qty: 1, rate: 850, amount: 850 },
      { name: "Logo exploration (3 routes)", qty: 1, rate: 400, amount: 400 },
    ],
    notes: "Thanks for the continued partnership! Net 14 days.",
  },
};
