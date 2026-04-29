import type { Starter } from "./types";

export const quoteStarter: Starter = {
  id: "quote",
  name: "Quote / Estimate",
  description:
    "Sales quote with line items, valid-until date, and acceptance signature line.",
  category: "Finance",
  tags: ["quote", "estimate", "sales"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Quote {{ .quote.number }}</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; color: #0f172a; padding: 48px; max-width: 780px; margin: auto; }
    .row { display: flex; justify-content: space-between; align-items: flex-start; }
    .brand { font-weight: 800; font-size: 22px; color: #1d4ed8; letter-spacing: -.01em; }
    h1 { font-size: 28px; margin: 0; letter-spacing: -.01em; }
    .muted { color: #64748b; font-size: 13px; }
    .badge { display: inline-block; background: #dbeafe; color: #1d4ed8; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
    table { width: 100%; border-collapse: collapse; margin-top: 28px; }
    th, td { padding: 12px 10px; text-align: left; border-bottom: 1px solid #e2e8f0; font-size: 14px; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; font-weight: 600; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    tfoot td { font-weight: 700; border-bottom: 0; }
    .totals-row td { font-weight: 600; }
    .grand td { font-size: 16px; padding-top: 14px; }
    .signature { margin-top: 56px; display: flex; justify-content: space-between; gap: 32px; }
    .signature .line { border-top: 1px solid #1f2937; padding-top: 6px; font-size: 12px; color: #6b7280; flex: 1; }
    .signature b { color: #0f172a; display: block; font-size: 13px; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="row">
    <div>
      <div class="brand">{{ .from.company }}</div>
      <div class="muted">{{ .from.address }}</div>
      <div class="muted">{{ .from.email }}</div>
    </div>
    <div style="text-align: right;">
      <span class="badge">Quote</span>
      <h1 style="margin-top: 8px;">{{ .quote.number }}</h1>
      <div class="muted">Issued {{ .quote.issuedAt | formatDate "Jan 2, 2006" }}</div>
      <div class="muted">Valid until {{ .quote.validUntil | formatDate "Jan 2, 2006" }}</div>
    </div>
  </div>

  <div class="row" style="margin-top: 28px;">
    <div>
      <div class="muted">Prepared for</div>
      <div style="font-weight: 600;">{{ .to.name }}</div>
      <div class="muted">{{ .to.company }}</div>
      <div class="muted">{{ .to.email }}</div>
    </div>
    <div style="text-align: right;">
      <div class="muted">Project</div>
      <div style="font-weight: 600;">{{ .quote.project }}</div>
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
        <td>
          <div style="font-weight: 600;">{{ .name }}</div>
          {{ if .detail }}<div class="muted">{{ .detail }}</div>{{ end }}
        </td>
        <td class="num">{{ .qty }}</td>
        <td class="num">{{ .rate | formatCurrency "USD" }}</td>
        <td class="num">{{ .amount | formatCurrency "USD" }}</td>
      </tr>
      {{ end }}
    </tbody>
    <tfoot>
      <tr class="totals-row">
        <td colspan="3" class="num muted">Subtotal</td>
        <td class="num">{{ sum .items "amount" | formatCurrency "USD" }}</td>
      </tr>
      <tr class="totals-row">
        <td colspan="3" class="num muted">Discount ({{ .quote.discountLabel }})</td>
        <td class="num">−{{ .quote.discount | formatCurrency "USD" }}</td>
      </tr>
      <tr class="grand">
        <td colspan="3" class="num">Total</td>
        <td class="num">{{ .quote.total | formatCurrency "USD" }}</td>
      </tr>
    </tfoot>
  </table>

  {{ if .terms }}
  <p class="muted" style="margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 14px;">
    <b style="color: #0f172a;">Terms.</b> {{ .terms }}
  </p>
  {{ end }}

  <div class="signature">
    <div class="line">Accepted by (client)<b>{{ .to.name }}</b></div>
    <div class="line">Date</div>
  </div>
</body>
</html>
`,
  sampleData: {
    from: {
      company: "Field & Form Studio",
      address: "240 Pine Street, Suite 1100, Seattle WA 98101",
      email: "hello@fieldandform.example",
    },
    to: {
      name: "Priya Anand",
      company: "Lumen Health, Inc.",
      email: "priya@lumenhealth.example",
    },
    quote: {
      number: "Q-2026-0118",
      project: "Brand Refresh & Website",
      issuedAt: "2026-04-22",
      validUntil: "2026-05-22",
      discount: 5000,
      discountLabel: "Early commit",
      total: 96000,
    },
    items: [
      { name: "Discovery & strategy", detail: "Stakeholder interviews, competitive audit", qty: 1, rate: 18500, amount: 18500 },
      { name: "Identity system", detail: "Logo, color, typography, photography direction", qty: 1, rate: 24000, amount: 24000 },
      { name: "Website design & build", detail: "12 page templates, motion guide", qty: 1, rate: 42000, amount: 42000 },
      { name: "Component library", detail: "Figma + React (shadcn-based)", qty: 1, rate: 16500, amount: 16500 },
    ],
    terms:
      "This quote is valid for 30 days. 50% deposit due at signature; remainder split between design approval and launch. Out-of-scope work billed hourly at $185.",
  },
};
