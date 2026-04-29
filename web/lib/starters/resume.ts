import type { Starter } from "./types";

export const resumeStarter: Starter = {
  id: "resume",
  name: "Resume",
  description:
    "Modern one-page CV with sidebar contact details, experience timeline, skills, and education sections.",
  category: "HR",
  tags: ["resume", "cv", "candidate"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .person.name }} — Resume</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #1f2937; margin: 0; }
    .page { display: grid; grid-template-columns: 240px 1fr; min-height: 1056px; }
    .sidebar { background: #0f172a; color: #e2e8f0; padding: 48px 28px; }
    .sidebar h2 { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #94a3b8; margin: 32px 0 10px; font-weight: 600; }
    .sidebar h2:first-of-type { margin-top: 0; }
    .sidebar .item { font-size: 12px; line-height: 1.5; margin-bottom: 6px; word-break: break-word; }
    .sidebar .skill { display: inline-block; background: rgba(255,255,255,0.08); border-radius: 4px; padding: 3px 8px; font-size: 11px; margin: 0 4px 4px 0; }
    .main { padding: 48px 44px; }
    .name { font-size: 32px; font-weight: 700; letter-spacing: -.01em; color: #0f172a; margin: 0 0 4px; }
    .title { font-size: 14px; color: #475569; margin-bottom: 24px; font-weight: 500; }
    .summary { font-size: 13px; line-height: 1.6; color: #334155; margin-bottom: 28px; padding-bottom: 24px; border-bottom: 1px solid #e2e8f0; }
    .section h3 { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #0f172a; margin: 24px 0 14px; font-weight: 700; border-bottom: 2px solid #0f172a; padding-bottom: 4px; }
    .role { margin-bottom: 18px; }
    .role-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 2px; }
    .role-title { font-size: 14px; font-weight: 600; color: #0f172a; }
    .role-when { font-size: 11px; color: #64748b; font-variant-numeric: tabular-nums; }
    .role-org { font-size: 12px; color: #475569; margin-bottom: 6px; font-style: italic; }
    .role ul { margin: 4px 0 0; padding-left: 18px; font-size: 12px; line-height: 1.55; color: #334155; }
    .role li { margin-bottom: 3px; }
    .edu { font-size: 12px; line-height: 1.55; color: #334155; margin-bottom: 8px; }
    .edu .deg { font-weight: 600; color: #0f172a; }
  </style>
</head>
<body>
  <div class="page">
    <aside class="sidebar">
      <h2>Contact</h2>
      <div class="item">{{ .person.email }}</div>
      <div class="item">{{ .person.phone }}</div>
      <div class="item">{{ .person.location }}</div>
      {{ if .person.website }}<div class="item">{{ .person.website }}</div>{{ end }}

      <h2>Skills</h2>
      <div>
        {{ range .skills }}<span class="skill">{{ . }}</span>{{ end }}
      </div>

      {{ if .languages }}
      <h2>Languages</h2>
      {{ range .languages }}
      <div class="item">{{ .name }} — <span style="color:#94a3b8">{{ .level }}</span></div>
      {{ end }}
      {{ end }}
    </aside>

    <main class="main">
      <h1 class="name">{{ .person.name }}</h1>
      <div class="title">{{ .person.title }}</div>

      <p class="summary">{{ .summary }}</p>

      <section class="section">
        <h3>Experience</h3>
        {{ range .experience }}
        <div class="role">
          <div class="role-head">
            <span class="role-title">{{ .title }}</span>
            <span class="role-when">{{ .when }}</span>
          </div>
          <div class="role-org">{{ .company }} · {{ .location }}</div>
          <ul>
            {{ range .highlights }}<li>{{ . }}</li>{{ end }}
          </ul>
        </div>
        {{ end }}
      </section>

      <section class="section">
        <h3>Education</h3>
        {{ range .education }}
        <div class="edu">
          <div class="deg">{{ .degree }}</div>
          <div>{{ .school }} · {{ .when }}</div>
        </div>
        {{ end }}
      </section>
    </main>
  </div>
</body>
</html>
`,
  sampleData: {
    person: {
      name: "Maya Chen",
      title: "Senior Product Designer",
      email: "maya.chen@example.com",
      phone: "+1 (415) 555-0188",
      location: "San Francisco, CA",
      website: "mayachen.design",
    },
    summary:
      "Product designer with 8+ years shipping consumer and B2B SaaS at scale. Lead design for cross-functional teams, with deep experience in design systems, accessibility, and qualitative research. Hands-on prototyper who partners closely with engineering.",
    skills: [
      "Figma",
      "Design systems",
      "Prototyping",
      "User research",
      "Accessibility",
      "Design ops",
      "HTML / CSS",
    ],
    languages: [
      { name: "English", level: "Native" },
      { name: "Mandarin", level: "Fluent" },
      { name: "Spanish", level: "Conversational" },
    ],
    experience: [
      {
        title: "Senior Product Designer",
        company: "Lumen Labs",
        location: "San Francisco",
        when: "2022 — Present",
        highlights: [
          "Led design for the analytics platform redesign, growing weekly active users 38% in two quarters.",
          "Established the company's first design system, adopted by 12 product squads in six months.",
          "Mentored four junior designers; ran weekly critique and pairing sessions.",
        ],
      },
      {
        title: "Product Designer",
        company: "Northwind",
        location: "Seattle",
        when: "2018 — 2022",
        highlights: [
          "Owned end-to-end design for the onboarding funnel; lifted activation by 22%.",
          "Partnered with engineering to ship a component library used across three product surfaces.",
        ],
      },
    ],
    education: [
      {
        degree: "B.F.A., Interaction Design",
        school: "California College of the Arts",
        when: "2014 — 2018",
      },
    ],
  },
  formSchema: {
    groups: [
      {
        kind: "object",
        id: "person",
        label: "Personal info",
        path: "person",
        fields: [
          { id: "name", label: "Full name", type: "text" },
          { id: "title", label: "Headline", type: "text", placeholder: "e.g. Senior Product Designer" },
          { id: "email", label: "Email", type: "email" },
          { id: "phone", label: "Phone", type: "tel" },
          { id: "location", label: "Location", type: "text" },
          { id: "website", label: "Website", type: "url", optional: true },
        ],
      },
      {
        kind: "scalar",
        id: "summary",
        label: "Summary",
        path: "summary",
        type: "longtext",
        placeholder: "A short paragraph about your experience and strengths.",
      },
      {
        kind: "string-list",
        id: "skills",
        label: "Skills",
        path: "skills",
        itemPlaceholder: "Skill (e.g. Figma)",
      },
      {
        kind: "object-list",
        id: "experience",
        label: "Experience",
        path: "experience",
        itemLabel: "{title} — {company}",
        newItem: { title: "", company: "", location: "", when: "", highlights: [""] },
        fields: [
          { id: "title", label: "Job title", type: "text" },
          { id: "company", label: "Company", type: "text" },
          { id: "location", label: "Location", type: "text" },
          { id: "when", label: "When", type: "text", placeholder: "2022 — Present" },
          { id: "highlights", label: "Highlights", type: "string-list", itemPlaceholder: "Achievement or responsibility" },
        ],
      },
      {
        kind: "object-list",
        id: "education",
        label: "Education",
        path: "education",
        itemLabel: "{degree}",
        newItem: { degree: "", school: "", when: "" },
        fields: [
          { id: "degree", label: "Degree", type: "text" },
          { id: "school", label: "School", type: "text" },
          { id: "when", label: "When", type: "text", placeholder: "2014 — 2018" },
        ],
      },
      {
        kind: "object-list",
        id: "languages",
        label: "Languages",
        path: "languages",
        itemLabel: "{name}",
        newItem: { name: "", level: "" },
        fields: [
          { id: "name", label: "Language", type: "text" },
          { id: "level", label: "Level", type: "text", placeholder: "Native / Fluent / Conversational" },
        ],
      },
    ],
  },
};
