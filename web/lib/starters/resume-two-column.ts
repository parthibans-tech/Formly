import type { Starter } from "./types";
import { RESUME_SAMPLE, RESUME_SCHEMA } from "./_resume-sample";

export const resumeTwoColumnStarter: Starter = {
  id: "resume-two-column",
  name: "Two-column resume",
  description:
    "Light two-column layout — facts and skills on the left, experience on the right.",
  category: "Resume",
  tags: ["resume", "two-column", "sidebar"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .person.name }} — Resume</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #1f2937; margin: 0; font-size: 12px; line-height: 1.5; }
    .page { display: grid; grid-template-columns: 240px 1fr; min-height: 1056px; }
    .left { background: #f1f5f9; padding: 44px 24px; border-right: 1px solid #e2e8f0; }
    .left .name { font-size: 22px; font-weight: 800; color: #0f172a; letter-spacing: -.01em; line-height: 1.15; }
    .left .title { font-size: 12px; color: #475569; margin-top: 4px; }
    .left h2 { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #475569; margin: 24px 0 8px; font-weight: 700; padding-top: 10px; border-top: 2px solid #cbd5e1; }
    .left .item { font-size: 11px; margin-bottom: 4px; word-break: break-word; }
    .left .item b { display: block; color: #0f172a; }
    .skill-row { font-size: 11px; margin-bottom: 4px; }
    .skill-bar { height: 4px; background: #cbd5e1; border-radius: 2px; margin-top: 3px; overflow: hidden; }
    .skill-bar i { display: block; height: 100%; background: #0f172a; }
    .right { padding: 44px 36px; }
    .right h3 { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #0f172a; font-weight: 700; margin: 0 0 12px; padding-bottom: 4px; border-bottom: 2px solid #0f172a; }
    .right h3:not(:first-child) { margin-top: 22px; }
    p.summary { margin: 0 0 16px; font-size: 12px; color: #334155; }
    .role { margin-bottom: 14px; }
    .role .top { display: flex; justify-content: space-between; align-items: baseline; }
    .role .name { font-size: 13px; font-weight: 700; color: #0f172a; }
    .role .when { font-size: 10px; color: #64748b; font-variant-numeric: tabular-nums; }
    .role .org { font-size: 11px; color: #475569; font-style: italic; margin-bottom: 4px; }
    ul { margin: 0; padding-left: 16px; }
    li { margin-bottom: 2px; }
    .edu .deg { font-weight: 600; color: #0f172a; }
  </style>
</head>
<body>
  <div class="page">
    <aside class="left">
      <div class="name">{{ .person.name }}</div>
      <div class="title">{{ .person.title }}</div>

      <h2>Contact</h2>
      <div class="item"><b>Email</b>{{ .person.email }}</div>
      <div class="item"><b>Phone</b>{{ .person.phone }}</div>
      <div class="item"><b>Location</b>{{ .person.location }}</div>
      {{ if .person.website }}<div class="item"><b>Web</b>{{ .person.website }}</div>{{ end }}

      <h2>Skills</h2>
      {{ range .skills }}
      <div class="skill-row">{{ . }}<div class="skill-bar"><i style="width: 88%"></i></div></div>
      {{ end }}

      {{ if .languages }}
      <h2>Languages</h2>
      {{ range .languages }}
      <div class="item"><b>{{ .name }}</b>{{ .level }}</div>
      {{ end }}
      {{ end }}
    </aside>

    <main class="right">
      <h3>Profile</h3>
      <p class="summary">{{ .summary }}</p>

      <h3>Experience</h3>
      {{ range .experience }}
      <div class="role">
        <div class="top">
          <span class="name">{{ .title }}</span>
          <span class="when">{{ .when }}</span>
        </div>
        <div class="org">{{ .company }} · {{ .location }}</div>
        <ul>
          {{ range .highlights }}<li>{{ . }}</li>{{ end }}
        </ul>
      </div>
      {{ end }}

      <h3>Education</h3>
      {{ range .education }}
      <div class="role edu">
        <div class="top">
          <span class="name deg">{{ .degree }}</span>
          <span class="when">{{ .when }}</span>
        </div>
        <div class="org">{{ .school }}</div>
      </div>
      {{ end }}
    </main>
  </div>
</body>
</html>
`,
  sampleData: RESUME_SAMPLE,
  formSchema: RESUME_SCHEMA,
};
