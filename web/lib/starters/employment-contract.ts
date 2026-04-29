import type { Starter } from "./types";

export const employmentContractStarter: Starter = {
  id: "employment-contract",
  name: "Employment contract",
  description:
    "Full-form employment agreement with role, compensation, IP, confidentiality, and termination terms.",
  category: "HR",
  tags: ["employment", "contract", "agreement"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Employment Agreement — {{ .employee.name }}</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: "Times New Roman", Georgia, serif; color: #111; padding: 56px 72px; max-width: 760px; margin: auto; line-height: 1.65; font-size: 12.5px; }
    h1 { text-align: center; font-size: 18px; letter-spacing: .08em; text-transform: uppercase; margin: 0 0 28px; }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; margin: 22px 0 8px; }
    p { margin: 0 0 10px; text-align: justify; }
    .parties { background: #f8fafc; border: 1px solid #e2e8f0; padding: 14px 18px; border-radius: 6px; margin: 14px 0; font-size: 12px; }
    .parties b { display: inline-block; min-width: 110px; }
    ol { padding-left: 22px; }
    ol li { margin-bottom: 8px; }
    .sig { margin-top: 56px; display: grid; grid-template-columns: 1fr 1fr; gap: 48px; }
    .sig .line { border-top: 1px solid #111; padding-top: 6px; font-size: 12px; }
    .sig .muted { font-size: 10.5px; color: #555; }
  </style>
</head>
<body>
  <h1>Employment Agreement</h1>

  <p>
    This Employment Agreement (this "<b>Agreement</b>") is entered into on
    {{ .agreementDate | formatDate "January 2, 2006" }} between
    <b>{{ .company.name }}</b> ("<b>Company</b>") and <b>{{ .employee.name }}</b>
    ("<b>Employee</b>").
  </p>

  <div class="parties">
    <div><b>Company:</b> {{ .company.name }}, {{ .company.address }}</div>
    <div><b>Employee:</b> {{ .employee.name }}, {{ .employee.address }}</div>
    <div><b>Position:</b> {{ .role.title }}, reporting to {{ .role.manager }}</div>
    <div><b>Start date:</b> {{ .role.start | formatDate "January 2, 2006" }}</div>
  </div>

  <ol>
    <li>
      <h2>Position and duties</h2>
      Employee is engaged as <b>{{ .role.title }}</b> and shall perform the duties customarily
      associated with the role and such other duties as the Company may reasonably assign.
      Employee shall devote substantially all working time to Company business.
    </li>

    <li>
      <h2>Compensation</h2>
      Employee will be paid an annualized base salary of
      <b>{{ .comp.base | formatCurrency .comp.currency }}</b>, paid in accordance with the
      Company's standard payroll practices. {{ if .comp.bonus }}Employee may also be eligible
      for an annual target bonus of {{ .comp.bonus | formatCurrency .comp.currency }} subject
      to performance.{{ end }}
    </li>

    <li>
      <h2>Benefits</h2>
      Employee is eligible to participate in the Company's standard benefits programs as in
      effect from time to time, including health insurance, retirement plans, and paid time off.
    </li>

    <li>
      <h2>Confidentiality</h2>
      Employee agrees to keep confidential all non-public information of the Company, including
      trade secrets, customer information, financial data, and product plans. This obligation
      survives termination.
    </li>

    <li>
      <h2>Intellectual property</h2>
      All inventions, works of authorship, and intellectual property created by Employee in the
      course of employment shall be the sole and exclusive property of the Company.
    </li>

    <li>
      <h2>Termination</h2>
      Employment is at-will and may be terminated by either party with
      <b>{{ .notice }}</b> written notice. The Company may terminate immediately for cause.
      Upon termination, Employee shall return all Company property and confidential materials.
    </li>

    <li>
      <h2>Non-solicitation</h2>
      For a period of <b>{{ .nonSolicitMonths }} months</b> following termination, Employee
      shall not solicit Company employees or customers for a competing business.
    </li>

    <li>
      <h2>Governing law</h2>
      This Agreement shall be governed by the laws of {{ .governingLaw }}, without regard to
      its conflict-of-laws principles.
    </li>
  </ol>

  <p>
    The parties have executed this Agreement as of the date first written above.
  </p>

  <div class="sig">
    <div class="line">
      {{ .company.signatory }}
      <div class="muted">{{ .company.signatoryTitle }} · {{ .company.name }}</div>
    </div>
    <div class="line">
      {{ .employee.name }}
      <div class="muted">Date: ______________</div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    agreementDate: "2026-04-30",
    notice: "30 days'",
    nonSolicitMonths: 12,
    governingLaw: "the State of Delaware",
    company: {
      name: "Lumen Labs, Inc.",
      address: "100 Market Street, San Francisco, CA 94105",
      signatory: "Alex Morgan",
      signatoryTitle: "Chief Executive Officer",
    },
    employee: {
      name: "Priya Ramesh",
      address: "42 Oak Avenue, Berkeley, CA 94704",
    },
    role: {
      title: "Senior Software Engineer",
      manager: "Sam Okafor",
      start: "2026-05-15",
    },
    comp: {
      base: 175000,
      bonus: 20000,
      currency: "USD",
    },
  },
};
