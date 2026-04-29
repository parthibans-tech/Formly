import type { Starter } from "./types";
import { RESUME_SAMPLE, RESUME_SCHEMA } from "./_resume-sample";

export const resumeWithCoverStarter: Starter = {
  id: "resume-with-cover",
  name: "Resume with cover letter",
  description:
    "Two-page document — cover letter on page 1, resume on page 2 — sharing the same letterhead.",
  category: "Resume",
  tags: ["resume", "cover-letter", "combo"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .person.name }} — Application</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #1f2937; margin: 0; font-size: 12px; line-height: 1.55; }
    .page { padding: 56px 64px; min-height: 1056px; box-sizing: border-box; page-break-after: always; }
    .page:last-child { page-break-after: auto; }
    .header { display: flex; justify-content: space-between; align-items: flex-end; padding-bottom: 14px; border-bottom: 2px solid #0f172a; margin-bottom: 24px; }
    .header .name { font-size: 26px; font-weight: 700; margin: 0; letter-spacing: -.01em; }
    .header .title { font-size: 12px; color: #475569; margin-top: 1px; }
    .header .contact { font-size: 11px; color: #475569; text-align: right; line-height: 1.7; }
    p { margin: 0 0 12px; }
    .sig { margin-top: 28px; }
    .sig b { font-size: 13px; }
    h2 { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #0f172a; font-weight: 700; margin: 18px 0 8px; border-bottom: 1px solid #cbd5e1; padding-bottom: 3px; }
    .role { margin-bottom: 12px; }
    .role .top { display: flex; justify-content: space-between; }
    .role .rt { font-size: 13px; font-weight: 700; }
    .role .when { font-size: 11px; color: #64748b; }
    .role .org { font-size: 11.5px; color: #475569; font-style: italic; }
    ul { margin: 4px 0 0; padding-left: 18px; }
    li { margin-bottom: 2px; font-size: 12px; }
    .skills { font-size: 12px; }
    .edu { font-size: 12px; margin-bottom: 6px; }
    .edu .deg { font-weight: 600; }
  </style>
</head>
<body>
  <!-- Page 1: Cover letter -->
  <div class="page">
    <div class="header">
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

    <p>Dear hiring team,</p>

    <p>{{ .summary }}</p>

    <p>Across recent roles I have led work I am proud of, including:</p>
    <ul>
      {{ range .experience }}<li>{{ .title }} at {{ .company }} — {{ .when }}</li>{{ end }}
    </ul>

    <p>The skills I lean on most — {{ range $i, $s := .skills }}{{ if $i }}, {{ end }}{{ $s }}{{ end }} — feel directly relevant to the role, and I'd welcome the chance to discuss how they fit your team's needs.</p>

    <p>Thank you for considering my application. I'd be glad to share work samples or schedule a conversation at your convenience.</p>

    <div class="sig">
      <p>Sincerely,</p>
      <b>{{ .person.name }}</b>
    </div>
  </div>

  <!-- Page 2: Resume -->
  <div class="page">
    <div class="header">
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

    <h2>Summary</h2>
    <p>{{ .summary }}</p>

    <h2>Experience</h2>
    {{ range .experience }}
    <div class="role">
      <div class="top">
        <span class="rt">{{ .title }}</span>
        <span class="when">{{ .when }}</span>
      </div>
      <div class="org">{{ .company }} · {{ .location }}</div>
      <ul>
        {{ range .highlights }}<li>{{ . }}</li>{{ end }}
      </ul>
    </div>
    {{ end }}

    <h2>Education</h2>
    {{ range .education }}
    <div class="edu">
      <div class="deg">{{ .degree }}</div>
      <div>{{ .school }} · {{ .when }}</div>
    </div>
    {{ end }}

    <h2>Skills</h2>
    <div class="skills">{{ range $i, $s := .skills }}{{ if $i }} · {{ end }}{{ $s }}{{ end }}</div>

    {{ if .languages }}
    <h2>Languages</h2>
    <div class="skills">{{ range $i, $l := .languages }}{{ if $i }} · {{ end }}{{ $l.name }} ({{ $l.level }}){{ end }}</div>
    {{ end }}
  </div>
</body>
</html>
`,
  sampleData: RESUME_SAMPLE,
  formSchema: RESUME_SCHEMA,
};
