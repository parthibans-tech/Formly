import type { Starter } from "./types";
import { RESUME_SAMPLE, RESUME_SCHEMA } from "./_resume-sample";

export const resumeFederalStarter: Starter = {
  id: "resume-federal",
  name: "Federal resume",
  description:
    "Detailed format for US federal job applications (USAJOBS) — full duties, dates, and supervisors.",
  category: "Resume",
  tags: ["resume", "federal", "government"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .person.name }} — Federal Resume</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Arial, Helvetica, sans-serif; color: #000; margin: 0; font-size: 11.5px; line-height: 1.5; }
    .page { padding: 56px 64px; }
    .head { border-bottom: 2px solid #000; padding-bottom: 10px; margin-bottom: 16px; }
    .name { font-size: 22px; font-weight: 700; margin: 0; text-transform: uppercase; }
    .contact { font-size: 11px; margin-top: 6px; line-height: 1.6; }
    h2 { font-size: 12px; font-weight: 700; text-transform: uppercase; background: #000; color: #fff; padding: 4px 10px; margin: 18px 0 10px; }
    .field { margin-bottom: 4px; font-size: 11.5px; }
    .field b { display: inline-block; min-width: 130px; font-weight: 700; }
    .role { margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid #cbd5e1; }
    .role .title { font-weight: 700; font-size: 12px; }
    .role .org { font-weight: 600; }
    .role .meta { font-size: 11px; line-height: 1.7; margin-top: 2px; }
    ul { margin: 6px 0 0; padding-left: 20px; }
    li { margin-bottom: 3px; font-size: 11.5px; }
    p { margin: 0 0 8px; }
  </style>
</head>
<body>
  <div class="page">
    <div class="head">
      <h1 class="name">{{ .person.name }}</h1>
      <div class="contact">
        <div>{{ .person.location }}</div>
        <div>Phone: {{ .person.phone }} · Email: {{ .person.email }}{{ if .person.website }} · Web: {{ .person.website }}{{ end }}</div>
        <div>US Citizen · Veterans' Preference: N/A · Federal Civilian Status: N/A</div>
      </div>
    </div>

    <h2>Objective</h2>
    <p>{{ .summary }}</p>

    <h2>Work Experience</h2>
    {{ range .experience }}
    <div class="role">
      <div class="title">{{ .title }}</div>
      <div class="org">{{ .company }}, {{ .location }}</div>
      <div class="meta">
        <div><b>Dates:</b> {{ .when }}</div>
        <div><b>Hours per week:</b> 40</div>
        <div><b>Salary:</b> Available upon request</div>
        <div><b>Supervisor:</b> Available upon request (may contact)</div>
      </div>
      <div style="margin-top:6px"><b>Duties &amp; accomplishments:</b></div>
      <ul>
        {{ range .highlights }}<li>{{ . }}</li>{{ end }}
      </ul>
    </div>
    {{ end }}

    <h2>Education</h2>
    {{ range .education }}
    <div class="role" style="border-bottom: none; padding-bottom: 0;">
      <div class="title">{{ .degree }}</div>
      <div class="org">{{ .school }}</div>
      <div class="meta"><b>Completion date:</b> {{ .when }} · <b>GPA:</b> Available upon request</div>
    </div>
    {{ end }}

    <h2>Skills &amp; Competencies</h2>
    <p>{{ range $i, $s := .skills }}{{ if $i }}; {{ end }}{{ $s }}{{ end }}.</p>

    {{ if .languages }}
    <h2>Languages</h2>
    <p>{{ range $i, $l := .languages }}{{ if $i }}; {{ end }}{{ $l.name }} — {{ $l.level }}{{ end }}.</p>
    {{ end }}

    <h2>References</h2>
    <p>Available upon request.</p>
  </div>
</body>
</html>
`,
  sampleData: RESUME_SAMPLE,
  formSchema: RESUME_SCHEMA,
};
