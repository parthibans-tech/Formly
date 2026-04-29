import type { Starter } from "./types";
import { RESUME_SAMPLE, RESUME_SCHEMA } from "./_resume-sample";

export const resumeExecutiveStarter: Starter = {
  id: "resume-executive",
  name: "Executive resume",
  description:
    "Authoritative serif layout with a leadership summary band — for C-suite, VPs, and senior managers.",
  category: "Resume",
  tags: ["resume", "executive", "leadership"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .person.name }} — Resume</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Georgia, "Times New Roman", serif; color: #111827; margin: 0; font-size: 12px; line-height: 1.55; }
    .page { padding: 56px 64px; }
    .head { border-bottom: 3px double #111827; padding-bottom: 14px; margin-bottom: 18px; }
    .name { font-size: 34px; font-weight: 700; letter-spacing: .04em; margin: 0; text-transform: uppercase; }
    .title { font-size: 14px; font-style: italic; color: #374151; margin-top: 4px; }
    .contact { font-size: 11px; color: #4b5563; margin-top: 8px; }
    .band { background: #111827; color: #f9fafb; padding: 18px 22px; margin-bottom: 22px; }
    .band h2 { margin: 0 0 6px; font-size: 11px; letter-spacing: .2em; text-transform: uppercase; color: #9ca3af; font-weight: 700; }
    .band p { margin: 0; font-size: 13px; line-height: 1.65; }
    h2 { font-size: 12px; letter-spacing: .2em; text-transform: uppercase; color: #111827; font-weight: 700; border-bottom: 1px solid #111827; padding-bottom: 3px; margin: 18px 0 12px; }
    .role { margin-bottom: 14px; }
    .role .top { display: flex; justify-content: space-between; align-items: baseline; }
    .role .title { font-size: 13px; font-weight: 700; font-style: normal; color: #111827; }
    .role .when { font-style: italic; color: #4b5563; font-size: 11px; }
    .role .org { font-size: 12px; color: #4b5563; font-style: italic; margin-bottom: 4px; }
    ul { margin: 4px 0 0; padding-left: 18px; }
    li { margin-bottom: 3px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
    .skills span { display: inline-block; font-size: 11px; padding: 3px 9px; border: 1px solid #111827; margin: 0 4px 4px 0; }
  </style>
</head>
<body>
  <div class="page">
    <div class="head">
      <h1 class="name">{{ .person.name }}</h1>
      <div class="title">{{ .person.title }}</div>
      <div class="contact">{{ .person.location }} &nbsp;·&nbsp; {{ .person.phone }} &nbsp;·&nbsp; {{ .person.email }}{{ if .person.website }} &nbsp;·&nbsp; {{ .person.website }}{{ end }}</div>
    </div>

    <div class="band">
      <h2>Executive summary</h2>
      <p>{{ .summary }}</p>
    </div>

    <h2>Professional experience</h2>
    {{ range .experience }}
    <div class="role">
      <div class="top">
        <span class="title">{{ .title }}</span>
        <span class="when">{{ .when }}</span>
      </div>
      <div class="org">{{ .company }} — {{ .location }}</div>
      <ul>
        {{ range .highlights }}<li>{{ . }}</li>{{ end }}
      </ul>
    </div>
    {{ end }}

    <div class="grid">
      <div>
        <h2>Education</h2>
        {{ range .education }}
        <div class="role">
          <div class="top"><span class="title">{{ .degree }}</span><span class="when">{{ .when }}</span></div>
          <div class="org">{{ .school }}</div>
        </div>
        {{ end }}
      </div>
      <div>
        <h2>Core competencies</h2>
        <div class="skills">
          {{ range .skills }}<span>{{ . }}</span>{{ end }}
        </div>
        {{ if .languages }}
        <h2>Languages</h2>
        <div>{{ range $i, $l := .languages }}{{ if $i }} · {{ end }}{{ $l.name }} ({{ $l.level }}){{ end }}</div>
        {{ end }}
      </div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: RESUME_SAMPLE,
  formSchema: RESUME_SCHEMA,
};
