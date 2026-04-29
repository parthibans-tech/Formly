import type { Starter } from "./types";

export const coverLetterStarter: Starter = {
  id: "cover-letter",
  name: "Cover letter",
  description:
    "Modern cover letter with applicant header, hiring manager block, and three-paragraph body.",
  category: "Correspondence",
  tags: ["cover", "letter", "job"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Cover letter — {{ .applicant.name }}</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #1f2937; padding: 60px 72px; max-width: 760px; margin: auto; line-height: 1.6; }
    .head { border-bottom: 2px solid #1f2937; padding-bottom: 14px; margin-bottom: 28px; display: flex; justify-content: space-between; align-items: flex-end; }
    .head h1 { margin: 0; font-size: 26px; letter-spacing: -.01em; }
    .head .role { font-size: 13px; color: #6b7280; margin-top: 2px; }
    .head .contact { text-align: right; font-size: 12px; color: #4b5563; }
    .head .contact div { margin-top: 2px; }
    .meta { font-size: 13px; color: #6b7280; margin-bottom: 14px; }
    .recipient { font-size: 14px; margin-bottom: 22px; }
    .recipient b { display: block; font-weight: 600; color: #111827; }
    .salutation { font-size: 15px; margin-bottom: 12px; }
    p { margin: 0 0 14px; font-size: 14px; }
    .closing { margin-top: 24px; }
    .signature { margin-top: 36px; }
    .signature b { display: block; font-weight: 600; color: #111827; font-size: 14px; }
  </style>
</head>
<body>
  <div class="head">
    <div>
      <h1>{{ .applicant.name }}</h1>
      <div class="role">{{ .applicant.role }}</div>
    </div>
    <div class="contact">
      <div>{{ .applicant.email }}</div>
      <div>{{ .applicant.phone }}</div>
      <div>{{ .applicant.location }}</div>
    </div>
  </div>

  <div class="meta">{{ .sentAt | formatDate "January 2, 2006" }}</div>

  <div class="recipient">
    <b>{{ .recipient.name }}</b>
    {{ .recipient.title }}<br />
    {{ .recipient.company }}
  </div>

  <div class="salutation">Dear {{ .recipient.salutation }},</div>

  <p>{{ .body.opening }}</p>
  <p>{{ .body.middle }}</p>
  <p>{{ .body.closing }}</p>

  <div class="closing">Sincerely,</div>

  <div class="signature">
    <b>{{ .applicant.name }}</b>
  </div>
</body>
</html>
`,
  sampleData: {
    applicant: {
      name: "Avery Johnson",
      role: "Senior Product Designer",
      email: "avery.johnson@example.com",
      phone: "+1 (415) 555-0177",
      location: "San Francisco, CA",
    },
    sentAt: "2026-04-22",
    recipient: {
      name: "Priya Anand",
      salutation: "Ms. Anand",
      title: "VP of Product, Lumen Health",
      company: "Lumen Health, Inc.",
    },
    body: {
      opening:
        "I'm writing to apply for the Senior Product Designer role on the Lumen Health Care Coordination team. The mission of making hybrid primary care feel as easy as messaging a friend resonates with the work I've spent the last six years on at three different healthcare startups, and I'd be excited to bring that experience to your next chapter.",
      middle:
        "At Mosaic Care, I led the redesign of the patient mobile app — shipping a new appointment-booking flow that lifted weekly active use by 41% and cut support tickets in half. Before that, at OpenWell, I built a clinician-facing scheduling tool from zero to production and partnered closely with the engineering team on a component library still in use today. I'm comfortable owning end-to-end design, mentoring less experienced designers, and partnering with PM and eng on hard ambiguity.",
      closing:
        "I'd love the chance to talk about how I could help Lumen scale its patient experience as it expands. My portfolio is at avery.design, and I'm available for a call any afternoon next week.",
    },
  },
};
