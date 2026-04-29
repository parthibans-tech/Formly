import type { Starter } from "./types";
import { RESUME_SAMPLE, RESUME_SCHEMA } from "./_resume-sample";

export const resumeFunctionalStarter: Starter = {
  id: "resume-functional",
  name: "Functional resume",
  description:
    "Skills-first layout that downplays job dates — ideal for career changers and gaps in employment.",
  category: "Resume",
  tags: ["resume", "functional", "skills-first"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .person.name }} — Resume</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #1f2937; margin: 0; font-size: 12px; line-height: 1.55; }
    .page { padding: 48px 56px; }
    .head { padding-bottom: 14px; border-bottom: 4px solid #4338ca; margin-bottom: 20px; }
    .name { font-size: 30px; font-weight: 800; color: #1e1b4b; margin: 0; letter-spacing: -.01em; }
    .title { font-size: 13px; color: #4338ca; margin-top: 3px; font-weight: 600; }
    .contact { font-size: 11px; color: #475569; margin-top: 6px; }
    h2 { font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: #4338ca; font-weight: 700; margin: 22px 0 10px; }
    p.summary { font-size: 13px; color: #334155; margin: 0 0 8px; }
    .skill-block { background: #eef2ff; border-left: 4px solid #4338ca; padding: 10px 14px; margin-bottom: 10px; }
    .skill-block b { display: block; color: #1e1b4b; font-size: 13px; margin-bottom: 4px; }
    .skill-block p { margin: 0; font-size: 12px; color: #334155; }
    .role { display: grid; grid-template-columns: 1fr auto; gap: 12px; padding: 8px 0; border-bottom: 1px dashed #cbd5e1; font-size: 12px; }
    .role .what { font-weight: 600; color: #1e1b4b; }
    .role .org { color: #475569; }
    .role .when { color: #64748b; font-size: 11px; white-space: nowrap; }
    .edu { font-size: 12px; margin-bottom: 6px; }
    .edu .deg { font-weight: 600; color: #1e1b4b; }
  </style>
</head>
<body>
  <div class="page">
    <div class="head">
      <h1 class="name">{{ .person.name }}</h1>
      <div class="title">{{ .person.title }}</div>
      <div class="contact">{{ .person.email }} · {{ .person.phone }} · {{ .person.location }}{{ if .person.website }} · {{ .person.website }}{{ end }}</div>
    </div>

    <h2>Profile</h2>
    <p class="summary">{{ .summary }}</p>

    <h2>Areas of strength</h2>
    {{ range .experience }}
    <div class="skill-block">
      <b>{{ .title }}</b>
      <p>{{ range $i, $h := .highlights }}{{ if $i }} · {{ end }}{{ $h }}{{ end }}</p>
    </div>
    {{ end }}

    <h2>Skills toolkit</h2>
    <p>{{ range $i, $s := .skills }}{{ if $i }} · {{ end }}{{ $s }}{{ end }}</p>

    <h2>Work history</h2>
    {{ range .experience }}
    <div class="role">
      <div>
        <div class="what">{{ .title }}</div>
        <div class="org">{{ .company }} — {{ .location }}</div>
      </div>
      <div class="when">{{ .when }}</div>
    </div>
    {{ end }}

    <h2>Education</h2>
    {{ range .education }}
    <div class="edu">
      <div class="deg">{{ .degree }}</div>
      <div>{{ .school }} · {{ .when }}</div>
    </div>
    {{ end }}

    {{ if .languages }}
    <h2>Languages</h2>
    <p>{{ range $i, $l := .languages }}{{ if $i }} · {{ end }}{{ $l.name }} ({{ $l.level }}){{ end }}</p>
    {{ end }}
  </div>
</body>
</html>
`,
  sampleData: RESUME_SAMPLE,
  formSchema: RESUME_SCHEMA,
};
