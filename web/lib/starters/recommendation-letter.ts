import type { Starter } from "./types";

export const recommendationLetterStarter: Starter = {
  id: "recommendation-letter",
  name: "Recommendation letter",
  description:
    "Reference letter from a manager — covering tenure, strengths, achievements, and unconditional endorsement.",
  category: "HR",
  tags: ["reference", "recommendation", "letter"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Letter of Recommendation — {{ .candidate.name }}</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #111; padding: 56px 72px; max-width: 720px; margin: auto; line-height: 1.7; font-size: 13px; }
    .head { border-bottom: 1px solid #cbd5e1; padding-bottom: 14px; margin-bottom: 24px; }
    .head .brand { font-weight: 700; font-size: 16px; color: #0f172a; }
    .head .muted { color: #64748b; font-size: 12px; }
    h1 { font-size: 18px; text-align: center; margin: 8px 0 24px; letter-spacing: .04em; text-transform: uppercase; }
    p { text-align: justify; margin: 0 0 12px; }
    .pull { background: #f8fafc; border-left: 4px solid #0f172a; padding: 12px 16px; margin: 16px 0; font-size: 13px; font-style: italic; color: #334155; }
    ul { padding-left: 22px; }
    li { margin-bottom: 4px; }
    .sig { margin-top: 48px; }
    .sig b { display: block; }
    .sig .muted { color: #64748b; font-size: 12px; }
  </style>
</head>
<body>
  <div class="head">
    <div class="brand">{{ .recommender.name }}</div>
    <div class="muted">{{ .recommender.title }} · {{ .recommender.company }}</div>
    <div class="muted">{{ .recommender.email }} · {{ .recommender.phone }}</div>
    <div class="muted" style="margin-top:6px">{{ .letterDate | formatDate "January 2, 2006" }}</div>
  </div>

  <h1>Letter of Recommendation</h1>

  <p>To whom it may concern,</p>

  <p>
    It is my unequivocal pleasure to recommend <b>{{ .candidate.name }}</b> for
    {{ .candidate.targetRole }}. I worked closely with {{ .candidate.firstName }} for
    <b>{{ .tenure }}</b> at {{ .recommender.company }}, where they served as
    <b>{{ .candidate.title }}</b> on my team.
  </p>

  <p>
    {{ .candidate.firstName }} consistently performed at a level above their title.
    {{ .openingPraise }}
  </p>

  <div class="pull">{{ .standoutQuote }}</div>

  <p>Among the achievements that stood out during their time with us:</p>
  <ul>
    {{ range .achievements }}<li>{{ . }}</li>{{ end }}
  </ul>

  <p>
    Beyond the work itself, {{ .candidate.firstName }} brings the qualities that compound over a
    career: clear writing, calm under pressure, and a generosity with their time and knowledge
    that lifts everyone around them.
  </p>

  <p>
    I recommend {{ .candidate.firstName }} without reservation. Please feel free to contact me
    directly at {{ .recommender.email }} if I can answer any further questions.
  </p>

  <div class="sig">
    <p>Sincerely,</p>
    <b>{{ .recommender.name }}</b>
    <span class="muted">{{ .recommender.title }} · {{ .recommender.company }}</span>
  </div>
</body>
</html>
`,
  sampleData: {
    letterDate: "2026-04-30",
    tenure: "two and a half years",
    recommender: {
      name: "Sam Okafor",
      title: "Director of Engineering",
      company: "Lumen Labs, Inc.",
      email: "sam.okafor@lumenlabs.example",
      phone: "+1 (415) 555-0102",
    },
    candidate: {
      name: "Priya Ramesh",
      firstName: "Priya",
      title: "Senior Software Engineer",
      targetRole: "any senior engineering role they are pursuing",
    },
    openingPraise:
      "She combined deep technical judgement with an unusual ability to align cross-functional partners and ship work that mattered.",
    standoutQuote:
      "Priya is the kind of engineer you build a team around — thoughtful, principled, and quietly excellent.",
    achievements: [
      "Led the analytics platform redesign, growing weekly active users 38% in two quarters.",
      "Owned the roll-out of our new data ingestion pipeline, cutting query latency by 60%.",
      "Mentored four junior engineers — three were promoted within a year of joining her pod.",
      "Established the engineering team's first design-system-meets-code-style guidelines.",
    ],
  },
};
