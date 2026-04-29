import type { Starter } from "./types";

export const leaveApplicationStarter: Starter = {
  id: "leave-application",
  name: "Leave application",
  description:
    "Employee leave request with type, dates, reason, handover plan, and manager approval block.",
  category: "HR",
  tags: ["leave", "request", "application"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Leave Application — {{ .employee.name }}</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #111; padding: 48px 56px; max-width: 720px; margin: auto; line-height: 1.65; font-size: 13px; }
    .head { display: flex; justify-content: space-between; align-items: flex-end; padding-bottom: 14px; border-bottom: 2px solid #0f172a; margin-bottom: 18px; }
    .head h1 { margin: 0; font-size: 22px; }
    .head .muted { color: #64748b; font-size: 12px; text-align: right; }
    .badge { display: inline-block; background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
    h2 { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: #0f172a; margin: 22px 0 8px; }
    .grid { display: grid; grid-template-columns: 160px 1fr; gap: 6px 14px; font-size: 12.5px; padding: 12px 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; }
    .grid dt { color: #64748b; }
    .grid b { color: #0f172a; }
    .reason { background: #fffbeb; border-left: 4px solid #f59e0b; padding: 12px 16px; border-radius: 0 6px 6px 0; font-size: 12.5px; margin: 12px 0; }
    ul { padding-left: 20px; font-size: 12.5px; }
    li { margin-bottom: 3px; }
    .approval { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 32px; }
    .approval .box { border: 1px solid #cbd5e1; border-radius: 8px; padding: 14px 16px; min-height: 100px; font-size: 12px; }
    .approval .box b { display: block; margin-bottom: 4px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #0f172a; }
    .approval .line { border-top: 1px solid #111; margin-top: 38px; padding-top: 4px; font-size: 11px; color: #64748b; }
  </style>
</head>
<body>
  <div class="head">
    <div>
      <h1>Leave application</h1>
      <span class="badge">{{ .leaveType }}</span>
    </div>
    <div class="muted">
      Submitted: {{ .submitted | formatDate "January 2, 2006" }}<br />
      Reference: {{ .ref }}
    </div>
  </div>

  <h2>Employee details</h2>
  <dl class="grid">
    <dt>Name</dt><dd><b>{{ .employee.name }}</b></dd>
    <dt>Employee ID</dt><dd>{{ .employee.id }}</dd>
    <dt>Designation</dt><dd>{{ .employee.title }}</dd>
    <dt>Department</dt><dd>{{ .employee.department }}</dd>
    <dt>Manager</dt><dd>{{ .employee.manager }}</dd>
  </dl>

  <h2>Leave details</h2>
  <dl class="grid">
    <dt>Leave type</dt><dd><b>{{ .leaveType }}</b></dd>
    <dt>From</dt><dd>{{ .from | formatDate "Monday, January 2, 2006" }}</dd>
    <dt>To</dt><dd>{{ .to | formatDate "Monday, January 2, 2006" }}</dd>
    <dt>Total days</dt><dd><b>{{ .days }}</b> ({{ .balanceAfter }} days will remain after approval)</dd>
    <dt>Contact during leave</dt><dd>{{ .contact }}</dd>
  </dl>

  <h2>Reason</h2>
  <div class="reason">{{ .reason }}</div>

  <h2>Handover plan</h2>
  <ul>
    {{ range .handover }}<li>{{ . }}</li>{{ end }}
  </ul>

  <div class="approval">
    <div class="box">
      <b>Manager approval</b>
      Recommendation: ☐ Approve  ☐ Reject<br />
      Comments:
      <div class="line">{{ .employee.manager }} · Date</div>
    </div>
    <div class="box">
      <b>HR approval</b>
      Leave balance verified · ☐ Yes  ☐ No<br />
      Comments:
      <div class="line">People Operations · Date</div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    ref: "LL/LV/2026/0119",
    submitted: "2026-04-30",
    leaveType: "Annual leave",
    from: "2026-06-08",
    to: "2026-06-19",
    days: 10,
    balanceAfter: 6,
    contact: "+91 98xxx xxx12 (only for urgent matters)",
    reason:
      "Pre-booked family travel — flights and hotels reserved earlier this year. No project conflicts identified for this window.",
    employee: {
      name: "Priya Ramesh",
      id: "LL-0451",
      title: "Senior Software Engineer",
      department: "Engineering",
      manager: "Sam Okafor",
    },
    handover: [
      "Atlas dashboard redesign: handing off to Maya — context doc shared in Notion.",
      "On-call rotation: swapped with Ravi for the week of June 8.",
      "Weekly metrics email: queued in Mixmax to auto-send each Monday.",
      "Slack status set to OOO with Sam as escalation contact.",
    ],
  },
};
