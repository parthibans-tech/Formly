import type { Starter } from "./types";

export const thermalBillStarter: Starter = {
  id: "thermal-bill",
  name: "Thermal billing",
  description:
    "80mm thermal-printer receipt with monospace text, dotted dividers, and barcode footer.",
  category: "Billing",
  tags: ["thermal", "receipt", "printer", "80mm"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Receipt {{ .receipt.number }}</title>
  <style>
    @page { size: 80mm auto; margin: 0; }
    body { font-family: ui-monospace, "SF Mono", Menlo, monospace; color: #000; padding: 14px 12px; max-width: 320px; margin: auto; font-size: 12px; line-height: 1.45; background: #fff; }
    .center { text-align: center; }
    .b { font-weight: 700; }
    .lg { font-size: 16px; font-weight: 700; letter-spacing: .04em; }
    .sm { font-size: 10px; color: #444; }
    .div { border-top: 1px dashed #000; margin: 8px 0; }
    .row { display: flex; justify-content: space-between; gap: 8px; }
    .row .name { flex: 1; }
    .row .qty { width: 26px; text-align: right; }
    .row .amt { width: 64px; text-align: right; }
    table { width: 100%; }
    .tot { font-size: 14px; font-weight: 700; }
    .bars { display: flex; gap: 1px; height: 36px; justify-content: center; margin-top: 6px; }
    .bars .b { width: 2px; background: #000; }
  </style>
</head>
<body>
  <div class="center">
    <div class="lg">{{ .merchant.name }}</div>
    <div class="sm">{{ .merchant.address }}</div>
    <div class="sm">{{ .merchant.phone }}</div>
    <div class="sm">{{ .merchant.taxId }}</div>
  </div>

  <div class="div"></div>

  <div class="row"><span>Receipt #</span><span class="b">{{ .receipt.number }}</span></div>
  <div class="row"><span>Date</span><span>{{ .receipt.date | formatDate "02 Jan 2006 15:04" }}</span></div>
  <div class="row"><span>Cashier</span><span>{{ .receipt.cashier }}</span></div>
  <div class="row"><span>Terminal</span><span>{{ .receipt.terminal }}</span></div>

  <div class="div"></div>

  <div class="row sm"><span class="name">Item</span><span class="qty">Qty</span><span class="amt">Total</span></div>

  <div class="div"></div>

  {{ range .items }}
  <div class="row">
    <span class="name">{{ .name }}</span>
    <span class="qty">{{ .qty }}</span>
    <span class="amt">{{ .total | formatCurrency "USD" }}</span>
  </div>
  <div class="row sm"><span class="name">  @ {{ .price | formatCurrency "USD" }}</span></div>
  {{ end }}

  <div class="div"></div>

  <div class="row"><span>Subtotal</span><span>{{ sum .items "total" | formatCurrency "USD" }}</span></div>
  <div class="row"><span>Tax ({{ .totals.taxLabel }})</span><span>{{ .totals.tax | formatCurrency "USD" }}</span></div>
  {{ if .totals.discount }}
  <div class="row"><span>Discount</span><span>−{{ .totals.discount | formatCurrency "USD" }}</span></div>
  {{ end }}
  <div class="div"></div>
  <div class="row tot"><span>TOTAL</span><span>{{ .totals.total | formatCurrency "USD" }}</span></div>

  <div class="div"></div>

  <div class="row"><span>Tendered ({{ .payment.method }})</span><span>{{ .payment.tendered | formatCurrency "USD" }}</span></div>
  <div class="row"><span>Change</span><span>{{ .payment.change | formatCurrency "USD" }}</span></div>

  <div class="div"></div>

  <div class="center sm">{{ .footer.thanks }}</div>
  <div class="center sm">{{ .footer.policy }}</div>

  <div class="bars">
    <div class="b" style="height:36px"></div><div class="b" style="height:24px"></div><div class="b" style="height:36px"></div>
    <div class="b" style="height:18px"></div><div class="b" style="height:36px"></div><div class="b" style="height:30px"></div>
    <div class="b" style="height:24px"></div><div class="b" style="height:36px"></div><div class="b" style="height:18px"></div>
    <div class="b" style="height:36px"></div><div class="b" style="height:24px"></div><div class="b" style="height:36px"></div>
    <div class="b" style="height:30px"></div><div class="b" style="height:18px"></div><div class="b" style="height:36px"></div>
    <div class="b" style="height:24px"></div><div class="b" style="height:18px"></div><div class="b" style="height:36px"></div>
  </div>
  <div class="center sm" style="margin-top: 4px;">{{ .receipt.number }}</div>
</body>
</html>
`,
  sampleData: {
    merchant: {
      name: "BLUE BIRD CAFE",
      address: "240 Pine St, Seattle WA 98101",
      phone: "+1 (206) 555-0144",
      taxId: "TAX ID 88-1234567",
    },
    receipt: {
      number: "BB-209441",
      date: "2026-04-29T14:38:00",
      cashier: "Maya P.",
      terminal: "T-2",
    },
    items: [
      { name: "Cappuccino, large", qty: 2, price: 5.5, total: 11 },
      { name: "Almond croissant", qty: 1, price: 4.25, total: 4.25 },
      { name: "Avocado toast", qty: 1, price: 11.5, total: 11.5 },
      { name: "Sparkling water", qty: 2, price: 3.0, total: 6.0 },
    ],
    totals: { taxLabel: "9.5%", tax: 3.11, discount: 0, total: 35.86 },
    payment: { method: "Visa •••• 4421", tendered: 35.86, change: 0 },
    footer: {
      thanks: "Thank you — see you soon!",
      policy: "Returns within 7 days with receipt.",
    },
  },
};
