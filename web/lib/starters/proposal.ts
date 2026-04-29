import type { Starter } from "./types";

export const proposalStarter: Starter = {
  id: "proposal",
  name: "Project proposal",
  description:
    "Pitch document with executive summary, scope, deliverables, timeline, and pricing.",
  category: "Marketing",
  tags: ["proposal", "pitch", "scope"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .project.title }}</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #0f172a; padding: 56px 64px; max-width: 780px; margin: auto; line-height: 1.55; }
    .cover { border-bottom: 4px solid #6366f1; padding-bottom: 24px; margin-bottom: 32px; }
    .eyebrow { color: #6366f1; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; font-weight: 700; }
    h1 { font-size: 32px; margin: 6px 0 8px; letter-spacing: -.02em; }
    .subtitle { color: #475569; font-size: 15px; }
    .meta { display: flex; gap: 32px; margin-top: 18px; font-size: 12px; color: #64748b; }
    .meta b { color: #0f172a; display: block; font-size: 13px; font-weight: 600; }
    h2 { font-size: 18px; margin: 32px 0 10px; color: #0f172a; }
    p { margin: 0 0 12px; font-size: 14px; color: #1f2937; }
    .deliverables { margin: 12px 0; padding: 0; list-style: none; }
    .deliverables li { padding: 10px 14px; border-left: 3px solid #6366f1; background: #f5f3ff; border-radius: 0 6px 6px 0; margin-bottom: 8px; font-size: 13px; }
    .deliverables li b { display: block; font-size: 14px; color: #0f172a; margin-bottom: 2px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-align: left; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; font-weight: 600; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    tfoot td { font-weight: 700; border-bottom: 0; padding-top: 14px; }
    .pricing { background: #0f172a; color: white; border-radius: 10px; padding: 20px 24px; margin-top: 24px; display: flex; justify-content: space-between; align-items: center; }
    .pricing .label { font-size: 11px; text-transform: uppercase; letter-spacing: .12em; color: #cbd5e1; }
    .pricing .amount { font-size: 28px; font-weight: 700; letter-spacing: -.01em; }
  </style>
</head>
<body>
  <div class="cover">
    <div class="eyebrow">Proposal · {{ .project.code }}</div>
    <h1>{{ .project.title }}</h1>
    <div class="subtitle">{{ .project.tagline }}</div>
    <div class="meta">
      <div><b>Prepared for</b>{{ .client.name }}</div>
      <div><b>Prepared by</b>{{ .author.name }}, {{ .author.company }}</div>
      <div><b>Date</b>{{ .date | formatDate "Jan 2, 2006" }}</div>
    </div>
  </div>

  <h2>Executive summary</h2>
  <p>{{ .summary }}</p>

  <h2>Scope of work</h2>
  <p>{{ .scope }}</p>

  <h2>Deliverables</h2>
  <ul class="deliverables">
    {{ range .deliverables }}
    <li><b>{{ .title }}</b>{{ .detail }}</li>
    {{ end }}
  </ul>

  <h2>Timeline</h2>
  <table>
    <thead>
      <tr><th>Phase</th><th>Activities</th><th class="num">Duration</th></tr>
    </thead>
    <tbody>
      {{ range .timeline }}
      <tr><td><b>{{ .phase }}</b></td><td>{{ .activities }}</td><td class="num">{{ .duration }}</td></tr>
      {{ end }}
    </tbody>
  </table>

  <h2>Investment</h2>
  <table>
    <thead>
      <tr><th>Item</th><th class="num">Amount</th></tr>
    </thead>
    <tbody>
      {{ range .pricing }}
      <tr><td>{{ .item }}</td><td class="num">{{ .amount | formatCurrency "USD" }}</td></tr>
      {{ end }}
    </tbody>
  </table>
  <div class="pricing">
    <div>
      <div class="label">Total investment</div>
      <div style="font-size: 12px; color: #94a3b8; margin-top: 4px;">{{ .terms }}</div>
    </div>
    <div class="amount">{{ .total | formatCurrency "USD" }}</div>
  </div>
</body>
</html>
`,
  sampleData: {
    project: {
      title: "Brand Refresh & Website Redesign",
      tagline: "A modern identity and digital home for the next chapter of Lumen Health.",
      code: "PR-2026-018",
    },
    client: { name: "Lumen Health, Inc." },
    author: { name: "Maya Patel", company: "Field & Form Studio" },
    date: "2026-04-22",
    summary:
      "Lumen Health is preparing for a Series B raise and a national expansion. This proposal outlines a 14-week engagement to refresh the brand identity, restructure the marketing site, and deliver a flexible component library the in-house team can build on.",
    scope:
      "We'll discover with leadership and customers, refine positioning, develop a refreshed visual system, redesign the marketing website end-to-end, and ship a documented Figma library plus production-ready React components.",
    deliverables: [
      { title: "Brand strategy", detail: "Positioning brief, voice & tone guide, audience matrix." },
      { title: "Visual identity", detail: "Logo refresh, color system, typography, photography direction." },
      { title: "Website redesign", detail: "12 page templates, responsive, with motion guidelines." },
      { title: "Component library", detail: "Figma library + shadcn/ui-based React components, fully typed." },
    ],
    timeline: [
      { phase: "Phase 1 — Discovery", activities: "Stakeholder interviews, audit, competitive review", duration: "2 weeks" },
      { phase: "Phase 2 — Strategy", activities: "Positioning, voice, audience definition", duration: "2 weeks" },
      { phase: "Phase 3 — Design", activities: "Identity system, web designs, prototypes", duration: "5 weeks" },
      { phase: "Phase 4 — Build", activities: "Component library, marketing site implementation", duration: "5 weeks" },
    ],
    pricing: [
      { item: "Discovery & strategy", amount: 18500 },
      { item: "Identity & visual system", amount: 24000 },
      { item: "Website design & build", amount: 42000 },
      { item: "Component library", amount: 16500 },
    ],
    total: 101000,
    terms: "50% on signature, 25% at design approval, 25% on launch.",
  },
};
