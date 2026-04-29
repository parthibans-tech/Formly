import type { Starter } from "./types";

export const certificateEmployeeMonthStarter: Starter = {
  id: "certificate-employee-month",
  name: "Employee of the month",
  description:
    "Star-themed certificate to spotlight a standout team member — month, reasons, and CEO signature.",
  category: "Certificates",
  tags: ["certificate", "employee", "recognition"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Employee of the Month — {{ .recipient.name }}</title>
  <style>
    @page { size: A4 landscape; margin: 0; }
    body { font-family: "Inter", system-ui, sans-serif; margin: 0; padding: 24px; background: #fffbeb; color: #1f2937; }
    .cert { background: white; border-radius: 18px; padding: 48px 64px; height: 100%; box-sizing: border-box; position: relative; box-shadow: 0 0 0 2px #fcd34d inset; overflow: hidden; }
    .star { position: absolute; color: #fde68a; font-size: 24px; opacity: .8; }
    .star.s1 { top: 24px; right: 60px; font-size: 18px; }
    .star.s2 { top: 60px; right: 28px; font-size: 14px; }
    .star.s3 { bottom: 60px; left: 32px; font-size: 18px; }
    .star.s4 { bottom: 28px; left: 80px; font-size: 14px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 18px; }
    .brand { font-size: 13px; font-weight: 700; color: #b45309; letter-spacing: .14em; text-transform: uppercase; }
    .month-tag { background: #fef3c7; color: #92400e; font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; padding: 6px 14px; border-radius: 999px; }
    .center { text-align: center; }
    .eyebrow { font-size: 12px; letter-spacing: .35em; text-transform: uppercase; color: #b45309; font-weight: 600; margin-bottom: 4px; }
    h1 { font-size: 52px; margin: 0 0 6px; color: #78350f; font-weight: 900; letter-spacing: -.02em; }
    .of { font-size: 16px; color: #92400e; font-style: italic; margin-bottom: 24px; }
    .photo-frame { width: 110px; height: 110px; border-radius: 50%; background: linear-gradient(135deg, #f59e0b, #fbbf24); margin: 0 auto 14px; display: grid; place-items: center; color: white; font-size: 44px; font-weight: 800; box-shadow: 0 8px 24px rgba(245,158,11,.3); }
    .name { font-size: 44px; color: #78350f; font-weight: 800; letter-spacing: -.01em; margin: 0; }
    .role { font-size: 14px; color: #92400e; margin-top: 4px; margin-bottom: 22px; }
    .reasons { background: #fffbeb; border: 1px solid #fde68a; border-radius: 12px; padding: 18px 22px; max-width: 720px; margin: 0 auto 24px; }
    .reasons-title { font-size: 11px; letter-spacing: .2em; text-transform: uppercase; color: #b45309; font-weight: 700; text-align: center; margin-bottom: 10px; }
    .reasons ul { margin: 0; padding-left: 22px; columns: 2; column-gap: 28px; }
    .reasons li { font-size: 13px; color: #1f2937; line-height: 1.7; break-inside: avoid; }
    .footer { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 16px; }
    .sig { font-size: 12px; color: #6b7280; border-top: 2px solid #f59e0b; padding-top: 6px; min-width: 220px; }
    .sig b { display: block; color: #78350f; font-size: 14px; }
    .badge { width: 86px; height: 86px; border-radius: 50%; background: #fbbf24; color: white; display: grid; place-items: center; font-size: 38px; box-shadow: 0 0 0 4px white, 0 0 0 6px #f59e0b; }
  </style>
</head>
<body>
  <div class="cert">
    <span class="star s1">★</span>
    <span class="star s2">✦</span>
    <span class="star s3">✦</span>
    <span class="star s4">★</span>

    <div class="header">
      <div class="brand">{{ .organization }}</div>
      <div class="month-tag">{{ .month }} {{ .year }}</div>
    </div>

    <div class="center">
      <div class="eyebrow">Employee Recognition</div>
      <h1>Employee of the Month</h1>
      <div class="of">{{ .month }} · {{ .year }}</div>

      <div class="photo-frame">{{ .recipient.initial }}</div>
      <div class="name">{{ .recipient.name }}</div>
      <div class="role">{{ .recipient.role }} · {{ .recipient.department }}</div>

      <div class="reasons">
        <div class="reasons-title">For demonstrating</div>
        <ul>
          {{ range .reasons }}<li>{{ . }}</li>{{ end }}
        </ul>
      </div>
    </div>

    <div class="footer">
      <div class="sig">
        <b>{{ .nominator.name }}</b>
        {{ .nominator.title }}
      </div>
      <div class="badge">★</div>
      <div class="sig" style="text-align:right">
        <b>{{ .ceo.name }}</b>
        {{ .ceo.title }}
      </div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    organization: "Drive360 Inc.",
    month: "April",
    year: "2026",
    recipient: {
      name: "Sanjana Verma",
      initial: "S",
      role: "Senior Customer Success Manager",
      department: "Customer Experience",
    },
    reasons: [
      "Exceptional customer empathy",
      "Closed 3 escalations in 24 hours",
      "Mentored 4 new team members",
      "Highest CSAT score for the quarter",
      "Cross-functional initiative leadership",
      "Always brings her best, every day",
    ],
    nominator: {
      name: "Marcus Chen",
      title: "VP of Customer Success",
    },
    ceo: {
      name: "Alex Morgan",
      title: "Chief Executive Officer",
    },
  },
};
