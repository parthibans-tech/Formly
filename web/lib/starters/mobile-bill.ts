import type { Starter } from "./types";

export const mobileBillStarter: Starter = {
  id: "mobile-bill",
  name: "Mobile billing",
  description:
    "Phone-screen-style mobile bill with avatar, status pill, line items, and pay CTA.",
  category: "Billing",
  tags: ["mobile", "bill", "phone"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Bill {{ .bill.number }}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Inter", sans-serif; background: #f1f5f9; padding: 32px; margin: 0; color: #0f172a; }
    .phone { width: 360px; margin: 0 auto; background: white; border-radius: 28px; box-shadow: 0 1px 0 #e2e8f0, 0 16px 40px rgba(15, 23, 42, .12); overflow: hidden; border: 8px solid #0f172a; }
    .status { background: #0f172a; color: white; padding: 10px 18px 6px; display: flex; justify-content: space-between; font-size: 11px; font-weight: 600; }
    .status .right { display: flex; gap: 6px; align-items: center; }
    .topbar { padding: 14px 18px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid #f1f5f9; }
    .topbar .back { font-size: 18px; color: #6366f1; }
    .topbar .title { font-size: 15px; font-weight: 700; }
    .head { padding: 24px 22px 18px; text-align: center; }
    .avatar { width: 56px; height: 56px; border-radius: 50%; background: linear-gradient(135deg, #6366f1, #4f46e5); display: inline-grid; place-items: center; color: white; font-weight: 700; font-size: 20px; }
    .biller { font-weight: 700; font-size: 16px; margin-top: 10px; }
    .biller .sm { font-size: 11px; color: #64748b; font-weight: 500; }
    .pill { display: inline-block; background: #fef3c7; color: #92400e; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; margin-top: 8px; }
    .pill.paid { background: #dcfce7; color: #166534; }
    .amount { padding: 4px 22px 18px; text-align: center; }
    .amount .label { font-size: 11px; color: #64748b; letter-spacing: .08em; text-transform: uppercase; }
    .amount .value { font-size: 36px; font-weight: 800; letter-spacing: -.02em; margin-top: 2px; }
    .amount .due { font-size: 12px; color: #64748b; margin-top: 2px; }
    .section { padding: 14px 22px; border-top: 1px solid #f1f5f9; }
    .section h3 { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: #64748b; margin: 0 0 8px; font-weight: 700; }
    .item { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; }
    .item .name { color: #475569; }
    .item .val { font-weight: 600; }
    .total { display: flex; justify-content: space-between; padding-top: 10px; margin-top: 6px; border-top: 1px solid #f1f5f9; font-weight: 700; font-size: 14px; }
    .pay { padding: 14px 22px 22px; }
    .pay .btn { display: block; width: 100%; padding: 14px; background: #0f172a; color: white; text-align: center; border-radius: 14px; font-weight: 700; font-size: 15px; text-decoration: none; }
    .pay .meta { text-align: center; font-size: 11px; color: #64748b; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="phone">
    <div class="status">
      <span>9:41</span>
      <span class="right">📶 100%</span>
    </div>
    <div class="topbar">
      <span class="back">←</span>
      <span class="title">Bill detail</span>
    </div>

    <div class="head">
      <div class="avatar">{{ .biller.initials }}</div>
      <div class="biller">
        {{ .biller.name }}
        <div class="sm">Bill #{{ .bill.number }}</div>
      </div>
      {{ if .bill.paid }}
      <div class="pill paid">Paid</div>
      {{ else }}
      <div class="pill">Due in {{ .bill.dueIn }}</div>
      {{ end }}
    </div>

    <div class="amount">
      <div class="label">Amount due</div>
      <div class="value">{{ .bill.total | formatCurrency "USD" }}</div>
      <div class="due">Due {{ .bill.dueAt | formatDate "Jan 2, 2006" }}</div>
    </div>

    <div class="section">
      <h3>Charges</h3>
      {{ range .items }}
      <div class="item"><span class="name">{{ .name }}</span><span class="val">{{ .amount | formatCurrency "USD" }}</span></div>
      {{ end }}
      <div class="total"><span>Total</span><span>{{ .bill.total | formatCurrency "USD" }}</span></div>
    </div>

    <div class="section">
      <h3>Payment method</h3>
      <div class="item"><span class="name">{{ .payment.method }}</span><span class="val">Default</span></div>
    </div>

    {{ if not .bill.paid }}
    <div class="pay">
      <a href="#" class="btn">Pay now</a>
      <div class="meta">Tap to pay with Face ID</div>
    </div>
    {{ end }}
  </div>
</body>
</html>
`,
  sampleData: {
    biller: { name: "Pacific Power", initials: "PP" },
    bill: {
      number: "47-883-1129",
      total: 142.18,
      issuedAt: "2026-04-22",
      dueAt: "2026-05-12",
      dueIn: "13 days",
      paid: false,
    },
    items: [
      { name: "Energy charges (412 kWh)", amount: 98.4 },
      { name: "Delivery & service", amount: 32.6 },
      { name: "State surcharge", amount: 6.18 },
      { name: "Taxes", amount: 5.0 },
    ],
    payment: { method: "Visa •••• 4421" },
  },
};
