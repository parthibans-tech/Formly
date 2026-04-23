import type { Starter } from "./types";

export const receiptStarter: Starter = {
  id: "receipt",
  name: "Receipt",
  description:
    "Compact payment receipt with transaction details, suitable for email attachments.",
  category: "Billing",
  tags: ["receipt", "payment", "thermal"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Receipt {{ .id }}</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; color: #111; padding: 48px; max-width: 420px; margin: auto; }
    .brand { font-weight: 700; font-size: 18px; color: #0f766e; text-align: center; }
    h1 { text-align: center; margin: 12px 0 4px; font-size: 16px; letter-spacing: .12em; text-transform: uppercase; }
    .muted { color: #666; font-size: 12px; text-align: center; }
    hr { border: 0; border-top: 1px dashed #ccc; margin: 20px 0; }
    .row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
    .row .k { color: #666; }
    .total { font-weight: 700; font-size: 16px; margin-top: 8px; padding-top: 8px; border-top: 2px solid #111; }
    .footer { text-align: center; color: #666; font-size: 11px; margin-top: 28px; }
  </style>
</head>
<body>
  <div class="brand">{{ .merchant.name }}</div>
  <div class="muted">{{ .merchant.address }}</div>
  <h1>Receipt</h1>
  <div class="muted">#{{ .id }} · {{ .paidAt | formatDate "Jan 2, 2006 15:04" }}</div>

  <hr />

  {{ range .lines }}
  <div class="row">
    <div class="k">{{ .name }}{{ if gt .qty 1.0 }} × {{ .qty }}{{ end }}</div>
    <div>{{ .amount | formatCurrency "USD" }}</div>
  </div>
  {{ end }}

  <div class="row"><div class="k">Subtotal</div><div>{{ .subtotal | formatCurrency "USD" }}</div></div>
  <div class="row"><div class="k">Tax</div><div>{{ .tax | formatCurrency "USD" }}</div></div>
  <div class="row total"><div>Total</div><div>{{ .total | formatCurrency "USD" }}</div></div>

  <hr />

  <div class="row"><div class="k">Method</div><div>{{ .method }}</div></div>
  {{ if .cardLast4 }}<div class="row"><div class="k">Card</div><div>••••&nbsp;{{ .cardLast4 }}</div></div>{{ end }}
  <div class="row"><div class="k">Auth</div><div>{{ .authCode }}</div></div>

  <div class="footer">
    Thanks for shopping with {{ .merchant.name }}.
  </div>
</body>
</html>
`,
  sampleData: {
    id: "RCPT-00821",
    paidAt: "2026-04-23T12:05:00Z",
    merchant: {
      name: "Corner Coffee",
      address: "42 Oak Ave, Portland, OR",
    },
    lines: [
      { name: "Flat white", qty: 2, amount: 11.0 },
      { name: "Butter croissant", qty: 1, amount: 4.5 },
    ],
    subtotal: 15.5,
    tax: 1.4,
    total: 16.9,
    method: "Card",
    cardLast4: "4242",
    authCode: "A1B2-9987",
  },
};
