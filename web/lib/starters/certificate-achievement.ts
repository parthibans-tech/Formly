import type { Starter } from "./types";

export const certificateAchievementStarter: Starter = {
  id: "certificate-achievement",
  name: "Certificate of achievement",
  description:
    "Bold dark certificate for milestones, top performers, and achievement awards — gold accent, modern serif.",
  category: "Certificates",
  tags: ["certificate", "achievement", "award"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Certificate of Achievement — {{ .recipient.name }}</title>
  <style>
    @page { size: A4 landscape; margin: 0; }
    body { font-family: "Playfair Display", Georgia, serif; margin: 0; padding: 32px; background: #0f172a; color: #f8fafc; }
    .cert { background: #0f172a; border: 2px solid #fbbf24; padding: 48px 64px; height: 100%; box-sizing: border-box; position: relative; }
    .cert::before, .cert::after { content: ""; position: absolute; width: 48px; height: 48px; border: 2px solid #fbbf24; }
    .cert::before { top: 16px; left: 16px; border-right: none; border-bottom: none; }
    .cert::after { bottom: 16px; right: 16px; border-left: none; border-top: none; }
    .eyebrow { letter-spacing: .35em; text-transform: uppercase; font-size: 11px; color: #fbbf24; text-align: center; margin-bottom: 8px; }
    h1 { font-size: 52px; text-align: center; letter-spacing: .04em; margin: 4px 0 6px; color: #fef3c7; font-weight: 700; }
    .sub { text-align: center; font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: #cbd5e1; margin-bottom: 32px; }
    .presented { text-align: center; font-size: 14px; color: #94a3b8; font-style: italic; }
    .name { text-align: center; font-family: "Playfair Display", Georgia, serif; font-size: 64px; color: #fbbf24; margin: 14px 0 18px; font-weight: 600; }
    .divider { width: 80px; height: 2px; background: #fbbf24; margin: 0 auto 18px; }
    .description { text-align: center; font-size: 16px; max-width: 720px; margin: 0 auto 36px; color: #e2e8f0; line-height: 1.7; }
    .achievement { color: #fef3c7; font-weight: 600; }
    .footer { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 48px; }
    .sig { text-align: center; border-top: 1px solid #fbbf24; padding-top: 6px; min-width: 200px; font-size: 12px; color: #cbd5e1; }
    .sig b { display: block; color: #fef3c7; font-size: 14px; font-weight: 600; }
    .badge { width: 100px; height: 100px; border-radius: 50%; border: 3px solid #fbbf24; display: grid; place-items: center; color: #fbbf24; font-size: 26px; background: rgba(251,191,36,.08); }
  </style>
</head>
<body>
  <div class="cert">
    <div class="eyebrow">{{ .organization }}</div>
    <h1>Certificate of Achievement</h1>
    <div class="sub">In recognition of outstanding performance</div>

    <div class="presented">This certificate is proudly presented to</div>
    <div class="name">{{ .recipient.name }}</div>
    <div class="divider"></div>

    <div class="description">
      In recognition of <span class="achievement">{{ .achievement }}</span>.
      {{ .description }}
    </div>

    <div class="footer">
      <div class="sig">
        <b>{{ .signatory.name }}</b>
        {{ .signatory.title }}
      </div>
      <div class="badge">★</div>
      <div class="sig">
        <b>{{ .awardedAt | formatDate "January 2, 2006" }}</b>
        Cert. ID: {{ .certId }}
      </div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    organization: "Drive360 Achievement Awards",
    recipient: { name: "Priya Ramesh" },
    achievement: "exceeding annual sales targets by 142%",
    description:
      "Awarded for sustained excellence, innovative thinking, and an enduring commitment to customer success throughout fiscal year 2025–26.",
    awardedAt: "2026-04-22",
    certId: "ACH-2026-0418",
    signatory: {
      name: "Alex Morgan",
      title: "Chief Executive Officer",
    },
  },
};
