import type { Starter } from "./types";

export const posBillStarter: Starter = {
  id: "pos-bill",
  name: "POS billing",
  description:
    "Point-of-sale receipt with order number, server, table, modifiers, and tip suggestions.",
  category: "Billing",
  tags: ["pos", "point of sale", "restaurant", "receipt"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Order {{ .order.number }}</title>
  <style>
    @page { size: 80mm auto; margin: 0; }
    body { font-family: ui-monospace, "SF Mono", Menlo, monospace; color: #000; padding: 16px 14px; max-width: 320px; margin: auto; font-size: 12px; line-height: 1.5; }
    .center { text-align: center; }
    .b { font-weight: 700; }
    .lg { font-size: 17px; font-weight: 800; letter-spacing: .02em; }
    .sm { font-size: 10px; color: #444; }
    .div { border-top: 2px solid #000; margin: 8px 0; }
    .div.dash { border-top-style: dashed; border-top-width: 1px; }
    .row { display: flex; justify-content: space-between; gap: 8px; }
    .row .name { flex: 1; }
    .row .qty { width: 26px; text-align: center; }
    .row .amt { width: 64px; text-align: right; }
    .mod { padding-left: 14px; color: #444; font-size: 11px; }
    .pill { display: inline-block; border: 1px solid #000; padding: 1px 6px; margin-right: 4px; font-size: 10px; letter-spacing: .04em; text-transform: uppercase; font-weight: 700; }
    .grand { font-size: 16px; font-weight: 800; }
    .tip { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px; margin: 8px 0; }
    .tip .opt { border: 1px solid #000; padding: 4px; text-align: center; font-size: 11px; }
    .tip .opt b { display: block; font-size: 13px; }
  </style>
</head>
<body>
  <div class="center">
    <div class="lg">{{ .merchant.name }}</div>
    <div class="sm">{{ .merchant.address }}</div>
    <div class="sm">{{ .merchant.phone }}</div>
  </div>

  <div class="div"></div>

  <div class="center">
    <span class="pill">Dine-in</span>
    <span class="pill">Table {{ .order.table }}</span>
  </div>

  <div class="row sm" style="margin-top: 6px;"><span>Order</span><span class="b">{{ .order.number }}</span></div>
  <div class="row sm"><span>Server</span><span>{{ .order.server }}</span></div>
  <div class="row sm"><span>Guests</span><span>{{ .order.guests }}</span></div>
  <div class="row sm"><span>Time</span><span>{{ .order.time | formatDate "02 Jan · 15:04" }}</span></div>

  <div class="div dash"></div>

  {{ range .items }}
  <div class="row">
    <span class="name b">{{ .qty }} × {{ .name }}</span>
    <span class="amt">{{ .total | formatCurrency "USD" }}</span>
  </div>
  {{ if .modifiers }}
  {{ range .modifiers }}
  <div class="mod">+ {{ . }}</div>
  {{ end }}
  {{ end }}
  {{ end }}

  <div class="div dash"></div>

  <div class="row"><span>Subtotal</span><span>{{ .totals.subtotal | formatCurrency "USD" }}</span></div>
  <div class="row"><span>Tax ({{ .totals.taxLabel }})</span><span>{{ .totals.tax | formatCurrency "USD" }}</span></div>
  {{ if .totals.serviceFee }}
  <div class="row"><span>Service fee</span><span>{{ .totals.serviceFee | formatCurrency "USD" }}</span></div>
  {{ end }}

  <div class="div"></div>

  <div class="row grand"><span>TOTAL</span><span>{{ .totals.total | formatCurrency "USD" }}</span></div>

  <div class="div dash"></div>

  <div class="center sm b">Suggested tip</div>
  <div class="tip">
    <div class="opt">15%<b>{{ .tip.t15 | formatCurrency "USD" }}</b></div>
    <div class="opt">18%<b>{{ .tip.t18 | formatCurrency "USD" }}</b></div>
    <div class="opt">20%<b>{{ .tip.t20 | formatCurrency "USD" }}</b></div>
  </div>

  <div class="div dash"></div>

  <div class="row sm"><span>Payment</span><span>{{ .payment.method }}</span></div>
  <div class="row sm"><span>Auth</span><span>{{ .payment.auth }}</span></div>

  <div class="div"></div>

  <div class="center sm">{{ .footer }}</div>
</body>
</html>
`,
  sampleData: {
    merchant: {
      name: "ROW 34",
      address: "383 Congress St, Boston MA 02210",
      phone: "+1 (617) 553-5900",
    },
    order: {
      number: "#A0421",
      table: "12",
      server: "Avery J.",
      guests: "4",
      time: "2026-04-29T19:42:00",
    },
    items: [
      {
        qty: 1,
        name: "Oysters, half dozen",
        total: 24,
        modifiers: ["Extra mignonette"],
      },
      {
        qty: 1,
        name: "Tuna crudo",
        total: 19,
        modifiers: [],
      },
      {
        qty: 2,
        name: "Cod & chips",
        total: 56,
        modifiers: ["Sub side salad", "Hold tartar"],
      },
      {
        qty: 1,
        name: "House cocktail",
        total: 16,
        modifiers: [],
      },
      {
        qty: 1,
        name: "Sparkling water (large)",
        total: 9,
        modifiers: [],
      },
    ],
    totals: { subtotal: 124, taxLabel: "6.25%", tax: 7.75, serviceFee: 0, total: 131.75 },
    tip: { t15: 19.76, t18: 23.72, t20: 26.35 },
    payment: { method: "Visa •••• 4421", auth: "AUTH 884291" },
    footer: "Thanks for dining with us!",
  },
};
