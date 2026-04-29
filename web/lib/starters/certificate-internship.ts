import type { Starter } from "./types";

export const certificateInternshipStarter: Starter = {
  id: "certificate-internship",
  name: "Internship completion certificate",
  description:
    "Formal India-style internship certificate — duration, role, conduct paragraph, and HR seal.",
  category: "Certificates",
  tags: ["certificate", "internship", "experience"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Internship Certificate — {{ .recipient.name }}</title>
  <style>
    @page { size: A4 portrait; margin: 0; }
    body { font-family: "Times New Roman", Times, serif; margin: 0; padding: 32px 36px; background: white; color: #111827; }
    .cert { border: 1px solid #1e3a8a; padding: 28px 36px; min-height: calc(100vh - 64px); box-sizing: border-box; position: relative; }
    .cert::before { content: ""; position: absolute; top: 6px; left: 6px; right: 6px; bottom: 6px; border: 1px solid #93c5fd; pointer-events: none; }
    .header { text-align: center; padding-bottom: 14px; border-bottom: 2px solid #1e3a8a; margin-bottom: 24px; }
    .org { font-size: 22px; font-weight: 700; color: #1e3a8a; letter-spacing: .02em; }
    .org-sub { font-size: 11px; color: #475569; margin-top: 2px; }
    .ref { display: flex; justify-content: space-between; font-size: 12px; color: #475569; margin-bottom: 18px; font-family: Arial, sans-serif; }
    h1 { text-align: center; font-size: 26px; letter-spacing: .12em; text-transform: uppercase; color: #1e3a8a; margin: 8px 0 22px; font-weight: 700; }
    h1::before, h1::after { content: "—"; color: #93c5fd; margin: 0 12px; font-weight: 400; }
    .body { font-size: 14px; line-height: 1.85; text-align: justify; }
    .body p { margin: 0 0 14px; }
    .body b { color: #1e3a8a; }
    .pill { display: inline-block; background: #eff6ff; color: #1e3a8a; padding: 1px 8px; border-radius: 4px; font-weight: 600; font-family: Arial, sans-serif; font-size: 13px; }
    .closing { margin-top: 22px; font-size: 14px; }
    .footer { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 60px; }
    .seal { width: 110px; height: 110px; border-radius: 50%; border: 2px dashed #1e3a8a; display: grid; place-items: center; text-align: center; font-size: 9px; letter-spacing: .15em; color: #1e3a8a; font-family: Arial, sans-serif; font-weight: 700; line-height: 1.4; padding: 8px; }
    .sig { text-align: right; font-size: 13px; }
    .sig .line { width: 200px; border-top: 1px solid #1e3a8a; margin: 30px 0 6px auto; }
    .sig b { display: block; color: #1e3a8a; }
  </style>
</head>
<body>
  <div class="cert">
    <div class="header">
      <div class="org">{{ .company.name }}</div>
      <div class="org-sub">{{ .company.address }}</div>
    </div>

    <div class="ref">
      <span>Ref: {{ .certId }}</span>
      <span>Date: {{ .issuedAt | formatDate "January 2, 2006" }}</span>
    </div>

    <h1>Internship Certificate</h1>

    <div class="body">
      <p>This is to certify that <b>{{ .recipient.name }}</b>{{ if .recipient.college }}, a student of {{ .recipient.college }}{{ end }}, has successfully completed an internship at <b>{{ .company.name }}</b> in the role of <span class="pill">{{ .role }}</span> from <b>{{ .startDate | formatDate "January 2, 2006" }}</b> to <b>{{ .endDate | formatDate "January 2, 2006" }}</b>.</p>

      <p>During the internship, {{ .recipient.pronoun }} worked closely with the {{ .department }} team on {{ .projects }}. {{ .recipient.pronounCap }} demonstrated strong technical aptitude, a willingness to learn, and the ability to deliver assigned tasks within the agreed timelines.</p>

      <p>We found {{ .recipient.pronoun }} to be sincere, hardworking, and a good team player. {{ .recipient.pronounCap }} conduct during the entire tenure of the internship has been exemplary.</p>

      <p>We wish {{ .recipient.pronoun }} the very best in all future endeavours.</p>
    </div>

    <div class="closing">For <b>{{ .company.name }}</b>,</div>

    <div class="footer">
      <div class="seal">COMPANY<br />SEAL<br />&amp; STAMP</div>
      <div class="sig">
        <div class="line"></div>
        <b>{{ .signatory.name }}</b>
        {{ .signatory.title }}<br />
        {{ .signatory.email }}
      </div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    company: {
      name: "Drive360 Technologies Pvt Ltd",
      address: "Embassy TechVillage, Outer Ring Road, Bengaluru — 560103",
    },
    certId: "INT/2026/00214",
    issuedAt: "2026-04-22",
    recipient: {
      name: "Aditya Sharma",
      college: "Indian Institute of Technology, Madras",
      pronoun: "he",
      pronounCap: "His",
    },
    role: "Software Engineering Intern",
    startDate: "2026-01-13",
    endDate: "2026-04-18",
    department: "Platform Engineering",
    projects:
      "the redesign of the internal feature-flag service, building a TypeScript SDK, and improving observability across our payment microservices",
    signatory: {
      name: "Reena Iyer",
      title: "Head of Talent",
      email: "reena.iyer@drive360.tech",
    },
  },
};
