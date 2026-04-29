import type { Starter } from "./types";

export const performanceReviewStarter: Starter = {
  id: "performance-review",
  name: "Performance review",
  description:
    "Annual review with rated competencies, accomplishments, growth areas, and goals.",
  category: "HR",
  tags: ["performance", "review", "hr"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .employee.name }} — Performance review</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #0f172a; padding: 56px 64px; max-width: 820px; margin: auto; line-height: 1.55; }
    .head { padding-bottom: 16px; border-bottom: 2px solid #0f172a; display: flex; justify-content: space-between; align-items: flex-start; }
    .head h1 { margin: 0; font-size: 24px; letter-spacing: -.01em; }
    .head .sub { color: #64748b; font-size: 13px; margin-top: 2px; }
    .head .period { text-align: right; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: #64748b; font-weight: 700; }
    .head .period b { display: block; color: #0f172a; font-size: 15px; letter-spacing: 0; text-transform: none; font-weight: 700; margin-top: 2px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 16px; font-size: 13px; }
    .grid .cell b { display: block; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #64748b; margin-bottom: 2px; font-weight: 700; }
    h2 { font-size: 13px; margin: 28px 0 8px; letter-spacing: .12em; text-transform: uppercase; color: #0f172a; padding-bottom: 4px; border-bottom: 1px solid #e2e8f0; }
    p { margin: 0 0 10px; font-size: 14px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-align: left; vertical-align: top; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; font-weight: 700; }
    .rating { display: inline-flex; gap: 2px; align-items: center; }
    .rating .dot { width: 10px; height: 10px; border-radius: 50%; background: #e2e8f0; }
    .rating .dot.on { background: #2563eb; }
    .ratebadge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; background: #dbeafe; color: #1d4ed8; }
    ul { margin: 6px 0 0; padding-left: 18px; font-size: 14px; }
    ul li { margin-bottom: 6px; }
    .signbox { margin-top: 36px; display: flex; gap: 36px; }
    .signbox .line { flex: 1; border-top: 1px solid #0f172a; padding-top: 6px; font-size: 12px; color: #64748b; }
    .signbox .line b { color: #0f172a; display: block; font-size: 13px; margin-top: 2px; }
  </style>
</head>
<body>
  <div class="head">
    <div>
      <h1>Performance Review</h1>
      <div class="sub">{{ .employee.name }} · {{ .employee.title }}</div>
    </div>
    <div class="period">
      Review period
      <b>{{ .period }}</b>
    </div>
  </div>

  <div class="grid">
    <div class="cell"><b>Manager</b>{{ .manager.name }}, {{ .manager.title }}</div>
    <div class="cell"><b>Department</b>{{ .employee.department }}</div>
    <div class="cell"><b>Hire date</b>{{ .employee.hireDate | formatDate "Jan 2, 2006" }}</div>
    <div class="cell"><b>Overall rating</b><span class="ratebadge">{{ .overall.label }}</span></div>
  </div>

  <h2>Summary</h2>
  <p>{{ .summary }}</p>

  <h2>Competencies</h2>
  <table>
    <thead><tr><th>Area</th><th style="width: 110px;">Rating</th><th>Notes</th></tr></thead>
    <tbody>
      {{ range .competencies }}
      <tr>
        <td><b>{{ .area }}</b></td>
        <td>
          <span class="rating">
            {{ if ge .score 1 }}<span class="dot on"></span>{{ else }}<span class="dot"></span>{{ end }}
            {{ if ge .score 2 }}<span class="dot on"></span>{{ else }}<span class="dot"></span>{{ end }}
            {{ if ge .score 3 }}<span class="dot on"></span>{{ else }}<span class="dot"></span>{{ end }}
            {{ if ge .score 4 }}<span class="dot on"></span>{{ else }}<span class="dot"></span>{{ end }}
            {{ if ge .score 5 }}<span class="dot on"></span>{{ else }}<span class="dot"></span>{{ end }}
          </span>
        </td>
        <td>{{ .notes }}</td>
      </tr>
      {{ end }}
    </tbody>
  </table>

  <h2>Key accomplishments</h2>
  <ul>
    {{ range .accomplishments }}
    <li>{{ . }}</li>
    {{ end }}
  </ul>

  <h2>Growth areas</h2>
  <ul>
    {{ range .growth }}
    <li>{{ . }}</li>
    {{ end }}
  </ul>

  <h2>Goals for next period</h2>
  <ul>
    {{ range .goals }}
    <li><b>{{ .name }}</b> — {{ .detail }}</li>
    {{ end }}
  </ul>

  <div class="signbox">
    <div class="line">Manager<b>{{ .manager.name }}</b></div>
    <div class="line">Employee<b>{{ .employee.name }}</b></div>
  </div>
</body>
</html>
`,
  sampleData: {
    employee: {
      name: "Avery Johnson",
      title: "Senior Product Designer",
      department: "Product Design",
      hireDate: "2023-03-12",
    },
    manager: { name: "Priya Anand", title: "VP of Product" },
    period: "Apr 2025 – Apr 2026",
    overall: { label: "Exceeds expectations" },
    summary:
      "Avery had a strong year, anchoring the Care Coordination redesign and stepping up as the senior voice on the design team. They consistently raised the bar on craft and partnered exceptionally well with engineering. Heading into next year, the focus will be on stretching into more cross-functional leadership and mentoring.",
    competencies: [
      { area: "Craft & quality", score: 5, notes: "Sets the bar; reviews lift the work of the whole team." },
      { area: "Cross-functional partnership", score: 4, notes: "Trusted by eng and PM; can be more proactive with marketing." },
      { area: "Communication", score: 4, notes: "Clear writer; could narrate trade-offs more often in design reviews." },
      { area: "Ownership & delivery", score: 5, notes: "Delivers on time; flags risks early." },
      { area: "Mentorship", score: 3, notes: "Stretch area for next year; pair more with junior designers." },
    ],
    accomplishments: [
      "Led the Care Coordination redesign — patient NPS up 14 points post-launch.",
      "Shipped the new patient onboarding flow, reducing first-week drop-off by 22%.",
      "Drove adoption of the new component library across 3 product squads.",
      "Mentored two new hires through their onboarding ramp.",
    ],
    growth: [
      "Pushing more of their thinking into team-wide forums (design crits, all-hands).",
      "Building stronger relationships with marketing and content.",
    ],
    goals: [
      { name: "Lead the next zero-to-one initiative", detail: "Take design lead on the Family Care expansion launching Q3." },
      { name: "Formalize design mentorship", detail: "Run a monthly craft session and pair with both junior designers weekly." },
      { name: "Cross-functional storytelling", detail: "Present design rationale at exec review at least once per quarter." },
    ],
  },
};
