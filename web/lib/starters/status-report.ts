import type { Starter } from "./types";

export const statusReportStarter: Starter = {
  id: "status-report",
  name: "Project status report",
  description:
    "Weekly status update with RAG status, milestones, risks, and next-week plan.",
  category: "Reports",
  tags: ["status", "report", "weekly"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Status — {{ .project.name }}</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; color: #0f172a; padding: 48px; max-width: 820px; margin: auto; line-height: 1.5; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 16px; border-bottom: 2px solid #0f172a; }
    .head h1 { margin: 0; font-size: 22px; letter-spacing: -.01em; }
    .head .sub { color: #64748b; font-size: 13px; margin-top: 2px; }
    .head .week { text-align: right; font-size: 12px; color: #64748b; }
    .head .week b { color: #0f172a; display: block; font-size: 14px; font-weight: 600; }
    .pillrow { display: flex; gap: 14px; margin: 16px 0 24px; }
    .pill { flex: 1; padding: 12px 14px; border-radius: 10px; border: 1px solid #e2e8f0; }
    .pill .label { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: #64748b; font-weight: 700; }
    .pill .value { font-size: 14px; font-weight: 600; margin-top: 4px; display: flex; align-items: center; gap: 8px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; }
    .dot.green { background: #16a34a; } .dot.amber { background: #f59e0b; } .dot.red { background: #dc2626; }
    h2 { font-size: 13px; margin: 26px 0 8px; letter-spacing: .12em; text-transform: uppercase; color: #0f172a; }
    p { margin: 0 0 10px; font-size: 14px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 4px; }
    th, td { padding: 9px 10px; border-bottom: 1px solid #e2e8f0; text-align: left; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; font-weight: 700; }
    td .rag { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
    .rag-green { background: #dcfce7; color: #166534; }
    .rag-amber { background: #fef3c7; color: #92400e; }
    .rag-red { background: #fee2e2; color: #991b1b; }
    ul { margin: 4px 0 0; padding-left: 18px; font-size: 14px; }
    ul li { margin-bottom: 4px; }
  </style>
</head>
<body>
  <div class="head">
    <div>
      <h1>{{ .project.name }} — Status</h1>
      <div class="sub">{{ .project.lead }} · {{ .project.team }}</div>
    </div>
    <div class="week">
      Week of
      <b>{{ .weekOf | formatDate "Jan 2, 2006" }}</b>
    </div>
  </div>

  <div class="pillrow">
    <div class="pill">
      <div class="label">Overall</div>
      <div class="value"><span class="dot {{ .status.overall }}"></span>{{ .status.overallLabel }}</div>
    </div>
    <div class="pill">
      <div class="label">Schedule</div>
      <div class="value"><span class="dot {{ .status.schedule }}"></span>{{ .status.scheduleLabel }}</div>
    </div>
    <div class="pill">
      <div class="label">Scope</div>
      <div class="value"><span class="dot {{ .status.scope }}"></span>{{ .status.scopeLabel }}</div>
    </div>
    <div class="pill">
      <div class="label">Budget</div>
      <div class="value"><span class="dot {{ .status.budget }}"></span>{{ .status.budgetLabel }}</div>
    </div>
  </div>

  <h2>Summary</h2>
  <p>{{ .summary }}</p>

  <h2>Milestones</h2>
  <table>
    <thead><tr><th>Milestone</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead>
    <tbody>
      {{ range .milestones }}
      <tr>
        <td>{{ .name }}</td>
        <td>{{ .owner }}</td>
        <td>{{ .due | formatDate "Jan 2" }}</td>
        <td><span class="rag rag-{{ .rag }}">{{ .ragLabel }}</span></td>
      </tr>
      {{ end }}
    </tbody>
  </table>

  <h2>Risks & blockers</h2>
  <ul>
    {{ range .risks }}
    <li><b>{{ .title }}</b> — {{ .detail }} <i>(owner: {{ .owner }})</i></li>
    {{ end }}
  </ul>

  <h2>Next week</h2>
  <ul>
    {{ range .nextWeek }}
    <li>{{ . }}</li>
    {{ end }}
  </ul>
</body>
</html>
`,
  sampleData: {
    project: {
      name: "Lumen Health Web Redesign",
      lead: "Maya Patel",
      team: "Field & Form Studio",
    },
    weekOf: "2026-04-27",
    status: {
      overall: "green", overallLabel: "On track",
      schedule: "amber", scheduleLabel: "1 wk slip",
      scope: "green", scopeLabel: "Stable",
      budget: "green", budgetLabel: "Under",
    },
    summary:
      "Discovery wrapped this week with the final two stakeholder interviews. Strategy work begins Monday. The visual exploration phase is moved one week to absorb additional feedback from the brand committee — schedule moves from green to amber but no impact to launch date.",
    milestones: [
      { name: "Discovery complete", owner: "Maya P.", due: "2026-04-26", rag: "green", ragLabel: "Done" },
      { name: "Brand strategy review", owner: "Maya P.", due: "2026-05-09", rag: "green", ragLabel: "On track" },
      { name: "Visual concept v1", owner: "Owen B.", due: "2026-05-23", rag: "amber", ragLabel: "1 wk risk" },
      { name: "Component library handoff", owner: "Lina K.", due: "2026-07-04", rag: "green", ragLabel: "On track" },
    ],
    risks: [
      { title: "Brand committee bandwidth", detail: "Two committee members are out the week of 5/12, may compress review window.", owner: "Maya P." },
      { title: "Photography sourcing", detail: "Original shoot pushed to June; using stock placeholder for v1 visuals.", owner: "Owen B." },
    ],
    nextWeek: [
      "Kick off strategy phase with positioning workshop (Wed)",
      "Deliver voice & tone draft for client review",
      "Begin homepage moodboards (Thu)",
      "Schedule mid-engagement check-in with executive sponsor",
    ],
  },
};
