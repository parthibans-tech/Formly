import type { Starter } from "./types";
import { RESUME_SAMPLE, RESUME_SCHEMA } from "./_resume-sample";

export const resumeClassicStarter: Starter = {
  id: "resume-classic",
  name: "Classic resume",
  description:
    "Traditional centered-name serif resume — conservative typography for law, finance, and academia.",
  category: "Resume",
  tags: ["resume", "classic", "traditional"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .person.name }} — Resume</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: "Times New Roman", Georgia, serif; color: #000; padding: 56px 72px; max-width: 780px; margin: auto; line-height: 1.5; font-size: 12px; }
    .head { text-align: center; padding-bottom: 14px; border-bottom: 2px solid #000; }
    .name { font-size: 28px; font-weight: 700; letter-spacing: .14em; margin: 0; text-transform: uppercase; }
    .title { font-size: 13px; font-style: italic; color: #333; margin-top: 4px; }
    .contact { font-size: 11px; margin-top: 8px; }
    h2 { font-size: 13px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; text-align: center; border-bottom: 1px solid #000; padding-bottom: 3px; margin: 22px 0 10px; }
    p { margin: 0 0 10px; }
    .role { margin-bottom: 12px; }
    .role .top { display: flex; justify-content: space-between; }
    .role .title { font-weight: 700; font-style: normal; color: #000; font-size: 12px; }
    .role .when { font-style: italic; }
    .role .org { font-style: italic; margin-bottom: 4px; }
    ul { margin: 4px 0 0; padding-left: 20px; }
    li { margin-bottom: 2px; }
    .skills { text-align: center; }
  </style>
</head>
<body>
  <div class="head">
    <h1 class="name">{{ .person.name }}</h1>
    <div class="title">{{ .person.title }}</div>
    <div class="contact">
      {{ .person.location }} · {{ .person.phone }} · {{ .person.email }}
      {{ if .person.website }} · {{ .person.website }}{{ end }}
    </div>
  </div>

  <h2>Profile</h2>
  <p>{{ .summary }}</p>

  <h2>Experience</h2>
  {{ range .experience }}
  <div class="role">
    <div class="top">
      <span class="title">{{ .title }}</span>
      <span class="when">{{ .when }}</span>
    </div>
    <div class="org">{{ .company }}, {{ .location }}</div>
    <ul>
      {{ range .highlights }}<li>{{ . }}</li>{{ end }}
    </ul>
  </div>
  {{ end }}

  <h2>Education</h2>
  {{ range .education }}
  <div class="role">
    <div class="top">
      <span class="title">{{ .degree }}</span>
      <span class="when">{{ .when }}</span>
    </div>
    <div class="org">{{ .school }}</div>
  </div>
  {{ end }}

  <h2>Skills</h2>
  <p class="skills">{{ range $i, $s := .skills }}{{ if $i }} · {{ end }}{{ $s }}{{ end }}</p>

  {{ if .languages }}
  <h2>Languages</h2>
  <p class="skills">{{ range $i, $l := .languages }}{{ if $i }} · {{ end }}{{ $l.name }} ({{ $l.level }}){{ end }}</p>
  {{ end }}
</body>
</html>
`,
  sampleData: RESUME_SAMPLE,
  formSchema: RESUME_SCHEMA,
};
