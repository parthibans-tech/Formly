import type { Starter } from "./types";

export const certificateParticipationStarter: Starter = {
  id: "certificate-participation",
  name: "Certificate of participation",
  description:
    "Clean blue certificate for events, conferences, and workshops — confirms attendance and engagement.",
  category: "Certificates",
  tags: ["certificate", "participation", "attendance"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Certificate of Participation — {{ .recipient.name }}</title>
  <style>
    @page { size: A4 landscape; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; margin: 0; padding: 28px; background: #f0f9ff; color: #0f172a; }
    .cert { background: white; border-radius: 12px; box-shadow: 0 2px 0 #bae6fd inset; padding: 56px 72px; height: 100%; box-sizing: border-box; position: relative; overflow: hidden; }
    .cert::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 12px; background: linear-gradient(90deg, #2563eb 0%, #06b6d4 50%, #2563eb 100%); }
    .top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; }
    .top .brand { font-size: 13px; font-weight: 700; color: #2563eb; letter-spacing: .12em; text-transform: uppercase; }
    .top .meta { font-size: 11px; color: #64748b; text-align: right; }
    .eyebrow { letter-spacing: .3em; text-transform: uppercase; font-size: 12px; color: #0284c7; text-align: center; margin-bottom: 4px; font-weight: 600; }
    h1 { font-size: 44px; text-align: center; letter-spacing: -.01em; margin: 4px 0 26px; color: #0c4a6e; font-weight: 800; }
    .presented { text-align: center; font-size: 14px; color: #475569; }
    .name { text-align: center; font-size: 50px; color: #0c4a6e; margin: 6px 0 6px; font-weight: 700; letter-spacing: -.01em; }
    .role { text-align: center; font-size: 13px; color: #64748b; margin-bottom: 28px; }
    .description { text-align: center; font-size: 15px; max-width: 740px; margin: 0 auto 36px; color: #334155; line-height: 1.7; }
    .event { color: #0c4a6e; font-weight: 600; }
    .footer { display: grid; grid-template-columns: 1fr auto 1fr; align-items: end; gap: 32px; margin-top: 36px; }
    .sig { font-size: 12px; color: #475569; border-top: 2px solid #0c4a6e; padding-top: 6px; }
    .sig b { display: block; font-size: 14px; color: #0c4a6e; }
    .seal { width: 84px; height: 84px; border-radius: 50%; background: #2563eb; color: white; display: grid; place-items: center; font-size: 9px; letter-spacing: .15em; font-weight: 700; text-align: center; line-height: 1.3; padding: 8px; }
  </style>
</head>
<body>
  <div class="cert">
    <div class="top">
      <div class="brand">{{ .organization }}</div>
      <div class="meta">
        Certificate ID: {{ .certId }}<br />
        Issued: {{ .issuedAt | formatDate "January 2, 2006" }}
      </div>
    </div>

    <div class="eyebrow">Certificate</div>
    <h1>of Participation</h1>

    <div class="presented">This is to certify that</div>
    <div class="name">{{ .recipient.name }}</div>
    {{ if .recipient.role }}<div class="role">{{ .recipient.role }}</div>{{ end }}

    <div class="description">
      has actively participated in <span class="event">{{ .event.name }}</span>
      held on {{ .event.date | formatDate "Monday, January 2, 2006" }}
      at {{ .event.location }}, comprising
      {{ .event.hours }} hours of {{ .event.format }}.
    </div>

    <div class="footer">
      <div class="sig">
        <b>{{ .organizer.name }}</b>
        {{ .organizer.title }} · {{ .organization }}
      </div>
      <div class="seal">PARTICIPATION<br />CERTIFIED</div>
      <div class="sig" style="text-align:right">
        <b>{{ .partner.name }}</b>
        {{ .partner.title }} · {{ .partner.organization }}
      </div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    organization: "Drive360 Tech Conference",
    certId: "PART-2026-1247",
    issuedAt: "2026-04-22",
    recipient: {
      name: "Priya Ramesh",
      role: "Senior Software Engineer, Lumen Labs",
    },
    event: {
      name: "AI for Engineers Summit 2026",
      date: "2026-04-20",
      location: "Bengaluru International Centre",
      hours: 16,
      format: "talks, workshops, and panel discussions",
    },
    organizer: {
      name: "Alex Morgan",
      title: "Conference Chair",
    },
    partner: {
      name: "Reena Patel",
      title: "Programme Director",
      organization: "Tech Bengaluru",
    },
  },
};
