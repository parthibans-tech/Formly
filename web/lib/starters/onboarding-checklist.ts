import type { Starter } from "./types";

export const onboardingChecklistStarter: Starter = {
  id: "onboarding-checklist",
  name: "Onboarding checklist",
  description:
    "First-week checklist for a new hire — accounts, paperwork, intro meetings, and 30-day goals.",
  category: "HR",
  tags: ["onboarding", "new-hire", "checklist"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Onboarding — {{ .newHire.name }}</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #111; padding: 48px 56px; max-width: 760px; margin: auto; line-height: 1.55; font-size: 13px; }
    .head { background: linear-gradient(135deg, #06b6d4 0%, #0ea5e9 100%); color: white; padding: 22px 26px; border-radius: 12px; margin-bottom: 22px; }
    .head h1 { margin: 0 0 4px; font-size: 22px; }
    .head .meta { font-size: 12px; opacity: .9; }
    h2 { font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: #0e7490; margin: 22px 0 10px; font-weight: 700; border-bottom: 2px solid #cffafe; padding-bottom: 4px; }
    .item { display: grid; grid-template-columns: 24px 1fr auto; gap: 10px; padding: 8px 0; border-bottom: 1px dashed #e2e8f0; align-items: start; }
    .item .box { width: 16px; height: 16px; border: 1.5px solid #94a3b8; border-radius: 4px; margin-top: 2px; }
    .item .label { font-size: 13px; }
    .item .label small { display: block; color: #64748b; font-size: 11px; }
    .item .owner { font-size: 11px; color: #0e7490; font-weight: 600; white-space: nowrap; }
    .day-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
    .goals { background: #ecfeff; border: 1px solid #a5f3fc; border-radius: 8px; padding: 14px 18px; margin-top: 14px; font-size: 12px; }
    .goals b { display: block; color: #0e7490; margin-bottom: 4px; font-size: 12px; letter-spacing: .04em; text-transform: uppercase; }
  </style>
</head>
<body>
  <div class="head">
    <h1>Welcome, {{ .newHire.name }}!</h1>
    <div class="meta">
      {{ .newHire.title }} · {{ .newHire.team }} · Day 1: {{ .newHire.start | formatDate "Monday, January 2, 2006" }}
    </div>
    <div class="meta" style="margin-top:6px">Buddy: {{ .newHire.buddy }} · Manager: {{ .newHire.manager }}</div>
  </div>

  <h2>Before day 1 (HR + IT)</h2>
  {{ range .preboarding }}
  <div class="item">
    <div class="box"></div>
    <div class="label">{{ .task }}<small>{{ .note }}</small></div>
    <div class="owner">{{ .owner }}</div>
  </div>
  {{ end }}

  <h2>Day 1</h2>
  {{ range .day1 }}
  <div class="item">
    <div class="box"></div>
    <div class="label">{{ .task }}<small>{{ .note }}</small></div>
    <div class="owner">{{ .owner }}</div>
  </div>
  {{ end }}

  <div class="day-grid">
    <div>
      <h2>First week</h2>
      {{ range .week1 }}
      <div class="item">
        <div class="box"></div>
        <div class="label">{{ .task }}<small>{{ .note }}</small></div>
      </div>
      {{ end }}
    </div>
    <div>
      <h2>First month</h2>
      {{ range .month1 }}
      <div class="item">
        <div class="box"></div>
        <div class="label">{{ .task }}<small>{{ .note }}</small></div>
      </div>
      {{ end }}
    </div>
  </div>

  <div class="goals">
    <b>30-day goals</b>
    <ul style="margin: 0; padding-left: 18px;">
      {{ range .goals30 }}<li>{{ . }}</li>{{ end }}
    </ul>
  </div>
</body>
</html>
`,
  sampleData: {
    newHire: {
      name: "Maya Chen",
      title: "Senior Product Designer",
      team: "Design",
      manager: "Sam Okafor",
      buddy: "Riya Sharma",
      start: "2026-05-19",
    },
    preboarding: [
      { task: "Send welcome email with day-1 logistics", note: "Address, dress code, parking, contact for Sam", owner: "People Ops" },
      { task: "Provision laptop and accessories", note: "MacBook Pro 14\", monitor, dock, keyboard", owner: "IT" },
      { task: "Create accounts (email, Slack, Figma, Notion)", note: "Use the standard new-hire role group", owner: "IT" },
      { task: "Mail offer paperwork and tax forms", note: "Confirm receipt + signatures before day 1", owner: "People Ops" },
    ],
    day1: [
      { task: "Pick up laptop and badge from front desk", note: "Front desk has the device queued", owner: "Maya" },
      { task: "Complete I-9 / employment eligibility paperwork", note: "Section 2 needs a manager signature", owner: "People Ops" },
      { task: "Office tour and team intros", note: "Riya runs the tour at 11am", owner: "Buddy" },
      { task: "Lunch with team", note: "Booked at the café next door, 12:30", owner: "Manager" },
      { task: "1:1 with manager — first goals + comms cadence", note: "Half hour, end of day", owner: "Manager" },
    ],
    week1: [
      { task: "Read team handbook and design principles doc", note: "Linked in onboarding Notion page" },
      { task: "Pair on a small live ticket with a teammate", note: "Aim for one ticket merged by Friday" },
      { task: "Set up calendar holds for recurring rituals", note: "Standup, retro, design crit, all-hands" },
      { task: "Meet 5 cross-functional partners", note: "Buddy can introduce — PM, Eng leads, Research" },
    ],
    month1: [
      { task: "Ship one customer-facing improvement", note: "Small but visible — pair with PM" },
      { task: "Present a 'what I've learned' to the team", note: "5 mins at Friday all-hands" },
      { task: "Complete required compliance training", note: "Security, code of conduct, harassment" },
      { task: "30-day check-in with manager", note: "Reflect on the goals below" },
    ],
    goals30: [
      "Build a working understanding of the analytics product surface and current roadmap.",
      "Form one hypothesis about a UX gap, with research to support it.",
      "Establish a working rhythm with PM and engineering pod (1:1s, sync, async).",
      "Ship at least one small but customer-facing design.",
    ],
  },
};
