import type { Starter } from "./types";

export const purchaseOrderStarter: Starter = {
  id: "purchase-order",
  name: "Purchase order",
  description:
    "Vendor-facing PO with shipping address, line items, requested delivery date, and approval.",
  category: "Finance",
  tags: ["po", "purchase", "procurement"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>PO {{ .po.number }}</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; color: #111827; padding: 48px; max-width: 780px; margin: auto; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 16px; border-bottom: 2px solid #111827; }
    .brand { font-weight: 800; font-size: 22px; letter-spacing: -.01em; }
    h1 { font-size: 28px; margin: 0; letter-spacing: -.01em; }
    .muted { color: #6b7280; font-size: 13px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 24px; }
    .grid h3 { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #6b7280; margin: 0 0 6px; font-weight: 700; }
    .grid b { display: block; font-size: 14px; }
    .meta-pills { display: flex; gap: 18px; margin-top: 16px; padding: 14px 16px; background: #f3f4f6; border-radius: 8px; }
    .pill .label { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: #6b7280; font-weight: 700; }
    .pill .val { font-size: 14px; font-weight: 600; color: #111827; }
    table { width: 100%; border-collapse: collapse; margin-top: 24px; font-size: 13px; }
    th, td { padding: 11px 10px; text-align: left; border-bottom: 1px solid #e5e7eb; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; font-weight: 700; background: #f9fafb; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    tfoot td { font-weight: 700; border-bottom: 0; }
    .approval { margin-top: 48px; display: flex; gap: 32px; }
    .approval .box { flex: 1; border-top: 1px solid #111827; padding-top: 6px; font-size: 12px; color: #6b7280; }
    .approval .box b { display: block; color: #111827; font-size: 13px; margin-top: 2px; }
  </style>
</head>
<body>
  <div class="head">
    <div>
      <div class="brand">{{ .buyer.company }}</div>
      <div class="muted">{{ .buyer.address }}</div>
    </div>
    <div style="text-align: right;">
      <h1>Purchase Order</h1>
      <div class="muted">{{ .po.number }} · Issued {{ .po.issuedAt | formatDate "Jan 2, 2006" }}</div>
    </div>
  </div>

  <div class="grid">
    <div>
      <h3>Vendor</h3>
      <b>{{ .vendor.name }}</b>
      <div class="muted">{{ .vendor.contact }}</div>
      <div class="muted">{{ .vendor.address }}</div>
      <div class="muted">{{ .vendor.email }}</div>
    </div>
    <div>
      <h3>Ship to</h3>
      <b>{{ .shipTo.name }}</b>
      <div class="muted">{{ .shipTo.address }}</div>
      <div class="muted">Attn: {{ .shipTo.attn }}</div>
    </div>
  </div>

  <div class="meta-pills">
    <div class="pill"><div class="label">Requested by</div><div class="val">{{ .po.requestedBy }}</div></div>
    <div class="pill"><div class="label">Deliver by</div><div class="val">{{ .po.deliverBy | formatDate "Jan 2, 2006" }}</div></div>
    <div class="pill"><div class="label">Payment terms</div><div class="val">{{ .po.terms }}</div></div>
  </div>

  <table>
    <thead>
      <tr>
        <th>SKU</th>
        <th>Description</th>
        <th class="num">Qty</th>
        <th class="num">Unit</th>
        <th class="num">Total</th>
      </tr>
    </thead>
    <tbody>
      {{ range .items }}
      <tr>
        <td>{{ .sku }}</td>
        <td>{{ .description }}</td>
        <td class="num">{{ .qty }}</td>
        <td class="num">{{ .unit | formatCurrency "USD" }}</td>
        <td class="num">{{ .total | formatCurrency "USD" }}</td>
      </tr>
      {{ end }}
    </tbody>
    <tfoot>
      <tr><td colspan="4" class="num muted">Subtotal</td><td class="num">{{ sum .items "total" | formatCurrency "USD" }}</td></tr>
      <tr><td colspan="4" class="num muted">Shipping</td><td class="num">{{ .po.shipping | formatCurrency "USD" }}</td></tr>
      <tr><td colspan="4" class="num">Total</td><td class="num">{{ .po.total | formatCurrency "USD" }}</td></tr>
    </tfoot>
  </table>

  <div class="approval">
    <div class="box">Authorized by<b>{{ .po.approver }}</b></div>
    <div class="box">Signature & date</div>
  </div>
</body>
</html>
`,
  sampleData: {
    buyer: { company: "Northwind Operations", address: "1500 Industrial Way, Reno NV 89502" },
    vendor: {
      name: "Bell & Carter Components",
      contact: "Janet Reyes",
      address: "402 Foundry Rd, Modesto CA 95354",
      email: "orders@bellcarter.example",
    },
    shipTo: {
      name: "Northwind Distribution Center 4",
      address: "920 Logistics Loop, Sparks NV 89434",
      attn: "Receiving — Dock B",
    },
    po: {
      number: "PO-2026-0892",
      issuedAt: "2026-04-22",
      requestedBy: "Daniel Cho",
      deliverBy: "2026-05-15",
      terms: "Net 30",
      shipping: 280,
      total: 14640,
      approver: "Margaret Liu, VP Operations",
    },
    items: [
      { sku: "BC-204", description: "Stainless flange bracket, 4-hole", qty: 60, unit: 38, total: 2280 },
      { sku: "BC-118", description: 'Pneumatic actuator, 2"', qty: 24, unit: 215, total: 5160 },
      { sku: "BC-901", description: "Replacement seal kit (Series 9)", qty: 80, unit: 86.5, total: 6920 },
    ],
  },
};
