import type { Starter } from "./types";

export const eBillStarter: Starter = {
  id: "e-bill",
  name: "Digital / e-billing",
  description:
    "Modern email-card style invoice with hero amount, pay button, and itemized breakdown.",
  category: "Billing",
  tags: ["e-bill", "digital", "email", "invoice"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Invoice {{ .invoice.number }}</title>
  <style>
    body { font-family: Inter, system-ui, -apple-system, sans-serif; background: #f1f5f9; color: #0f172a; padding: 32px; margin: 0; }
    .card { max-width: 580px; margin: 0 auto; background: white; border-radius: 16px; box-shadow: 0 1px 0 #e2e8f0, 0 8px 32px rgba(15, 23, 42, .08); overflow: hidden; }
    .hero { padding: 36px 36px 28px; background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); color: white; text-align: center; }
    .hero .from { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #c7d2fe; font-weight: 700; }
    .hero .brand { font-size: 18px; font-weight: 700; margin-top: 4px; }
    .hero .label { font-size: 12px; color: #c7d2fe; margin-top: 22px; }
    .hero .amount { font-size: 44px; font-weight: 800; letter-spacing: -.02em; margin-top: 4px; line-height: 1; }
    .hero .due { color: #c7d2fe; font-size: 13px; margin-top: 8px; }
    .body { padding: 28px 36px; }
    .pay { display: block; width: 100%; padding: 14px; background: #0f172a; color: white; text-align: center; border-radius: 10px; font-weight: 600; font-size: 14px; text-decoration: none; }
    .pay-meta { text-align: center; font-size: 12px; color: #64748b; margin-top: 10px; }
    .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 24px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 13px; }
    .meta b { display: block; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: #64748b; font-weight: 700; margin-bottom: 2px; }
    h2 { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #64748b; margin: 24px 0 8px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    td { padding: 9px 0; border-bottom: 1px solid #f1f5f9; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    tfoot td { border-bottom: 0; padding-top: 12px; }
    tfoot .grand { font-weight: 700; font-size: 15px; }
    .footer { padding: 18px 36px; background: #f8fafc; font-size: 11px; color: #64748b; text-align: center; }
    .footer a { color: #4f46e5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="hero">
      <div class="from">Invoice from</div>
      <div class="brand">{{ .from.company }}</div>
      <div class="label">Amount due</div>
      <div class="amount">{{ .invoice.total | formatCurrency "USD" }}</div>
      <div class="due">Due {{ .invoice.dueAt | formatDate "Jan 2, 2006" }}</div>
    </div>

    <div class="body">
      <a href="#" class="pay">Pay {{ .invoice.total | formatCurrency "USD" }} now</a>
      <div class="pay-meta">Powered by Stripe · Secure checkout</div>

      <div class="meta">
        <div><b>Invoice</b>{{ .invoice.number }}</div>
        <div><b>Issued</b>{{ .invoice.issuedAt | formatDate "Jan 2, 2006" }}</div>
        <div><b>Billed to</b>{{ .to.name }}<br /><span style="color: #64748b;">{{ .to.email }}</span></div>
        <div><b>Memo</b>{{ .invoice.memo }}</div>
      </div>

      <h2>Summary</h2>
      <table>
        <tbody>
          {{ range .items }}
          <tr>
            <td>
              <div style="font-weight: 600;">{{ .name }}</div>
              {{ if .detail }}<div style="font-size: 12px; color: #64748b;">{{ .detail }}</div>{{ end }}
            </td>
            <td class="num">{{ .amount | formatCurrency "USD" }}</td>
          </tr>
          {{ end }}
        </tbody>
        <tfoot>
          <tr><td style="color: #64748b;">Subtotal</td><td class="num">{{ sum .items "amount" | formatCurrency "USD" }}</td></tr>
          <tr><td style="color: #64748b;">Tax</td><td class="num">{{ .invoice.tax | formatCurrency "USD" }}</td></tr>
          <tr class="grand"><td>Total</td><td class="num">{{ .invoice.total | formatCurrency "USD" }}</td></tr>
        </tfoot>
      </table>
    </div>

    <div class="footer">
      Questions? Reply to this email or contact <a href="#">{{ .from.email }}</a><br />
      {{ .from.company }} · {{ .from.address }}
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    from: {
      company: "Field & Form Studio",
      email: "billing@fieldandform.example",
      address: "240 Pine Street, Seattle WA 98101",
    },
    to: { name: "Lumen Health, Inc.", email: "ap@lumenhealth.example" },
    invoice: {
      number: "INV-2026-0118",
      issuedAt: "2026-04-22",
      dueAt: "2026-05-06",
      memo: "Brand refresh — Apr",
      tax: 168,
      total: 2268,
    },
    items: [
      { name: "Strategy session", detail: "2 × 90-minute workshops with leadership", amount: 1200 },
      { name: "Logo direction", detail: "3 routes, 2 rounds of revisions", amount: 900 },
    ],
  },
};
