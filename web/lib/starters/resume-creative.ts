import type { Starter } from "./types";
import { RESUME_SAMPLE, RESUME_SCHEMA } from "./_resume-sample";

export const resumeCreativeStarter: Starter = {
  id: "resume-creative",
  name: "Creative resume",
  description:
    "Bold accent header with display typography — for designers, creatives, and brand-focused candidates.",
  category: "Resume",
  tags: ["resume", "creative", "designer"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .person.name }} — Resume</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #1f2937; margin: 0; font-size: 12px; line-height: 1.5; }
    .page { min-height: 1056px; padding-bottom: 36px; }
    .hero { background: linear-gradient(135deg, #ec4899 0%, #f97316 100%); color: white; padding: 48px 56px 36px; }
    .hero .name { font-size: 48px; font-weight: 800; letter-spacing: -.02em; margin: 0; line-height: 1; }
    .hero .title { font-size: 16px; margin-top: 6px; opacity: .9; }
    .hero .contact { display: flex; gap: 18px; margin-top: 18px; font-size: 12px; }
    .hero .contact span { padding: 4px 12px; background: rgba(255,255,255,.18); border-radius: 999px; backdrop-filter: blur(4px); }
    .body { display: grid; grid-template-columns: 1fr 240px; gap: 36px; padding: 36px 56px; }
    h2 { font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: #ec4899; font-weight: 700; margin: 0 0 12px; }
    h2:not(:first-child) { margin-top: 26px; }
    p.summary { font-size: 13px; line-height: 1.6; color: #334155; margin: 0 0 4px; }
    .role { margin-bottom: 14px; padding-left: 14px; border-left: 3px solid #fce7f3; }
    .role .top { display: flex; justify-content: space-between; align-items: baseline; }
    .role .name { font-size: 14px; font-weight: 700; color: #0f172a; }
    .role .when { font-size: 11px; color: #94a3b8; }
    .role .org { font-size: 12px; color: #475569; margin-bottom: 4px; }
    ul { margin: 0; padding-left: 16px; font-size: 12px; }
    li { margin-bottom: 2px; }
    .skill-cloud span { display: inline-block; background: #fff7ed; color: #c2410c; border: 1px solid #fed7aa; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 500; margin: 0 4px 4px 0; }
    .lang { font-size: 12px; margin-bottom: 4px; }
    .lang b { display: block; color: #0f172a; }
    .lang i { color: #94a3b8; font-style: normal; font-size: 11px; }
    .edu { font-size: 12px; margin-bottom: 8px; }
    .edu .deg { font-weight: 600; color: #0f172a; }
    .edu .when { font-size: 11px; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="page">
    <div class="hero">
      <h1 class="name">{{ .person.name }}</h1>
      <div class="title">{{ .person.title }}</div>
      <div class="contact">
        <span>{{ .person.email }}</span>
        <span>{{ .person.phone }}</span>
        <span>{{ .person.location }}</span>
        {{ if .person.website }}<span>{{ .person.website }}</span>{{ end }}
      </div>
    </div>

    <div class="body">
      <main>
        <h2>About</h2>
        <p class="summary">{{ .summary }}</p>

        <h2>Experience</h2>
        {{ range .experience }}
        <div class="role">
          <div class="top">
            <span class="name">{{ .title }}</span>
            <span class="when">{{ .when }}</span>
          </div>
          <div class="org">{{ .company }} · {{ .location }}</div>
          <ul>
            {{ range .highlights }}<li>{{ . }}</li>{{ end }}
          </ul>
        </div>
        {{ end }}
      </main>

      <aside>
        <h2>Skills</h2>
        <div class="skill-cloud">
          {{ range .skills }}<span>{{ . }}</span>{{ end }}
        </div>

        <h2>Education</h2>
        {{ range .education }}
        <div class="edu">
          <div class="deg">{{ .degree }}</div>
          <div>{{ .school }}</div>
          <div class="when">{{ .when }}</div>
        </div>
        {{ end }}

        {{ if .languages }}
        <h2>Languages</h2>
        {{ range .languages }}
        <div class="lang"><b>{{ .name }}</b><i>{{ .level }}</i></div>
        {{ end }}
        {{ end }}
      </aside>
    </div>
  </div>
</body>
</html>
`,
  sampleData: RESUME_SAMPLE,
  formSchema: RESUME_SCHEMA,
};
