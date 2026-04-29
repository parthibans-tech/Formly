import type { Starter } from "./types";

export const pressReleaseStarter: Starter = {
  id: "press-release",
  name: "Press release",
  description:
    "Standard press release with headline, dateline, body, boilerplate, and media contact.",
  category: "Marketing",
  tags: ["press", "release", "pr", "announcement"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .headline }}</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: "Helvetica Neue", Arial, sans-serif; color: #111; padding: 56px 72px; max-width: 780px; margin: auto; line-height: 1.6; }
    .top { display: flex; justify-content: space-between; align-items: center; padding-bottom: 18px; border-bottom: 3px solid #111; }
    .brand { font-weight: 800; letter-spacing: -.01em; font-size: 18px; }
    .label { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #b91c1c; font-weight: 700; }
    h1 { font-size: 26px; line-height: 1.25; letter-spacing: -.01em; margin: 28px 0 6px; }
    .subhead { color: #4b5563; font-size: 15px; margin-bottom: 22px; }
    .dateline { font-size: 14px; margin-bottom: 14px; }
    .dateline b { font-weight: 700; }
    p { margin: 0 0 12px; font-size: 14px; }
    .quote { border-left: 3px solid #111; margin: 22px 0; padding: 4px 0 4px 16px; font-style: italic; font-size: 14px; color: #1f2937; }
    .quote .who { font-style: normal; font-size: 12px; color: #6b7280; margin-top: 6px; }
    .end { text-align: center; letter-spacing: .3em; font-weight: 700; margin: 28px 0 22px; }
    .boilerplate { font-size: 12px; color: #4b5563; padding-top: 18px; border-top: 1px solid #e5e7eb; }
    .contact { margin-top: 14px; font-size: 12px; color: #4b5563; }
    .contact b { color: #111; display: block; }
  </style>
</head>
<body>
  <div class="top">
    <div class="brand">{{ .organization.name }}</div>
    <div class="label">For Immediate Release</div>
  </div>

  <h1>{{ .headline }}</h1>
  <div class="subhead">{{ .subhead }}</div>

  <div class="dateline"><b>{{ .dateline.location }}</b> — {{ .dateline.date | formatDate "January 2, 2006" }} —</div>

  {{ range .body }}
  <p>{{ . }}</p>
  {{ end }}

  {{ range .quotes }}
  <div class="quote">
    "{{ .text }}"
    <div class="who">— {{ .name }}, {{ .title }}</div>
  </div>
  {{ end }}

  <div class="end">### END ###</div>

  <div class="boilerplate">
    <b style="color: #111; font-weight: 700;">About {{ .organization.name }}</b><br />
    {{ .organization.about }}
  </div>

  <div class="contact">
    <b>Media contact</b>
    {{ .contact.name }}, {{ .contact.title }}<br />
    {{ .contact.email }} · {{ .contact.phone }}
  </div>
</body>
</html>
`,
  sampleData: {
    organization: {
      name: "Lumen Health",
      about:
        "Lumen Health is a digital-first primary care provider serving 90,000 members across 14 states. Founded in 2019, the company combines virtual-first care with neighborhood clinics to make modern medicine more accessible.",
    },
    headline: "Lumen Health Closes $48M Series B to Expand Hybrid Primary Care to 25 New Markets",
    subhead:
      "Funding led by Catalyst Ventures will fuel clinic openings, hire 200 clinicians, and accelerate the company's care-coordination platform.",
    dateline: { location: "SAN FRANCISCO, CA", date: "2026-04-29" },
    body: [
      "Lumen Health, the hybrid primary care company that pairs virtual-first medicine with neighborhood clinics, today announced the close of a $48 million Series B funding round led by Catalyst Ventures, with participation from existing investors Northstar Capital and Wellspring Partners.",
      "The capital will be used to open 25 new clinics across the Southeast and Midwest, hire 200 clinicians and care coordinators, and continue investment in the company's care-coordination platform — which has been credited with reducing avoidable ER visits by 38% across its member base.",
      "Lumen now serves 90,000 members and partners with five regional health plans. Membership grew 142% in 2025, and the company expects to reach 250,000 members by the end of 2027.",
    ],
    quotes: [
      {
        text:
          "We've spent the last three years proving that hybrid primary care works — for patients, for clinicians, and for the systems that pay for care. This round lets us bring that model to many more communities.",
        name: "Dr. Priya Anand",
        title: "Co-Founder & CEO, Lumen Health",
      },
      {
        text:
          "Lumen's care model is the rare combination of clinically rigorous and operationally elegant. We're thrilled to back the team in this next chapter.",
        name: "Marcus Lee",
        title: "Partner, Catalyst Ventures",
      },
    ],
    contact: {
      name: "Sara Whitman",
      title: "Director of Communications",
      email: "press@lumenhealth.example",
      phone: "+1 (415) 555-0182",
    },
  },
};
