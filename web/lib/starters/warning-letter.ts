import type { Starter } from "./types";

export const warningLetterStarter: Starter = {
  id: "warning-letter",
  name: "Warning letter",
  description:
    "Formal written warning documenting a performance or conduct issue, expectations, and consequences.",
  category: "HR",
  tags: ["warning", "discipline", "hr"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Written Warning — {{ .employee.name }}</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #111; padding: 56px 72px; max-width: 720px; margin: auto; line-height: 1.65; font-size: 13px; }
    .brand { font-weight: 700; font-size: 17px; }
    .muted { color: #64748b; font-size: 12px; }
    .alert { display: inline-block; background: #fef3c7; color: #92400e; border: 1px solid #fcd34d; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; margin-top: 14px; }
    h1 { font-size: 20px; margin: 12px 0 8px; }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; margin: 22px 0 6px; color: #b45309; }
    p { margin: 0 0 10px; text-align: justify; }
    .meta { display: grid; grid-template-columns: 140px 1fr; gap: 4px 14px; font-size: 12px; background: #fffbeb; border: 1px solid #fde68a; padding: 12px 16px; border-radius: 6px; }
    .meta dt { font-weight: 600; color: #92400e; }
    ul { padding-left: 22px; }
    li { margin-bottom: 4px; }
    .ack { margin-top: 36px; padding: 14px 16px; border: 1px dashed #94a3b8; border-radius: 6px; font-size: 12px; }
    .sig { margin-top: 28px; display: grid; grid-template-columns: 1fr 1fr; gap: 36px; }
    .sig .line { border-top: 1px solid #111; padding-top: 6px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="brand">{{ .company.name }}</div>
  <div class="muted">{{ .letterDate | formatDate "January 2, 2006" }}</div>
  <span class="alert">Confidential — {{ .level }} Written Warning</span>

  <h1>To: {{ .employee.name }}</h1>

  <dl class="meta">
    <dt>Position</dt><dd>{{ .employee.title }}</dd>
    <dt>Department</dt><dd>{{ .employee.department }}</dd>
    <dt>Manager</dt><dd>{{ .employee.manager }}</dd>
    <dt>Issue date</dt><dd>{{ .letterDate | formatDate "January 2, 2006" }}</dd>
  </dl>

  <h2>Reason for warning</h2>
  <p>{{ .reason }}</p>

  <h2>Specific incidents</h2>
  <ul>
    {{ range .incidents }}<li>{{ . }}</li>{{ end }}
  </ul>

  <h2>Expectations going forward</h2>
  <ul>
    {{ range .expectations }}<li>{{ . }}</li>{{ end }}
  </ul>

  <h2>Consequences</h2>
  <p>
    Failure to meet these expectations by <b>{{ .reviewDate | formatDate "January 2, 2006" }}</b>
    may result in further disciplinary action, up to and including termination of employment.
    A follow-up review will take place on that date with {{ .employee.manager }} and a member
    of the People team.
  </p>

  <h2>Support available</h2>
  <p>
    If circumstances outside of work are contributing to these challenges, please reach out to
    {{ .hrContact.name }} ({{ .hrContact.email }}). The Employee Assistance Program is also
    available confidentially.
  </p>

  <div class="ack">
    <b>Acknowledgement.</b> By signing below, the employee acknowledges receiving this warning
    and understanding its contents. Signing does not necessarily indicate agreement with the
    contents.
  </div>

  <div class="sig">
    <div class="line">
      {{ .employee.manager }}
      <div class="muted">Manager</div>
    </div>
    <div class="line">
      {{ .employee.name }}
      <div class="muted">Employee · Date: ______________</div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    letterDate: "2026-04-30",
    reviewDate: "2026-06-30",
    level: "First",
    company: { name: "Lumen Labs, Inc." },
    employee: {
      name: "Jordan Kim",
      title: "Account Executive",
      department: "Sales",
      manager: "Reena Patel",
    },
    reason:
      "Repeated missed deadlines and absence from required customer touchpoints over the last 60 days, despite verbal guidance on March 5 and March 22.",
    incidents: [
      "Missed three of the last five weekly forecast submissions (Mar 28, Apr 4, Apr 18).",
      "Did not attend the customer kickoff call for the Atlas account on April 9 without notice.",
      "Submitted the Q1 close summary 11 days past the agreed-upon deadline.",
    ],
    expectations: [
      "Submit weekly forecasts by 5pm every Friday, no exceptions.",
      "Attend all scheduled customer calls or arrange coverage at least 24 hours in advance.",
      "Complete and document a remediation plan with your manager within 14 days of this letter.",
    ],
    hrContact: {
      name: "Dana Lee",
      email: "dana.lee@lumenlabs.example",
    },
  },
};
