import type { Starter } from "./types";

export const jobDescriptionStarter: Starter = {
  id: "job-description",
  name: "Job description",
  description:
    "Job posting with summary, responsibilities, qualifications, and benefits — ready to publish on careers pages.",
  category: "HR",
  tags: ["jd", "posting", "hiring"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .role.title }} — {{ .company.name }}</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #0f172a; margin: 0; padding: 48px 56px; line-height: 1.6; font-size: 13px; max-width: 760px; margin: auto; }
    .head { border-bottom: 4px solid #2563eb; padding-bottom: 16px; margin-bottom: 22px; }
    .brand { font-size: 13px; color: #2563eb; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; }
    h1 { font-size: 30px; font-weight: 800; margin: 6px 0 8px; letter-spacing: -.01em; }
    .meta { display: flex; flex-wrap: wrap; gap: 18px; font-size: 12px; color: #475569; }
    .meta b { color: #0f172a; font-weight: 600; }
    .summary { background: #eff6ff; border-left: 4px solid #2563eb; padding: 14px 18px; border-radius: 0 6px 6px 0; margin: 18px 0 24px; font-size: 13px; }
    h2 { font-size: 14px; font-weight: 700; color: #1e3a8a; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #e2e8f0; }
    ul { margin: 6px 0 0; padding-left: 22px; }
    li { margin-bottom: 5px; }
    .pill { display: inline-block; background: #f1f5f9; color: #0f172a; padding: 3px 10px; border-radius: 999px; font-size: 11px; margin: 0 4px 4px 0; }
    .apply { margin-top: 28px; padding: 16px 18px; background: #0f172a; color: white; border-radius: 8px; font-size: 12px; }
    .apply a { color: #93c5fd; }
  </style>
</head>
<body>
  <div class="head">
    <div class="brand">{{ .company.name }} · Careers</div>
    <h1>{{ .role.title }}</h1>
    <div class="meta">
      <span><b>Team:</b> {{ .role.team }}</span>
      <span><b>Location:</b> {{ .role.location }}</span>
      <span><b>Type:</b> {{ .role.type }}</span>
      <span><b>Salary:</b> {{ .role.salary }}</span>
    </div>
  </div>

  <div class="summary">{{ .summary }}</div>

  <h2>What you'll do</h2>
  <ul>
    {{ range .responsibilities }}<li>{{ . }}</li>{{ end }}
  </ul>

  <h2>What we're looking for</h2>
  <ul>
    {{ range .qualifications }}<li>{{ . }}</li>{{ end }}
  </ul>

  {{ if .niceToHave }}
  <h2>Nice to have</h2>
  <ul>
    {{ range .niceToHave }}<li>{{ . }}</li>{{ end }}
  </ul>
  {{ end }}

  <h2>What we offer</h2>
  <ul>
    {{ range .benefits }}<li>{{ . }}</li>{{ end }}
  </ul>

  <h2>Tech &amp; tools</h2>
  <div>
    {{ range .stack }}<span class="pill">{{ . }}</span>{{ end }}
  </div>

  <div class="apply">
    <b>How to apply:</b> Send your résumé and a brief note to
    {{ .apply.email }}. We respond to every application within {{ .apply.responseDays }} business days.
  </div>
</body>
</html>
`,
  sampleData: {
    company: { name: "Lumen Labs" },
    role: {
      title: "Senior Frontend Engineer",
      team: "Product Engineering",
      location: "Remote (US/EU)",
      type: "Full-time",
      salary: "$160,000 — $200,000 + equity",
    },
    summary:
      "We're looking for a senior frontend engineer to lead the next chapter of our analytics platform — owning architecture decisions, mentoring two designers-turned-engineers, and shipping features used by 40,000+ teams.",
    responsibilities: [
      "Own the architecture and quality of our React-based analytics UI.",
      "Lead a small cross-functional pod with a designer and a backend engineer.",
      "Drive performance, accessibility, and component-library investments.",
      "Pair with product to ship 2–3 major features per quarter.",
      "Mentor mid-level engineers on the team through reviews and pairing.",
    ],
    qualifications: [
      "5+ years building production React applications.",
      "Deep TypeScript fluency and a strong eye for API design.",
      "Experience leading technical projects end-to-end.",
      "Comfort writing thoughtful documentation and async updates.",
    ],
    niceToHave: [
      "Open-source contributions in the React ecosystem.",
      "Experience with data-visualization libraries (D3, Recharts).",
      "Background in design systems or component libraries.",
    ],
    benefits: [
      "Competitive salary and meaningful equity.",
      "Unlimited PTO with a 3-week minimum.",
      "Comprehensive medical, dental, and vision.",
      "$2,000 / year learning budget and conference travel.",
      "Home office stipend + monthly remote-work allowance.",
    ],
    stack: ["TypeScript", "React", "Next.js", "GraphQL", "PostgreSQL", "Tailwind"],
    apply: {
      email: "careers@lumenlabs.example",
      responseDays: 5,
    },
  },
};
