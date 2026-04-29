import type { Starter } from "./types";
import { RESUME_SAMPLE, RESUME_SCHEMA } from "./_resume-sample";

export const resumeTechStarter: Starter = {
  id: "resume-tech",
  name: "Tech resume",
  description:
    "Mono-accented engineer's resume with skill chips and project highlights — built for software roles.",
  category: "Resume",
  tags: ["resume", "tech", "engineer"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .person.name }} — Resume</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: "SF Pro Text", Inter, system-ui, sans-serif; color: #0f172a; margin: 0; font-size: 12px; line-height: 1.55; }
    .page { padding: 48px 56px; }
    .head { display: flex; justify-content: space-between; align-items: flex-end; padding-bottom: 14px; border-bottom: 2px solid #0f172a; }
    .name { font-size: 28px; font-weight: 700; margin: 0; letter-spacing: -.01em; }
    .title { font-size: 13px; color: #475569; margin-top: 2px; font-family: "SF Mono", Menlo, monospace; }
    .contact { font-size: 11px; color: #475569; text-align: right; font-family: "SF Mono", Menlo, monospace; line-height: 1.7; }
    h2 { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #0f172a; font-family: "SF Mono", Menlo, monospace; margin: 22px 0 10px; font-weight: 600; }
    h2::before { content: "// "; color: #10b981; }
    p.summary { margin: 0; font-size: 13px; color: #334155; }
    .skill-grid { display: grid; grid-template-columns: 120px 1fr; gap: 6px 14px; font-size: 12px; }
    .skill-grid b { color: #475569; font-weight: 600; font-family: "SF Mono", Menlo, monospace; font-size: 11px; }
    .chip { display: inline-block; background: #f1f5f9; border: 1px solid #cbd5e1; color: #0f172a; padding: 2px 8px; border-radius: 4px; font-size: 11px; margin: 0 4px 3px 0; font-family: "SF Mono", Menlo, monospace; }
    .role { margin-bottom: 14px; }
    .role .top { display: flex; justify-content: space-between; align-items: baseline; }
    .role .title { font-size: 13px; font-weight: 700; }
    .role .when { font-size: 11px; color: #64748b; font-family: "SF Mono", Menlo, monospace; }
    .role .org { font-size: 12px; color: #475569; margin-bottom: 4px; }
    ul { margin: 0; padding-left: 18px; }
    li { margin-bottom: 2px; }
    .edu { font-size: 12px; margin-bottom: 6px; }
    .edu .deg { font-weight: 600; }
  </style>
</head>
<body>
  <div class="page">
    <div class="head">
      <div>
        <h1 class="name">{{ .person.name }}</h1>
        <div class="title">{{ .person.title }}</div>
      </div>
      <div class="contact">
        {{ .person.email }}<br />
        {{ .person.phone }}<br />
        {{ .person.location }}{{ if .person.website }}<br />{{ .person.website }}{{ end }}
      </div>
    </div>

    <h2>summary</h2>
    <p class="summary">{{ .summary }}</p>

    <h2>skills</h2>
    <div>{{ range .skills }}<span class="chip">{{ . }}</span>{{ end }}</div>

    <h2>experience</h2>
    {{ range .experience }}
    <div class="role">
      <div class="top">
        <span class="title">{{ .title }} <span style="color:#10b981">@</span> {{ .company }}</span>
        <span class="when">{{ .when }}</span>
      </div>
      <div class="org">{{ .location }}</div>
      <ul>
        {{ range .highlights }}<li>{{ . }}</li>{{ end }}
      </ul>
    </div>
    {{ end }}

    <h2>education</h2>
    {{ range .education }}
    <div class="edu">
      <div class="top">
        <span class="deg">{{ .degree }}</span>
        <span class="when" style="float:right">{{ .when }}</span>
      </div>
      <div>{{ .school }}</div>
    </div>
    {{ end }}

    {{ if .languages }}
    <h2>languages</h2>
    <div>{{ range $i, $l := .languages }}{{ if $i }} · {{ end }}<span class="chip">{{ $l.name }} / {{ $l.level }}</span>{{ end }}</div>
    {{ end }}
  </div>
</body>
</html>
`,
  sampleData: RESUME_SAMPLE,
  formSchema: RESUME_SCHEMA,
};
