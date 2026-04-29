import type { Starter } from "./types";
import { RESUME_SAMPLE, RESUME_SCHEMA } from "./_resume-sample";

export const resumeAcademicStarter: Starter = {
  id: "resume-academic",
  name: "Academic CV",
  description:
    "Long-form academic CV layout — for researchers, faculty applicants, and PhD candidates.",
  category: "Resume",
  tags: ["resume", "academic", "cv"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .person.name }} — Curriculum Vitae</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: "Latin Modern Roman", Cambria, "Times New Roman", serif; color: #1c1917; margin: 0; font-size: 11.5px; line-height: 1.55; }
    .page { padding: 64px 80px; max-width: 820px; margin: auto; }
    .head { text-align: center; margin-bottom: 22px; }
    .name { font-size: 26px; font-weight: 600; margin: 0; letter-spacing: .02em; }
    .title { font-size: 12px; font-style: italic; color: #44403c; margin-top: 3px; }
    .contact { font-size: 11px; color: #57534e; margin-top: 6px; }
    h2 { font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #1c1917; margin: 20px 0 8px; padding-bottom: 2px; border-bottom: 1px solid #57534e; }
    p { margin: 0 0 8px; }
    .row { display: grid; grid-template-columns: 110px 1fr; gap: 14px; margin-bottom: 8px; }
    .row .when { color: #57534e; font-style: italic; font-size: 11px; }
    .row .deg, .row .title { font-weight: 600; }
    .row .org { font-style: italic; color: #44403c; }
    ul { margin: 4px 0 0; padding-left: 18px; }
    li { margin-bottom: 2px; }
  </style>
</head>
<body>
  <div class="page">
    <div class="head">
      <h1 class="name">{{ .person.name }}</h1>
      <div class="title">{{ .person.title }}</div>
      <div class="contact">{{ .person.location }} · {{ .person.email }} · {{ .person.phone }}{{ if .person.website }} · {{ .person.website }}{{ end }}</div>
    </div>

    <h2>Research statement</h2>
    <p>{{ .summary }}</p>

    <h2>Education</h2>
    {{ range .education }}
    <div class="row">
      <div class="when">{{ .when }}</div>
      <div>
        <div class="deg">{{ .degree }}</div>
        <div class="org">{{ .school }}</div>
      </div>
    </div>
    {{ end }}

    <h2>Academic appointments &amp; experience</h2>
    {{ range .experience }}
    <div class="row">
      <div class="when">{{ .when }}</div>
      <div>
        <div class="title">{{ .title }}</div>
        <div class="org">{{ .company }}, {{ .location }}</div>
        <ul>
          {{ range .highlights }}<li>{{ . }}</li>{{ end }}
        </ul>
      </div>
    </div>
    {{ end }}

    <h2>Areas of expertise</h2>
    <p>{{ range $i, $s := .skills }}{{ if $i }}; {{ end }}{{ $s }}{{ end }}.</p>

    {{ if .languages }}
    <h2>Languages</h2>
    <p>{{ range $i, $l := .languages }}{{ if $i }}; {{ end }}{{ $l.name }} ({{ $l.level }}){{ end }}.</p>
    {{ end }}
  </div>
</body>
</html>
`,
  sampleData: RESUME_SAMPLE,
  formSchema: RESUME_SCHEMA,
};
