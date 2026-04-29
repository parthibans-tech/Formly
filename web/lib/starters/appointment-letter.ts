import type { Starter } from "./types";

export const appointmentLetterStarter: Starter = {
  id: "appointment-letter",
  name: "Appointment letter",
  description:
    "Formal joining letter issued after offer acceptance — designation, terms, probation, and code of conduct.",
  category: "HR",
  tags: ["appointment", "joining", "employment"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Appointment Letter — {{ .employee.name }}</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: "Georgia", serif; color: #111; padding: 56px 72px; max-width: 760px; margin: auto; line-height: 1.65; font-size: 12.5px; }
    .head { display: flex; justify-content: space-between; align-items: flex-end; padding-bottom: 14px; border-bottom: 2px solid #0f172a; }
    .head .brand { font-weight: 700; font-size: 20px; }
    .head .muted { color: #555; font-size: 11.5px; line-height: 1.5; }
    h1 { font-size: 18px; margin: 28px 0 4px; text-align: center; letter-spacing: .04em; text-transform: uppercase; }
    .ref { text-align: center; font-size: 11.5px; color: #555; margin-bottom: 16px; }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; margin: 22px 0 6px; color: #0f172a; }
    p { margin: 0 0 10px; text-align: justify; }
    .terms { padding-left: 22px; }
    .terms li { margin-bottom: 8px; }
    .sig { margin-top: 56px; display: grid; grid-template-columns: 1fr 1fr; gap: 48px; }
    .sig .line { border-top: 1px solid #111; padding-top: 6px; font-size: 12px; }
    .sig .muted { font-size: 10.5px; color: #555; }
  </style>
</head>
<body>
  <div class="head">
    <div>
      <div class="brand">{{ .company.name }}</div>
      <div class="muted">{{ .company.address }}</div>
      <div class="muted">CIN: {{ .company.cin }}</div>
    </div>
    <div class="muted" style="text-align:right">
      Ref: {{ .ref }}<br />
      {{ .letterDate | formatDate "January 2, 2006" }}
    </div>
  </div>

  <h1>Letter of Appointment</h1>
  <div class="ref">Strictly private &amp; confidential</div>

  <p>To,<br />
    <b>{{ .employee.name }}</b><br />
    {{ .employee.address }}
  </p>

  <p>Dear {{ .employee.name }},</p>

  <p>
    With reference to your application and the subsequent interviews, we are pleased to appoint
    you as <b>{{ .role.title }}</b> in the <b>{{ .role.department }}</b> department of
    {{ .company.name }} on the following terms and conditions.
  </p>

  <h2>Terms of appointment</h2>
  <ol class="terms">
    <li>
      <b>Date of joining.</b> Your employment begins on
      {{ .role.start | formatDate "Monday, January 2, 2006" }} at {{ .role.location }}.
    </li>
    <li>
      <b>Compensation.</b> Your annual cost-to-company is
      {{ .comp.ctc | formatCurrency .comp.currency }}, structured as detailed in Annexure A.
      Salary will be paid by the {{ .comp.payDay }} of every month.
    </li>
    <li>
      <b>Probation.</b> The first {{ .probationMonths }} months will be a probationary period,
      during which either party may terminate the engagement with {{ .probationNotice }} notice
      in writing. Confirmation in service is subject to satisfactory performance.
    </li>
    <li>
      <b>Notice period.</b> After confirmation, either party may terminate the engagement with
      {{ .notice }} written notice or salary in lieu thereof.
    </li>
    <li>
      <b>Working hours.</b> Standard working hours are
      {{ .workingHours }}, with flexibility as agreed with your manager.
    </li>
    <li>
      <b>Leave.</b> You will be eligible for {{ .leaveDays }} days of paid leave per calendar
      year, in addition to public holidays announced by the Company.
    </li>
    <li>
      <b>Confidentiality.</b> You shall not disclose any confidential information of the
      Company, its customers, or partners during or after your employment.
    </li>
    <li>
      <b>Code of conduct.</b> You agree to abide by the Company's policies on integrity,
      anti-harassment, IT security, and conflict of interest, as updated from time to time.
    </li>
    <li>
      <b>Background verification.</b> This appointment is contingent upon satisfactory
      verification of your education, employment history, and references.
    </li>
  </ol>

  <p>
    Please sign and return a copy of this letter as a token of your acceptance no later than
    <b>{{ .acceptBy | formatDate "January 2, 2006" }}</b>. We look forward to a long and
    rewarding association with you.
  </p>

  <div class="sig">
    <div class="line">
      {{ .company.signatory }}
      <div class="muted">{{ .company.signatoryTitle }} · {{ .company.name }}</div>
    </div>
    <div class="line">
      {{ .employee.name }}
      <div class="muted">Accepted on ______________</div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    ref: "LL/HR/2026/0451",
    letterDate: "2026-04-30",
    acceptBy: "2026-05-10",
    probationMonths: 6,
    probationNotice: "15 days'",
    notice: "60 days'",
    workingHours: "9:30 AM to 6:30 PM, Monday to Friday",
    leaveDays: 24,
    company: {
      name: "Lumen Labs Private Limited",
      address: "Tower B, Prestige Tech Park, Bengaluru 560103",
      cin: "U72200KA2018PTC112233",
      signatory: "Reena Patel",
      signatoryTitle: "Head of People",
    },
    employee: {
      name: "Priya Ramesh",
      address: "Apt 502, Lake View Apartments, Indiranagar, Bengaluru 560038",
    },
    role: {
      title: "Senior Software Engineer",
      department: "Engineering",
      location: "Bengaluru office (hybrid)",
      start: "2026-05-19",
    },
    comp: {
      ctc: 2400000,
      currency: "INR",
      payDay: "last working",
    },
  },
};
