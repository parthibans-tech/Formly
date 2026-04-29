import type { Starter } from "./types";
import { RESUME_SAMPLE, RESUME_SCHEMA } from "./_resume-sample";

export const resumeEuropeanStarter: Starter = {
  id: "resume-european",
  name: "European CV",
  description:
    "Europass-style structured CV with blue accent — common across EU job applications.",
  category: "Resume",
  tags: ["resume", "european", "europass"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .person.name }} — Curriculum Vitae</title>
  <style>
    @page { size: A4; margin: 0; }
    body { font-family: "Open Sans", Arial, sans-serif; color: #1f2937; margin: 0; font-size: 11.5px; line-height: 1.55; }
    .page { padding: 48px 56px; }
    .head { display: grid; grid-template-columns: 1fr 220px; gap: 24px; padding-bottom: 16px; border-bottom: 3px solid #1e3a8a; margin-bottom: 18px; }
    .head .name { font-size: 24px; font-weight: 700; color: #1e3a8a; margin: 0; }
    .head .title { font-size: 13px; color: #475569; margin-top: 3px; }
    .head .contact { font-size: 11px; color: #334155; margin-top: 8px; line-height: 1.7; }
    .head .seal { background: #1e3a8a; color: white; border-radius: 6px; padding: 12px 14px; font-size: 10px; }
    .head .seal b { display: block; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; margin-bottom: 4px; opacity: .85; }
    .row { display: grid; grid-template-columns: 170px 1fr; gap: 18px; padding: 12px 0; border-bottom: 1px solid #e5e7eb; }
    .row .label { font-size: 11px; color: #1e3a8a; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
    .row p { margin: 0 0 6px; }
    .role { margin-bottom: 10px; }
    .role .title { font-weight: 700; font-size: 12px; }
    .role .org { color: #475569; font-style: italic; font-size: 11.5px; }
    .role .when { color: #64748b; font-size: 11px; }
    ul { margin: 4px 0 0; padding-left: 18px; }
    li { margin-bottom: 2px; }
    .lang-grid { display: grid; grid-template-columns: 1fr auto auto; gap: 8px 14px; font-size: 11.5px; }
    .lang-grid b { color: #1e3a8a; }
  </style>
</head>
<body>
  <div class="page">
    <div class="head">
      <div>
        <h1 class="name">{{ .person.name }}</h1>
        <div class="title">{{ .person.title }}</div>
        <div class="contact">
          {{ .person.location }}<br />
          {{ .person.phone }} · {{ .person.email }}{{ if .person.website }}<br />{{ .person.website }}{{ end }}
        </div>
      </div>
      <div class="seal">
        <b>Curriculum Vitae</b>
        Europass-style format compliant with EU recruitment standards. Personal data processed per GDPR.
      </div>
    </div>

    <div class="row">
      <div class="label">Personal statement</div>
      <p>{{ .summary }}</p>
    </div>

    <div class="row">
      <div class="label">Work experience</div>
      <div>
        {{ range .experience }}
        <div class="role">
          <div class="when">{{ .when }}</div>
          <div class="title">{{ .title }}</div>
          <div class="org">{{ .company }}, {{ .location }}</div>
          <ul>
            {{ range .highlights }}<li>{{ . }}</li>{{ end }}
          </ul>
        </div>
        {{ end }}
      </div>
    </div>

    <div class="row">
      <div class="label">Education &amp; training</div>
      <div>
        {{ range .education }}
        <div class="role">
          <div class="when">{{ .when }}</div>
          <div class="title">{{ .degree }}</div>
          <div class="org">{{ .school }}</div>
        </div>
        {{ end }}
      </div>
    </div>

    <div class="row">
      <div class="label">Skills</div>
      <p>{{ range $i, $s := .skills }}{{ if $i }} · {{ end }}{{ $s }}{{ end }}</p>
    </div>

    {{ if .languages }}
    <div class="row">
      <div class="label">Languages</div>
      <div class="lang-grid">
        {{ range .languages }}
        <b>{{ .name }}</b><span>Speaking: {{ .level }}</span><span>Writing: {{ .level }}</span>
        {{ end }}
      </div>
    </div>
    {{ end }}
  </div>
</body>
</html>
`,
  sampleData: RESUME_SAMPLE,
  formSchema: RESUME_SCHEMA,
};
