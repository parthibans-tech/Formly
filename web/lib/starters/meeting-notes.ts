import type { Starter } from "./types";

export const meetingNotesStarter: Starter = {
  id: "meeting-notes",
  name: "Meeting notes",
  description:
    "Structured meeting minutes with attendees, agenda, decisions, and action items. Loops over discussion topics.",
  category: "Reports",
  tags: ["meeting", "notes", "minutes", "loop"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .meeting.title }} — Notes</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #1f2937; padding: 56px 64px; max-width: 780px; margin: auto; line-height: 1.55; }
    .header { border-bottom: 3px solid #6366f1; padding-bottom: 18px; margin-bottom: 24px; }
    .eyebrow { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #6366f1; font-weight: 600; }
    h1 { font-size: 28px; font-weight: 700; letter-spacing: -.01em; margin: 4px 0 8px; color: #0f172a; }
    .meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 8px; font-size: 12px; }
    .meta dt { color: #64748b; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 2px; }
    .meta dd { margin: 0; color: #1f2937; font-weight: 500; }
    section { margin-top: 28px; }
    h2 { font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: #4f46e5; margin: 0 0 12px; font-weight: 700; }
    .attendees { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { background: #eef2ff; color: #4338ca; border-radius: 999px; padding: 3px 10px; font-size: 12px; font-weight: 500; }
    .chip.absent { background: #f1f5f9; color: #94a3b8; text-decoration: line-through; }
    .topic { padding: 14px 16px; border-left: 3px solid #c7d2fe; background: #f8fafc; border-radius: 0 8px 8px 0; margin-bottom: 12px; }
    .topic-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
    .topic-title { font-weight: 600; color: #0f172a; font-size: 14px; }
    .topic-owner { font-size: 11px; color: #64748b; }
    .topic-body { font-size: 13px; color: #334155; }
    .decisions { background: #fef3c7; border: 1px solid #fde68a; border-radius: 8px; padding: 14px 18px; }
    .decisions ul { margin: 0; padding-left: 18px; }
    .decisions li { margin-bottom: 4px; font-size: 13px; color: #78350f; }
    table.actions { width: 100%; border-collapse: collapse; font-size: 13px; }
    table.actions th { text-align: left; font-weight: 600; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: #64748b; padding: 8px 10px; border-bottom: 1px solid #e2e8f0; }
    table.actions td { padding: 10px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    .owner-tag { display: inline-block; background: #ede9fe; color: #5b21b6; border-radius: 4px; padding: 1px 6px; font-size: 11px; font-weight: 500; }
    .due { font-variant-numeric: tabular-nums; color: #475569; font-size: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="eyebrow">{{ .meeting.kind }}</div>
    <h1>{{ .meeting.title }}</h1>
    <dl class="meta">
      <div><dt>Date</dt><dd>{{ .meeting.heldAt | formatDate "Mon, Jan 2, 2006" }}</dd></div>
      <div><dt>Time</dt><dd>{{ .meeting.time }}</dd></div>
      <div><dt>Location</dt><dd>{{ .meeting.location }}</dd></div>
    </dl>
  </div>

  <section>
    <h2>Attendees</h2>
    <div class="attendees">
      {{ range .attendees }}<span class="chip">{{ . }}</span>{{ end }}
      {{ range .absent }}<span class="chip absent">{{ . }}</span>{{ end }}
    </div>
  </section>

  <section>
    <h2>Discussion</h2>
    {{ range .topics }}
    <div class="topic">
      <div class="topic-head">
        <span class="topic-title">{{ .title }}</span>
        <span class="topic-owner">Led by {{ .owner }}</span>
      </div>
      <div class="topic-body">{{ .summary }}</div>
    </div>
    {{ end }}
  </section>

  {{ if .decisions }}
  <section>
    <h2>Decisions</h2>
    <div class="decisions">
      <ul>
        {{ range .decisions }}<li>{{ . }}</li>{{ end }}
      </ul>
    </div>
  </section>
  {{ end }}

  <section>
    <h2>Action items</h2>
    <table class="actions">
      <thead>
        <tr>
          <th style="width: 50%;">Task</th>
          <th>Owner</th>
          <th>Due</th>
        </tr>
      </thead>
      <tbody>
        {{ range .actions }}
        <tr>
          <td>{{ .task }}</td>
          <td><span class="owner-tag">{{ .owner }}</span></td>
          <td class="due">{{ .due | formatDate "Jan 2" }}</td>
        </tr>
        {{ end }}
      </tbody>
    </table>
  </section>
</body>
</html>
`,
  sampleData: {
    meeting: {
      kind: "Weekly product sync",
      title: "Roadmap planning — Q3",
      heldAt: "2026-04-22",
      time: "10:00 — 11:00 AM PT",
      location: "Conference room B / Zoom",
    },
    attendees: ["Priya Ramesh", "Alex Morgan", "Jordan Lee", "Sam Patel"],
    absent: ["Casey Wong"],
    topics: [
      {
        title: "Q2 retrospective",
        owner: "Priya",
        summary:
          "Team reviewed Q2 goals: 4 of 5 hit, with the analytics rebuild slipping by ~2 weeks. Root cause was unclear ownership between data and product engineering — addressed for Q3 by naming a single tech lead per workstream.",
      },
      {
        title: "Q3 priorities",
        owner: "Alex",
        summary:
          "Aligned on three pillars: enterprise SSO, mobile parity for the dashboard, and the new billing migration. Decided to defer the partner integrations track to Q4.",
      },
      {
        title: "Hiring update",
        owner: "Sam",
        summary:
          "Two senior engineers in final-round interviews; offers expected by next Friday. Design role still open — Jordan is taking over the search.",
      },
    ],
    decisions: [
      "Defer partner integrations to Q4.",
      "Name a single tech lead per Q3 workstream.",
      "Move the weekly product sync to Tuesdays at 10 AM.",
    ],
    actions: [
      { task: "Draft Q3 OKRs and circulate for review", owner: "Priya", due: "2026-04-29" },
      { task: "Open billing-migration RFC", owner: "Alex", due: "2026-05-02" },
      { task: "Schedule follow-ups with finalist candidates", owner: "Sam", due: "2026-04-25" },
      { task: "Take over open design role search", owner: "Jordan", due: "2026-04-30" },
    ],
  },
};
