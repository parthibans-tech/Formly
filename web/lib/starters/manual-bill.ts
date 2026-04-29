import type { Starter } from "./types";

export const manualBillStarter: Starter = {
  id: "manual-bill",
  name: "Manual billing",
  description:
    "Hand-fillable carbon-copy style bill with ruled lines, blanks for write-in, and signature.",
  category: "Billing",
  tags: ["manual", "carbon", "handwritten"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Bill {{ .bill.number }}</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: "Courier New", ui-monospace, monospace; color: #0f172a; padding: 56px 64px; max-width: 760px; margin: auto; background: #fff8e7; }
    .frame { border: 2px solid #0f172a; padding: 18px 22px; background: rgba(255,255,255,.65); }
    .top { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 12px; border-bottom: 1px solid #0f172a; }
    .biz { font-size: 22px; font-weight: 700; letter-spacing: .04em; }
    .biz .sm { font-size: 11px; font-weight: 400; color: #475569; letter-spacing: 0; margin-top: 2px; }
    .stamp { border: 2px solid #b91c1c; color: #b91c1c; padding: 4px 14px; font-weight: 700; letter-spacing: .14em; transform: rotate(-3deg); font-size: 13px; }
    .row { display: flex; gap: 18px; align-items: baseline; margin-top: 10px; font-size: 13px; }
    .row .label { color: #475569; }
    .blank { flex: 1; border-bottom: 1px solid #0f172a; padding: 0 4px 1px; min-height: 18px; font-weight: 600; }
    .blank.short { flex: 0 0 140px; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 13px; }
    th, td { border: 1px solid #0f172a; padding: 8px 10px; }
    th { background: #f1f5f9; text-align: left; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }
    .num { text-align: right; }
    .totals { display: grid; grid-template-columns: 1fr 240px; gap: 16px; margin-top: 16px; }
    .totals .notes { border: 1px dashed #475569; padding: 8px 10px; font-size: 12px; color: #475569; line-height: 1.6; }
    .totals .totals-table { font-size: 13px; }
    .totals .totals-table .row { display: flex; justify-content: space-between; padding: 4px 8px; border-bottom: 1px solid #cbd5e1; margin: 0; }
    .totals .totals-table .row.grand { border-bottom: 0; border-top: 2px solid #0f172a; margin-top: 6px; font-weight: 700; font-size: 15px; }
    .signbox { display: flex; gap: 36px; margin-top: 36px; }
    .signbox .line { flex: 1; border-top: 1px solid #0f172a; padding-top: 4px; font-size: 11px; color: #475569; }
  </style>
</head>
<body>
  <div class="frame">
    <div class="top">
      <div class="biz">
        {{ .merchant.name }}
        <div class="sm">{{ .merchant.address }} · {{ .merchant.phone }}</div>
      </div>
      <div class="stamp">BILL</div>
    </div>

    <div class="row">
      <span class="label">No.</span><span class="blank short">{{ .bill.number }}</span>
      <span class="label">Date</span><span class="blank short">{{ .bill.date | formatDate "02 / 01 / 2006" }}</span>
    </div>
    <div class="row">
      <span class="label">Customer</span><span class="blank">{{ .customer.name }}</span>
    </div>
    <div class="row">
      <span class="label">Address</span><span class="blank">{{ .customer.address }}</span>
    </div>
    <div class="row">
      <span class="label">Phone</span><span class="blank short">{{ .customer.phone }}</span>
      <span class="label">Order #</span><span class="blank short">{{ .bill.orderNo }}</span>
    </div>

    <table>
      <thead>
        <tr>
          <th style="width: 36px;">#</th>
          <th>Description</th>
          <th style="width: 60px;" class="num">Qty</th>
          <th style="width: 90px;" class="num">Rate</th>
          <th style="width: 100px;" class="num">Amount</th>
        </tr>
      </thead>
      <tbody>
        {{ range .items }}
        <tr>
          <td>{{ .no }}</td>
          <td>{{ .description }}</td>
          <td class="num">{{ .qty }}</td>
          <td class="num">{{ .rate | formatCurrency "USD" }}</td>
          <td class="num">{{ .amount | formatCurrency "USD" }}</td>
        </tr>
        {{ end }}
      </tbody>
    </table>

    <div class="totals">
      <div class="notes">
        Notes:<br />
        {{ .notes }}
      </div>
      <div class="totals-table">
        <div class="row"><span>Subtotal</span><span>{{ sum .items "amount" | formatCurrency "USD" }}</span></div>
        <div class="row"><span>Tax</span><span>{{ .totals.tax | formatCurrency "USD" }}</span></div>
        <div class="row grand"><span>Total</span><span>{{ .totals.total | formatCurrency "USD" }}</span></div>
      </div>
    </div>

    <div class="signbox">
      <div class="line">Customer signature</div>
      <div class="line">Authorised signatory<br /><b>{{ .merchant.name }}</b></div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    merchant: {
      name: "Carter Hardware Co.",
      address: "118 Mill Road, Albany NY 12207",
      phone: "+1 (518) 555-0190",
    },
    bill: { number: "5021", date: "2026-04-29", orderNo: "PO-114" },
    customer: {
      name: "Northwind Construction",
      address: "920 Logistics Loop, Sparks NV 89434",
      phone: "+1 (775) 555-0211",
    },
    items: [
      { no: 1, description: "1/2-inch galvanized pipe (10ft)", qty: 12, rate: 14.5, amount: 174 },
      { no: 2, description: 'Brass elbow fitting, 1/2"', qty: 24, rate: 3.85, amount: 92.4 },
      { no: 3, description: "Pipe sealant, large tube", qty: 4, rate: 8.95, amount: 35.8 },
      { no: 4, description: "Threaded floor flange", qty: 8, rate: 12.25, amount: 98 },
    ],
    notes:
      "Goods inspected and accepted by customer. Returns accepted within 7 days with original receipt.",
    totals: { tax: 32.02, total: 432.22 },
  },
};
