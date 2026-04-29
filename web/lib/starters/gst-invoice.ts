import type { Starter } from "./types";

export const gstInvoiceStarter: Starter = {
  id: "gst-invoice",
  name: "GST tax invoice",
  description:
    "India GST tax invoice with GSTIN, HSN/SAC, CGST/SGST/IGST split, and amount in words.",
  category: "Billing",
  tags: ["gst", "india", "tax", "invoice", "hsn"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Tax Invoice {{ .invoice.number }}</title>
  <style>
    @page { size: A4; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #111; padding: 28px 32px; max-width: 820px; margin: auto; line-height: 1.45; font-size: 12px; }
    .frame { border: 1.5px solid #111; }
    .center { text-align: center; }
    .b { font-weight: 700; }
    .title { background: #111; color: white; text-align: center; padding: 8px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; font-size: 13px; }
    .head { padding: 14px 18px; border-bottom: 1px solid #111; display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    .head .biz { flex: 1; }
    .head .biz .name { font-size: 18px; font-weight: 800; letter-spacing: -.01em; }
    .head .biz .sm { font-size: 11px; color: #444; }
    .head .gstin { background: #fef3c7; border: 1px dashed #b45309; padding: 6px 10px; font-size: 11px; }
    .head .gstin b { color: #92400e; display: block; font-size: 13px; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; }
    .grid2 > div { padding: 12px 18px; }
    .grid2 > div:first-child { border-right: 1px solid #111; }
    .grid2 .label { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: #555; font-weight: 700; }
    .grid2 .name { font-size: 13px; font-weight: 700; margin-top: 2px; }
    .grid2 .sm { font-size: 11px; color: #444; line-height: 1.5; }
    .grid2 .row { display: flex; gap: 4px; font-size: 11px; margin-top: 2px; }
    .grid2 .row b { font-weight: 600; min-width: 60px; }
    .meta { display: grid; grid-template-columns: repeat(4, 1fr); border-top: 1px solid #111; }
    .meta > div { padding: 8px 14px; border-right: 1px solid #111; font-size: 11px; }
    .meta > div:last-child { border-right: 0; }
    .meta .label { color: #555; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; }
    .meta .v { font-weight: 700; font-size: 12px; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    th, td { border: 1px solid #111; padding: 6px 8px; text-align: left; vertical-align: top; }
    th { background: #f3f4f6; font-size: 10px; letter-spacing: .04em; text-transform: uppercase; font-weight: 700; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .totals { display: grid; grid-template-columns: 1.4fr 1fr; }
    .totals .words { padding: 14px 18px; border-right: 1px solid #111; }
    .totals .words .label { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: #555; font-weight: 700; }
    .totals .words .text { font-weight: 700; font-size: 13px; margin-top: 4px; line-height: 1.4; }
    .totals .nums table { font-size: 11px; }
    .totals .nums table td { border: 0; border-bottom: 1px dashed #94a3b8; padding: 6px 14px; }
    .totals .nums table tr:last-child td { border-bottom: 0; padding-top: 8px; font-weight: 800; font-size: 13px; background: #fef3c7; }
    .terms { display: grid; grid-template-columns: 1.4fr 1fr; border-top: 1px solid #111; }
    .terms .t { padding: 12px 18px; border-right: 1px solid #111; font-size: 11px; color: #444; }
    .terms .t b { color: #111; display: block; margin-bottom: 4px; }
    .terms .sig { padding: 16px 18px; text-align: right; font-size: 11px; }
    .terms .sig .for { color: #555; font-size: 10px; letter-spacing: .04em; text-transform: uppercase; font-weight: 700; }
    .terms .sig .name { font-weight: 700; font-size: 13px; margin-top: 2px; }
    .terms .sig .line { margin-top: 36px; border-top: 1px solid #111; padding-top: 4px; font-size: 10px; color: #555; }
  </style>
</head>
<body>
  <div class="frame">
    <div class="title">Tax Invoice</div>

    <div class="head">
      <div class="biz">
        <div class="name">{{ .seller.name }}</div>
        <div class="sm">{{ .seller.address }}</div>
        <div class="sm">{{ .seller.email }} · {{ .seller.phone }}</div>
      </div>
      <div class="gstin">
        GSTIN<b>{{ .seller.gstin }}</b>
        State: {{ .seller.state }} ({{ .seller.stateCode }})<br />
        PAN: {{ .seller.pan }}
      </div>
    </div>

    <div class="grid2">
      <div>
        <div class="label">Bill to</div>
        <div class="name">{{ .buyer.name }}</div>
        <div class="sm">{{ .buyer.address }}</div>
        <div class="row"><b>GSTIN</b><span>{{ .buyer.gstin }}</span></div>
        <div class="row"><b>State</b><span>{{ .buyer.state }} ({{ .buyer.stateCode }})</span></div>
      </div>
      <div>
        <div class="label">Ship to</div>
        <div class="name">{{ .shipTo.name }}</div>
        <div class="sm">{{ .shipTo.address }}</div>
        <div class="row"><b>State</b><span>{{ .shipTo.state }} ({{ .shipTo.stateCode }})</span></div>
      </div>
    </div>

    <div class="meta">
      <div><div class="label">Invoice no.</div><div class="v">{{ .invoice.number }}</div></div>
      <div><div class="label">Invoice date</div><div class="v">{{ .invoice.date | formatDate "02 Jan 2006" }}</div></div>
      <div><div class="label">Place of supply</div><div class="v">{{ .invoice.placeOfSupply }}</div></div>
      <div><div class="label">Reverse charge</div><div class="v">{{ .invoice.reverseCharge }}</div></div>
    </div>

    <table>
      <thead>
        <tr>
          <th style="width: 28px;">#</th>
          <th>Description</th>
          <th style="width: 70px;">HSN/SAC</th>
          <th style="width: 50px;" class="num">Qty</th>
          <th style="width: 80px;" class="num">Rate (₹)</th>
          <th style="width: 80px;" class="num">Taxable (₹)</th>
          <th style="width: 80px;" class="num">CGST (₹)</th>
          <th style="width: 80px;" class="num">SGST (₹)</th>
          <th style="width: 80px;" class="num">IGST (₹)</th>
          <th style="width: 90px;" class="num">Total (₹)</th>
        </tr>
      </thead>
      <tbody>
        {{ range .items }}
        <tr>
          <td>{{ .no }}</td>
          <td>
            <div style="font-weight: 600;">{{ .name }}</div>
            {{ if .detail }}<div style="font-size: 10px; color: #555;">{{ .detail }}</div>{{ end }}
          </td>
          <td>{{ .hsn }}</td>
          <td class="num">{{ .qty }}</td>
          <td class="num">{{ .rate }}</td>
          <td class="num">{{ .taxable }}</td>
          <td class="num">{{ .cgst }}<div style="font-size: 9px; color: #555;">{{ .cgstPct }}%</div></td>
          <td class="num">{{ .sgst }}<div style="font-size: 9px; color: #555;">{{ .sgstPct }}%</div></td>
          <td class="num">{{ .igst }}</td>
          <td class="num b">{{ .total }}</td>
        </tr>
        {{ end }}
      </tbody>
      <tfoot>
        <tr style="background: #f3f4f6;">
          <td colspan="5" class="b">Totals</td>
          <td class="num b">{{ .totals.taxable }}</td>
          <td class="num b">{{ .totals.cgst }}</td>
          <td class="num b">{{ .totals.sgst }}</td>
          <td class="num b">{{ .totals.igst }}</td>
          <td class="num b">{{ .totals.gross }}</td>
        </tr>
      </tfoot>
    </table>

    <div class="totals">
      <div class="words">
        <div class="label">Amount in words</div>
        <div class="text">{{ .totals.inWords }}</div>
      </div>
      <div class="nums">
        <table>
          <tbody>
            <tr><td>Taxable amount</td><td class="num">₹ {{ .totals.taxable }}</td></tr>
            <tr><td>CGST</td><td class="num">₹ {{ .totals.cgst }}</td></tr>
            <tr><td>SGST</td><td class="num">₹ {{ .totals.sgst }}</td></tr>
            <tr><td>IGST</td><td class="num">₹ {{ .totals.igst }}</td></tr>
            <tr><td>Round off</td><td class="num">₹ {{ .totals.roundOff }}</td></tr>
            <tr><td>Grand total</td><td class="num">₹ {{ .totals.grand }}</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="terms">
      <div class="t">
        <b>Bank details</b>
        {{ .bank.name }} · A/c {{ .bank.account }}<br />
        IFSC: {{ .bank.ifsc }} · Branch: {{ .bank.branch }}<br /><br />
        <b>Terms & conditions</b>
        {{ .terms }}
      </div>
      <div class="sig">
        <div class="for">For</div>
        <div class="name">{{ .seller.name }}</div>
        <div class="line">Authorised signatory</div>
      </div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    seller: {
      name: "Saraswati Textiles Pvt Ltd",
      address: "No. 84, Industrial Area Phase II, Bengaluru 560058, Karnataka",
      email: "accounts@saraswati.example",
      phone: "+91 80 4567 8901",
      gstin: "29AABCS1234L1Z2",
      pan: "AABCS1234L",
      state: "Karnataka",
      stateCode: "29",
    },
    buyer: {
      name: "Indigo Apparel Pvt Ltd",
      address: "Plot 14, Sector 18, Gurugram 122015, Haryana",
      gstin: "06AAACI5678M1ZK",
      state: "Haryana",
      stateCode: "06",
    },
    shipTo: {
      name: "Indigo Apparel — DC North",
      address: "Khasra 412, Pataudi Road, Manesar 122051, Haryana",
      state: "Haryana",
      stateCode: "06",
    },
    invoice: {
      number: "ST/26-27/0184",
      date: "2026-04-22",
      placeOfSupply: "Haryana (06)",
      reverseCharge: "No",
    },
    items: [
      {
        no: 1, name: "Cotton fabric, 60s combed, white", detail: "Roll, 50m × 1.6m", hsn: "5208",
        qty: 24, rate: "1,250.00", taxable: "30,000.00",
        cgst: "—", cgstPct: 0, sgst: "—", sgstPct: 0, igst: "1,500.00",
        total: "31,500.00",
      },
      {
        no: 2, name: "Polyester thread, 5000m spool", detail: "Carton of 24", hsn: "5402",
        qty: 6, rate: "2,400.00", taxable: "14,400.00",
        cgst: "—", cgstPct: 0, sgst: "—", sgstPct: 0, igst: "1,728.00",
        total: "16,128.00",
      },
      {
        no: 3, name: "Stitching service charge", detail: "Per piece, 4,200 pieces", hsn: "9988",
        qty: 4200, rate: "9.00", taxable: "37,800.00",
        cgst: "—", cgstPct: 0, sgst: "—", sgstPct: 0, igst: "6,804.00",
        total: "44,604.00",
      },
    ],
    totals: {
      taxable: "82,200.00",
      cgst: "0.00",
      sgst: "0.00",
      igst: "10,032.00",
      roundOff: "0.00",
      gross: "92,232.00",
      grand: "92,232.00",
      inWords:
        "Indian Rupees Ninety-Two Thousand Two Hundred Thirty-Two Only",
    },
    bank: {
      name: "HDFC Bank",
      account: "501010012345678",
      ifsc: "HDFC0000412",
      branch: "Peenya, Bengaluru",
    },
    terms:
      "Payment due within 30 days from invoice date. Goods once sold will not be taken back. Disputes subject to Bengaluru jurisdiction.",
  },
};
