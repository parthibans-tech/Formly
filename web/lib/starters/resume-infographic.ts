import type { Starter } from "./types";
import { RESUME_SAMPLE, RESUME_SCHEMA } from "./_resume-sample";

export const resumeInfographicStarter: Starter = {
  id: "resume-infographic",
  name: "Infographic resume",
  description:
    "Visual sidebar with skill bars, language meters, and timeline — high-impact for marketing and creative roles.",
  category: "Resume",
  tags: ["resume", "infographic", "visual"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .person.name }} — Resume</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #1f2937; margin: 0; font-size: 12px; line-height: 1.5; }
    .page { display: grid; grid-template-columns: 280px 1fr; min-height: 1056px; }
    .left { background: #0d9488; color: white; padding: 44px 26px; }
    .left .badge { width: 90px; height: 90px; border-radius: 50%; background: rgba(255,255,255,.18); margin: 0 auto 14px; display: flex; align-items: center; justify-content: center; border: 3px solid rgba(255,255,255,.35); }
    .left .badge::after { content: "★"; font-size: 36px; color: #fef3c7; }
    .left .name { text-align: center; font-size: 22px; font-weight: 700; line-height: 1.2; margin-bottom: 4px; }
    .left .title { text-align: center; font-size: 12px; opacity: .85; margin-bottom: 22px; }
    .left h2 { font-size: 11px; letter-spacing: .16em; text-transform: uppercase; margin: 22px 0 10px; opacity: .9; font-weight: 700; border-bottom: 1px solid rgba(255,255,255,.3); padding-bottom: 4px; }
    .left .item { font-size: 11px; margin-bottom: 4px; word-break: break-word; }
    .skill { font-size: 11px; margin-bottom: 8px; }
    .skill .bar { height: 6px; background: rgba(255,255,255,.2); border-radius: 3px; margin-top: 3px; overflow: hidden; }
    .skill .bar i { display: block; height: 100%; background: #fef3c7; }
    .lang { font-size: 11px; margin-bottom: 6px; display: flex; justify-content: space-between; }
    .lang .dots { letter-spacing: 2px; }
    .right { padding: 44px 36px; }
    h3 { font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: #0d9488; font-weight: 700; margin: 0 0 14px; }
    h3:not(:first-child) { margin-top: 22px; }
    p.summary { font-size: 13px; color: #334155; margin: 0 0 10px; }
    .timeline { position: relative; padding-left: 22px; }
    .timeline::before { content: ""; position: absolute; left: 6px; top: 4px; bottom: 4px; width: 2px; background: #ccfbf1; }
    .role { position: relative; margin-bottom: 16px; }
    .role::before { content: ""; position: absolute; left: -22px; top: 4px; width: 14px; height: 14px; border-radius: 50%; background: #0d9488; border: 3px solid white; box-shadow: 0 0 0 2px #0d9488; }
    .role .top { display: flex; justify-content: space-between; align-items: baseline; }
    .role .title { font-size: 13px; font-weight: 700; color: #0f172a; }
    .role .when { font-size: 11px; color: #0d9488; font-weight: 600; }
    .role .org { font-size: 12px; color: #475569; margin-bottom: 4px; }
    ul { margin: 0; padding-left: 16px; }
    li { margin-bottom: 2px; }
    .edu { font-size: 12px; margin-bottom: 6px; }
    .edu .deg { font-weight: 600; color: #0f172a; }
  </style>
</head>
<body>
  <div class="page">
    <aside class="left">
      <div class="badge"></div>
      <div class="name">{{ .person.name }}</div>
      <div class="title">{{ .person.title }}</div>

      <h2>Contact</h2>
      <div class="item">{{ .person.email }}</div>
      <div class="item">{{ .person.phone }}</div>
      <div class="item">{{ .person.location }}</div>
      {{ if .person.website }}<div class="item">{{ .person.website }}</div>{{ end }}

      <h2>Skills</h2>
      {{ range $i, $s := .skills }}
      <div class="skill">{{ $s }}<div class="bar"><i style="width: {{ if eq $i 0 }}95{{ else if eq $i 1 }}88{{ else if eq $i 2 }}82{{ else }}75{{ end }}%"></i></div></div>
      {{ end }}

      {{ if .languages }}
      <h2>Languages</h2>
      {{ range .languages }}
      <div class="lang"><span>{{ .name }}</span><span class="dots">●●●●●</span></div>
      {{ end }}
      {{ end }}
    </aside>

    <main class="right">
      <h3>About me</h3>
      <p class="summary">{{ .summary }}</p>

      <h3>Experience</h3>
      <div class="timeline">
        {{ range .experience }}
        <div class="role">
          <div class="top">
            <span class="title">{{ .title }}</span>
            <span class="when">{{ .when }}</span>
          </div>
          <div class="org">{{ .company }} · {{ .location }}</div>
          <ul>
            {{ range .highlights }}<li>{{ . }}</li>{{ end }}
          </ul>
        </div>
        {{ end }}
      </div>

      <h3>Education</h3>
      {{ range .education }}
      <div class="edu">
        <div class="deg">{{ .degree }}</div>
        <div>{{ .school }} · {{ .when }}</div>
      </div>
      {{ end }}
    </main>
  </div>
</body>
</html>
`,
  sampleData: RESUME_SAMPLE,
  formSchema: RESUME_SCHEMA,
};
