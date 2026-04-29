import type { Starter } from "./types";
import { RESUME_SAMPLE, RESUME_SCHEMA } from "./_resume-sample";

export const resumeStarter: Starter = {
  id: "resume",
  name: "Modern resume",
  description:
    "One-page CV with dark sidebar, experience timeline, skills, and education sections.",
  category: "Resume",
  tags: ["resume", "cv", "modern"],
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
  sampleData: RESUME_SAMPLE,
  formSchema: RESUME_SCHEMA,
};
