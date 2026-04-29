import type { Starter } from "./types";

export const pipStarter: Starter = {
  id: "pip",
  name: "Performance improvement plan",
  description:
    "30/60/90-day PIP with goals, measurable outcomes, support, and review checkpoints.",
  category: "HR",
  tags: ["pip", "performance", "improvement"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Performance Improvement Plan — {{ .employee.name }}</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #111; padding: 48px 56px; max-width: 760px; margin: auto; line-height: 1.6; font-size: 12.5px; }
    .head { padding: 18px 22px; background: #0f172a; color: white; border-radius: 10px 10px 0 0; }
    .head h1 { margin: 0; font-size: 18px; }
    .head .meta { font-size: 11px; opacity: .85; margin-top: 4px; }
    .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 22px; padding: 16px 22px; background: #f8fafc; border: 1px solid #e2e8f0; border-top: none; }
    .meta-grid .lbl { font-size: 10.5px; color: #64748b; text-transform: uppercase; letter-spacing: .06em; }
    .meta-grid b { font-size: 12.5px; }
    h2 { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #0f172a; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #0f172a; }
    p { margin: 0 0 10px; text-align: justify; }
    .gap { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 10px 14px; border-radius: 0 6px 6px 0; font-size: 12px; }
    .phase { border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 18px; margin-bottom: 14px; }
    .phase .top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
    .phase .top b { font-size: 13px; }
    .phase .top span { font-size: 11px; color: #64748b; }
    .phase ul { margin: 6px 0 0; padding-left: 20px; font-size: 12.5px; }
    .phase li { margin-bottom: 3px; }
    .ack { margin-top: 22px; padding: 14px 16px; border: 1px dashed #94a3b8; border-radius: 6px; font-size: 12px; }
    .sig { margin-top: 18px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 24px; }
    .sig .line { border-top: 1px solid #111; padding-top: 6px; font-size: 11.5px; }
    .sig .muted { font-size: 10.5px; color: #64748b; }
  </style>
</head>
<body>
  <div class="head">
    <h1>Performance Improvement Plan</h1>
    <div class="meta">{{ .duration }}-day plan · Issued {{ .issued | formatDate "January 2, 2006" }}</div>
  </div>
  <div class="meta-grid">
    <div><span class="lbl">Employee</span><br /><b>{{ .employee.name }}</b></div>
    <div><span class="lbl">Position</span><br /><b>{{ .employee.title }}</b></div>
    <div><span class="lbl">Manager</span><br /><b>{{ .employee.manager }}</b></div>
    <div><span class="lbl">HR partner</span><br /><b>{{ .employee.hr }}</b></div>
    <div><span class="lbl">Plan start</span><br /><b>{{ .start | formatDate "January 2, 2006" }}</b></div>
    <div><span class="lbl">Plan end</span><br /><b>{{ .end | formatDate "January 2, 2006" }}</b></div>
  </div>

  <h2>Performance gap summary</h2>
  <div class="gap">{{ .gap }}</div>

  <h2>Goals and success criteria</h2>
  {{ range .phases }}
  <div class="phase">
    <div class="top">
      <b>{{ .label }}</b>
      <span>Checkpoint: {{ .checkpoint | formatDate "January 2, 2006" }}</span>
    </div>
    <p style="margin:0 0 6px;">{{ .focus }}</p>
    <ul>
      {{ range .goals }}<li>{{ . }}</li>{{ end }}
    </ul>
  </div>
  {{ end }}

  <h2>Support and resources</h2>
  <ul>
    {{ range .support }}<li>{{ . }}</li>{{ end }}
  </ul>

  <h2>Consequences</h2>
  <p>
    Failure to meet the success criteria above by {{ .end | formatDate "January 2, 2006" }} may
    result in further action, up to and including termination of employment. Conversely,
    sustained performance at the expected level will conclude the plan and return the
    employee to standard performance management.
  </p>

  <div class="ack">
    <b>Acknowledgement.</b> Signing below confirms the employee has received and reviewed this
    plan. It does not necessarily indicate agreement with every element of the plan.
  </div>

  <div class="sig">
    <div class="line">{{ .employee.name }}<div class="muted">Employee · Date</div></div>
    <div class="line">{{ .employee.manager }}<div class="muted">Manager · Date</div></div>
    <div class="line">{{ .employee.hr }}<div class="muted">HR · Date</div></div>
  </div>
</body>
</html>
`,
  sampleData: {
    duration: 60,
    issued: "2026-04-30",
    start: "2026-05-05",
    end: "2026-07-04",
    employee: {
      name: "Jordan Kim",
      title: "Account Executive",
      manager: "Reena Patel",
      hr: "Dana Lee",
    },
    gap:
      "Quota attainment over the past two quarters has been at 56% and 62% — below the 80% expectation for the role. Forecast hygiene and customer-facing follow-through have also been inconsistent despite verbal feedback in March.",
    phases: [
      {
        label: "Days 1 – 30 · Reset the basics",
        checkpoint: "2026-06-04",
        focus: "Re-establish baseline pipeline rigour and customer engagement cadence.",
        goals: [
          "Submit accurate weekly forecasts every Friday by 5pm without exception.",
          "Hold at least 12 net-new discovery meetings.",
          "Refresh the top-20 account plan with manager review by week 2.",
        ],
      },
      {
        label: "Days 31 – 60 · Convert pipeline",
        checkpoint: "2026-07-04",
        focus: "Translate activity into measurable revenue outcomes.",
        goals: [
          "Close at least one new logo with TCV ≥ $20,000.",
          "Move three opportunities from Stage 2 to Stage 4 with clean MEDDPIC notes.",
          "Maintain forecast accuracy within ±10% week over week.",
        ],
      },
    ],
    support: [
      "Weekly 1:1 with Reena focused exclusively on PIP progress.",
      "Pairing with senior AE Maya Chen on two live deals during weeks 2–4.",
      "Sales coaching session (45 min/week) with the enablement team.",
      "Access to the Employee Assistance Program if personal circumstances are a factor.",
    ],
  },
};
