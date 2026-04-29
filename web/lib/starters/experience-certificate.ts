import type { Starter } from "./types";

export const experienceCertificateStarter: Starter = {
  id: "experience-certificate",
  name: "Experience certificate",
  description:
    "Service letter / experience certificate confirming an employee's tenure, role, and good standing.",
  category: "HR",
  tags: ["experience", "service-letter", "certificate"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Experience Certificate — {{ .employee.name }}</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #111; padding: 56px 72px; max-width: 760px; margin: auto; line-height: 1.7; font-size: 13px; }
    .head { display: flex; justify-content: space-between; align-items: flex-end; padding-bottom: 14px; border-bottom: 3px double #0f172a; }
    .head .brand { font-weight: 700; font-size: 20px; }
    .head .muted { color: #555; font-size: 12px; }
    .ref { text-align: right; font-size: 11.5px; color: #555; margin-top: 8px; }
    h1 { text-align: center; font-size: 22px; margin: 28px 0 6px; letter-spacing: .12em; text-transform: uppercase; color: #0f172a; }
    .stamp { text-align: center; font-size: 11px; color: #64748b; margin-bottom: 22px; letter-spacing: .12em; text-transform: uppercase; }
    p { text-align: justify; margin: 0 0 12px; }
    .seal { margin-top: 56px; display: flex; justify-content: space-between; align-items: flex-end; }
    .seal .line { border-top: 1px solid #111; padding-top: 6px; font-size: 12px; min-width: 220px; }
    .seal .muted { color: #64748b; font-size: 11px; }
    .seal .stamp-circle { width: 110px; height: 110px; border: 1.5px dashed #94a3b8; border-radius: 50%; display: grid; place-items: center; color: #94a3b8; font-size: 10px; text-align: center; padding: 10px; }
  </style>
</head>
<body>
  <div class="head">
    <div>
      <div class="brand">{{ .company.name }}</div>
      <div class="muted">{{ .company.address }}</div>
    </div>
    <div class="ref">
      Ref: {{ .ref }}<br />
      {{ .letterDate | formatDate "January 2, 2006" }}
    </div>
  </div>

  <h1>Experience Certificate</h1>
  <div class="stamp">To whomsoever it may concern</div>

  <p>
    This is to certify that <b>{{ .employee.name }}</b>
    {{ if .employee.fatherName }}(s/o {{ .employee.fatherName }}){{ end }} was employed with
    {{ .company.name }} as <b>{{ .employee.title }}</b> in the
    {{ .employee.department }} department from
    <b>{{ .employee.start | formatDate "January 2, 2006" }}</b> to
    <b>{{ .employee.end | formatDate "January 2, 2006" }}</b>, a tenure of
    <b>{{ .tenure }}</b>.
  </p>

  <p>
    During {{ .pronoun }} tenure, {{ .pronoun }} was responsible for {{ .responsibilities }}.
    {{ .pronoun_capitalized }} demonstrated {{ .strengths }}, and was a positive contributor to
    the team and the organization.
  </p>

  <p>
    {{ .employee.firstName }} has been relieved from {{ .pronoun }} duties on
    {{ .employee.end | formatDate "January 2, 2006" }} and has handed over all responsibilities
    and Company property in good order. There are no dues outstanding to or from the Company as
    of the date of this letter.
  </p>

  <p>
    We thank {{ .employee.firstName }} for {{ .pronoun }} contributions and wish {{ .pronoun }}
    every success in {{ .pronoun }} future endeavours.
  </p>

  <div class="seal">
    <div>
      <div class="line">
        {{ .signatory.name }}
        <div class="muted">{{ .signatory.title }} · {{ .company.name }}</div>
      </div>
    </div>
    <div class="stamp-circle">Authorised<br />company seal</div>
  </div>
</body>
</html>
`,
  sampleData: {
    ref: "LL/HR/2026/EXP/0231",
    letterDate: "2026-04-30",
    tenure: "3 years and 4 months",
    pronoun: "her",
    pronoun_capitalized: "She",
    responsibilities:
      "leading frontend architecture for the analytics product, mentoring engineers, and collaborating across product and design",
    strengths:
      "strong technical judgement, clear written communication, and a collaborative working style",
    company: {
      name: "Lumen Labs Private Limited",
      address: "Tower B, Prestige Tech Park, Bengaluru 560103",
    },
    employee: {
      name: "Priya Ramesh",
      firstName: "Priya",
      fatherName: "Mr. Ramesh K.",
      title: "Senior Software Engineer",
      department: "Engineering",
      start: "2023-01-09",
      end: "2026-04-30",
    },
    signatory: {
      name: "Reena Patel",
      title: "Head of People",
    },
  },
};
