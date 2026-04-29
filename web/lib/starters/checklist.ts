import type { Starter } from "./types";

export const checklistStarter: Starter = {
  id: "checklist",
  name: "Checklist",
  description:
    "Grouped task checklist with sections, owners, and printable checkbox rows.",
  category: "Operations",
  tags: ["checklist", "tasks", "checklists"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .title }}</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #0f172a; padding: 56px 64px; max-width: 780px; margin: auto; line-height: 1.5; }
    .header { padding-bottom: 18px; border-bottom: 3px solid #0f172a; }
    h1 { margin: 0; font-size: 28px; letter-spacing: -.01em; }
    .subtitle { color: #475569; margin-top: 4px; font-size: 14px; }
    .meta { display: flex; gap: 28px; margin-top: 12px; font-size: 12px; color: #64748b; }
    .meta b { color: #0f172a; font-weight: 600; }
    h2 { font-size: 13px; margin: 28px 0 8px; color: #0f172a; letter-spacing: .12em; text-transform: uppercase; }
    .section { margin-top: 4px; }
    .row { display: grid; grid-template-columns: 24px 1fr 120px; gap: 12px; align-items: start; padding: 10px 12px; border-bottom: 1px dashed #e2e8f0; }
    .box { width: 16px; height: 16px; border: 2px solid #0f172a; border-radius: 3px; margin-top: 2px; }
    .row .text { font-size: 14px; }
    .row .text b { display: block; font-weight: 600; }
    .row .text .detail { color: #64748b; font-size: 12px; margin-top: 2px; }
    .row .owner { font-size: 11px; color: #64748b; text-align: right; padding-top: 2px; }
    .row .owner b { color: #0f172a; display: block; font-size: 12px; }
    .footer { margin-top: 32px; padding-top: 14px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; }
  </style>
</head>
<body>
  <div class="header">
    <h1>{{ .title }}</h1>
    <div class="subtitle">{{ .subtitle }}</div>
    <div class="meta">
      <div>For: <b>{{ .for }}</b></div>
      <div>Date: <b>{{ .date | formatDate "Jan 2, 2006" }}</b></div>
      <div>Prepared by: <b>{{ .preparedBy }}</b></div>
    </div>
  </div>

  {{ range .sections }}
  <h2>{{ .name }}</h2>
  <div class="section">
    {{ range .items }}
    <div class="row">
      <div class="box"></div>
      <div class="text">
        <b>{{ .task }}</b>
        {{ if .detail }}<div class="detail">{{ .detail }}</div>{{ end }}
      </div>
      <div class="owner">{{ if .owner }}<b>{{ .owner }}</b>{{ end }}{{ .due }}</div>
    </div>
    {{ end }}
  </div>
  {{ end }}

  {{ if .notes }}
  <div class="footer">{{ .notes }}</div>
  {{ end }}
</body>
</html>
`,
  sampleData: {
    title: "New Hire Onboarding Checklist",
    subtitle: "First-week tasks for new engineering team members.",
    for: "Avery Johnson, Software Engineer",
    date: "2026-04-29",
    preparedBy: "People Ops",
    sections: [
      {
        name: "Day 1 — Setup",
        items: [
          { task: "Issue laptop & badge", detail: "MacBook Pro 14, security badge L2", owner: "IT", due: "9:00 AM" },
          { task: "Provision accounts", detail: "Email, Slack, GitHub, 1Password, Linear", owner: "IT", due: "10:00 AM" },
          { task: "Welcome meeting with manager", owner: "Manager", due: "11:00 AM" },
          { task: "Office tour & desk assignment", owner: "People Ops", due: "12:00 PM" },
        ],
      },
      {
        name: "Week 1 — Orientation",
        items: [
          { task: "Complete benefits enrollment", detail: "Health, dental, 401(k) elections", owner: "Employee", due: "Friday" },
          { task: "Review code of conduct & security training", owner: "Employee", due: "Wednesday" },
          { task: "Pair on first PR with onboarding buddy", owner: "Buddy", due: "Friday" },
          { task: "Schedule 1:1s with team members", owner: "Manager", due: "Friday" },
        ],
      },
      {
        name: "First 30 days",
        items: [
          { task: "Ship first user-facing feature", owner: "Employee", due: "Day 30" },
          { task: "Present learnings at team show-and-tell", owner: "Employee", due: "Day 30" },
          { task: "Manager check-in & 30-day review", owner: "Manager", due: "Day 30" },
        ],
      },
    ],
    notes:
      "Questions? Reach People Ops at people@northwind.example. Welcome aboard!",
  },
};
