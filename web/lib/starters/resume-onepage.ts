import type { Starter } from "./types";
import { RESUME_SAMPLE, RESUME_SCHEMA } from "./_resume-sample";

export const resumeOnepageStarter: Starter = {
  id: "resume-onepage",
  name: "Minimal one-page resume",
  description:
    "Tight single-column minimal layout that fits on one page — clean black-and-white typography.",
  category: "Resume",
  tags: ["resume", "minimal", "one-page"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .person.name }} — Resume</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; color: #000; margin: 0; font-size: 11px; line-height: 1.5; }
    .page { padding: 48px 64px; max-width: 760px; margin: auto; }
    .head { margin-bottom: 18px; }
    .name { font-size: 22px; font-weight: 600; margin: 0; letter-spacing: -.01em; }
    .title { font-size: 12px; color: #555; margin-top: 1px; }
    .contact { font-size: 10.5px; color: #555; margin-top: 6px; }
    h2 { font-size: 10px; letter-spacing: .18em; text-transform: uppercase; font-weight: 700; margin: 14px 0 6px; color: #000; }
    p.summary { margin: 0 0 4px; font-size: 11.5px; }
    .role { margin-bottom: 8px; }
    .role .top { display: flex; justify-content: space-between; align-items: baseline; }
    .role .title { font-size: 11.5px; font-weight: 600; color: #000; }
    .role .when { font-size: 10.5px; color: #666; }
    .role .org { font-size: 11px; color: #333; }
    ul { margin: 2px 0 0; padding-left: 16px; font-size: 11px; }
    li { margin-bottom: 1px; }
    .inline { font-size: 11px; }
    hr { border: none; border-top: 1px solid #000; margin: 14px 0 0; }
  </style>
</head>
<body>
  <div class="page">
    <div class="head">
      <h1 class="name">{{ .person.name }}</h1>
      <div class="title">{{ .person.title }}</div>
      <div class="contact">{{ .person.email }} · {{ .person.phone }} · {{ .person.location }}{{ if .person.website }} · {{ .person.website }}{{ end }}</div>
    </div>

    <hr />
    <h2>Summary</h2>
    <p class="summary">{{ .summary }}</p>

    <h2>Experience</h2>
    {{ range .experience }}
    <div class="role">
      <div class="top">
        <span class="title">{{ .title }} — {{ .company }}</span>
        <span class="when">{{ .when }}</span>
      </div>
      <div class="org">{{ .location }}</div>
      <ul>
        {{ range .highlights }}<li>{{ . }}</li>{{ end }}
      </ul>
    </div>
    {{ end }}

    <h2>Education</h2>
    {{ range .education }}
    <div class="role">
      <div class="top">
        <span class="title">{{ .degree }} — {{ .school }}</span>
        <span class="when">{{ .when }}</span>
      </div>
    </div>
    {{ end }}

    <h2>Skills</h2>
    <p class="inline">{{ range $i, $s := .skills }}{{ if $i }} · {{ end }}{{ $s }}{{ end }}</p>

    {{ if .languages }}
    <h2>Languages</h2>
    <p class="inline">{{ range $i, $l := .languages }}{{ if $i }} · {{ end }}{{ $l.name }} ({{ $l.level }}){{ end }}</p>
    {{ end }}
  </div>
</body>
</html>
`,
  sampleData: RESUME_SAMPLE,
  formSchema: RESUME_SCHEMA,
};
