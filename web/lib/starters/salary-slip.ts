import type { Starter } from "./types";

export const salarySlipStarter: Starter = {
  id: "salary-slip",
  name: "Salary slip",
  description:
    "Monthly pay stub with earnings, deductions, employer contributions, and net pay.",
  category: "HR",
  tags: ["payslip", "salary", "payroll"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Pay slip — {{ .employee.name }} · {{ .period }}</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #111; padding: 40px 48px; max-width: 760px; margin: auto; font-size: 12px; line-height: 1.5; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 14px; border-bottom: 2px solid #0f172a; }
    .head .brand { font-size: 18px; font-weight: 700; }
    .head .muted { color: #64748b; font-size: 11px; }
    .head .right { text-align: right; }
    .head .right h1 { margin: 0; font-size: 16px; text-transform: uppercase; letter-spacing: .08em; }
    .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 22px; padding: 14px 0 18px; border-bottom: 1px solid #e2e8f0; }
    .meta div { font-size: 12px; }
    .meta b { color: #0f172a; }
    .meta .lbl { color: #64748b; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 18px; }
    .panel h2 { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; background: #0f172a; color: white; padding: 6px 10px; margin: 0; border-radius: 4px 4px 0 0; }
    .panel table { width: 100%; border-collapse: collapse; border: 1px solid #e2e8f0; border-top: none; }
    .panel td { padding: 6px 10px; font-size: 12px; border-bottom: 1px solid #f1f5f9; }
    .panel td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
    .panel tr.total td { font-weight: 700; background: #f8fafc; border-top: 2px solid #0f172a; border-bottom: none; }
    .net { margin-top: 22px; background: #ecfdf5; border: 1px solid #a7f3d0; padding: 16px 22px; border-radius: 10px; display: flex; justify-content: space-between; align-items: center; }
    .net b { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #047857; }
    .net .amount { font-size: 28px; font-weight: 800; color: #064e3b; font-variant-numeric: tabular-nums; }
    .footer { margin-top: 22px; font-size: 10.5px; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="head">
    <div>
      <div class="brand">{{ .company.name }}</div>
      <div class="muted">{{ .company.address }}</div>
      <div class="muted">CIN: {{ .company.cin }}</div>
    </div>
    <div class="right">
      <h1>Pay slip</h1>
      <div class="muted">For the period {{ .period }}</div>
      <div class="muted">Pay date: {{ .payDate | formatDate "January 2, 2006" }}</div>
    </div>
  </div>

  <div class="meta">
    <div><span class="lbl">Employee</span> <b>{{ .employee.name }}</b></div>
    <div><span class="lbl">Employee ID</span> {{ .employee.id }}</div>
    <div><span class="lbl">Designation</span> {{ .employee.title }}</div>
    <div><span class="lbl">Department</span> {{ .employee.department }}</div>
    <div><span class="lbl">PAN</span> {{ .employee.pan }}</div>
    <div><span class="lbl">Bank</span> {{ .employee.bank }}</div>
    <div><span class="lbl">Days worked</span> {{ .daysWorked }} / {{ .daysInPeriod }}</div>
    <div><span class="lbl">PF / UAN</span> {{ .employee.uan }}</div>
  </div>

  <div class="grid">
    <div class="panel">
      <h2>Earnings</h2>
      <table>
        {{ range .earnings }}
        <tr><td>{{ .label }}</td><td>{{ .amount | formatCurrency $.currency }}</td></tr>
        {{ end }}
        <tr class="total"><td>Gross earnings</td><td>{{ .totals.gross | formatCurrency .currency }}</td></tr>
      </table>
    </div>
    <div class="panel">
      <h2>Deductions</h2>
      <table>
        {{ range .deductions }}
        <tr><td>{{ .label }}</td><td>{{ .amount | formatCurrency $.currency }}</td></tr>
        {{ end }}
        <tr class="total"><td>Total deductions</td><td>{{ .totals.deductions | formatCurrency .currency }}</td></tr>
      </table>
    </div>
  </div>

  <div class="net">
    <div>
      <b>Net pay</b>
      <div class="muted" style="font-size:11px">Credited to {{ .employee.bank }}</div>
    </div>
    <div class="amount">{{ .totals.net | formatCurrency .currency }}</div>
  </div>

  <div class="footer">
    This is a system-generated pay slip and does not require a signature.
  </div>
</body>
</html>
`,
  sampleData: {
    period: "April 2026",
    payDate: "2026-04-30",
    daysWorked: 22,
    daysInPeriod: 22,
    currency: "INR",
    company: {
      name: "Lumen Labs Private Limited",
      address: "Tower B, Prestige Tech Park, Bengaluru 560103",
      cin: "U72200KA2018PTC112233",
    },
    employee: {
      name: "Priya Ramesh",
      id: "LL-0451",
      title: "Senior Software Engineer",
      department: "Engineering",
      pan: "ABCDE1234F",
      uan: "100234561234",
      bank: "HDFC Bank · A/C ****4421",
    },
    earnings: [
      { label: "Basic salary", amount: 90000 },
      { label: "House Rent Allowance", amount: 36000 },
      { label: "Special allowance", amount: 24000 },
      { label: "Conveyance", amount: 1600 },
      { label: "Performance bonus", amount: 8000 },
    ],
    deductions: [
      { label: "Provident Fund (12%)", amount: 10800 },
      { label: "Professional tax", amount: 200 },
      { label: "TDS (Income tax)", amount: 12500 },
      { label: "Health insurance premium", amount: 750 },
    ],
    totals: {
      gross: 159600,
      deductions: 24250,
      net: 135350,
    },
  },
};
