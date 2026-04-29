import type { Starter } from "./types";

export const expenseReportStarter: Starter = {
  id: "expense-report",
  name: "Expense report",
  description:
    "Travel & expense report with itemized line items, receipts column, and totals.",
  category: "Reports",
  tags: ["expense", "report", "travel"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Expense report — {{ .employee.name }}</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; color: #0f172a; padding: 48px; max-width: 820px; margin: auto; line-height: 1.5; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 14px; border-bottom: 2px solid #0f172a; }
    h1 { margin: 0; font-size: 24px; letter-spacing: -.01em; }
    .sub { color: #64748b; font-size: 13px; margin-top: 2px; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-top: 22px; font-size: 13px; }
    .grid b { display: block; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: #64748b; font-weight: 700; margin-bottom: 2px; }
    table { width: 100%; border-collapse: collapse; margin-top: 24px; font-size: 13px; }
    th, td { padding: 10px 10px; border-bottom: 1px solid #e2e8f0; text-align: left; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; font-weight: 700; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .cat { font-size: 11px; padding: 2px 8px; background: #f1f5f9; border-radius: 999px; color: #475569; font-weight: 600; }
    .check { font-size: 14px; color: #16a34a; }
    tfoot td { font-weight: 700; border-bottom: 0; padding-top: 12px; }
    .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-top: 24px; }
    .stat { padding: 14px 16px; border-radius: 10px; border: 1px solid #e2e8f0; }
    .stat .label { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: #64748b; font-weight: 700; }
    .stat .value { font-size: 20px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
    .signbox { margin-top: 36px; display: flex; gap: 36px; }
    .signbox .line { flex: 1; border-top: 1px solid #0f172a; padding-top: 6px; font-size: 12px; color: #64748b; }
    .signbox .line b { color: #0f172a; display: block; font-size: 13px; margin-top: 2px; }
  </style>
</head>
<body>
  <div class="head">
    <div>
      <h1>Expense Report</h1>
      <div class="sub">{{ .report.purpose }}</div>
    </div>
    <div style="text-align: right; font-size: 12px; color: #64748b;">
      Submitted {{ .report.submittedAt | formatDate "Jan 2, 2006" }}<br />
      <span style="color: #0f172a; font-weight: 600;">{{ .report.number }}</span>
    </div>
  </div>

  <div class="grid">
    <div><b>Employee</b>{{ .employee.name }}</div>
    <div><b>Department</b>{{ .employee.department }}</div>
    <div><b>Manager</b>{{ .employee.manager }}</div>
    <div><b>Cost center</b>{{ .employee.costCenter }}</div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Date</th>
        <th>Description</th>
        <th>Category</th>
        <th>Vendor</th>
        <th>Receipt</th>
        <th class="num">Amount</th>
      </tr>
    </thead>
    <tbody>
      {{ range .items }}
      <tr>
        <td>{{ .date | formatDate "Jan 2" }}</td>
        <td>{{ .description }}</td>
        <td><span class="cat">{{ .category }}</span></td>
        <td>{{ .vendor }}</td>
        <td>{{ if .receipt }}<span class="check">✓</span>{{ else }}—{{ end }}</td>
        <td class="num">{{ .amount | formatCurrency "USD" }}</td>
      </tr>
      {{ end }}
    </tbody>
    <tfoot>
      <tr><td colspan="5" class="num">Total</td><td class="num">{{ sum .items "amount" | formatCurrency "USD" }}</td></tr>
    </tfoot>
  </table>

  <div class="summary">
    <div class="stat"><div class="label">Total expenses</div><div class="value">{{ .totals.gross | formatCurrency "USD" }}</div></div>
    <div class="stat"><div class="label">Less: cash advance</div><div class="value">{{ .totals.advance | formatCurrency "USD" }}</div></div>
    <div class="stat" style="background: #0f172a; color: white; border-color: #0f172a;">
      <div class="label" style="color: #cbd5e1;">Reimbursement due</div>
      <div class="value">{{ .totals.due | formatCurrency "USD" }}</div>
    </div>
  </div>

  <div class="signbox">
    <div class="line">Employee<b>{{ .employee.name }}</b></div>
    <div class="line">Approver<b>{{ .employee.manager }}</b></div>
  </div>
</body>
</html>
`,
  sampleData: {
    report: {
      number: "EXP-2026-0431",
      purpose: "Customer onsite — Lumen Health, Boston (Apr 14–16)",
      submittedAt: "2026-04-22",
    },
    employee: {
      name: "Maya Patel",
      department: "Design",
      manager: "Owen Bates",
      costCenter: "DSGN-301",
    },
    items: [
      { date: "2026-04-14", description: "Round-trip flight SFO–BOS", category: "Travel", vendor: "United", receipt: true, amount: 612.4 },
      { date: "2026-04-14", description: "Rideshare SFO airport", category: "Travel", vendor: "Lyft", receipt: true, amount: 38.2 },
      { date: "2026-04-14", description: "Hotel — 2 nights", category: "Lodging", vendor: "Liberty Hotel Boston", receipt: true, amount: 462.0 },
      { date: "2026-04-15", description: "Team dinner with client", category: "Meals", vendor: "Row 34", receipt: true, amount: 218.5 },
      { date: "2026-04-15", description: "Working coffee w/ PM team", category: "Meals", vendor: "George Howell", receipt: true, amount: 24.6 },
      { date: "2026-04-16", description: "Rideshare to BOS airport", category: "Travel", vendor: "Lyft", receipt: true, amount: 41.8 },
      { date: "2026-04-16", description: "Inflight wifi", category: "Other", vendor: "United", receipt: false, amount: 19.0 },
    ],
    totals: { gross: 1416.5, advance: 500, due: 916.5 },
  },
};
