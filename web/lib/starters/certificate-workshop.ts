import type { Starter } from "./types";

export const certificateWorkshopStarter: Starter = {
  id: "certificate-workshop",
  name: "Workshop attendance certificate",
  description:
    "Modern minimal certificate for hands-on workshops, bootcamps, and short courses — speaker, hours, and topics.",
  category: "Certificates",
  tags: ["certificate", "workshop", "bootcamp"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Workshop Certificate — {{ .recipient.name }}</title>
  <style>
    @page { size: A4 landscape; margin: 0; }
    body { font-family: "Inter", system-ui, sans-serif; margin: 0; padding: 0; background: #f8fafc; color: #0f172a; }
    .cert { background: white; padding: 48px 64px; height: 100%; box-sizing: border-box; position: relative; border-left: 6px solid #0f172a; }
    .grid-bg { position: absolute; inset: 0; background-image: linear-gradient(#e2e8f0 1px, transparent 1px), linear-gradient(90deg, #e2e8f0 1px, transparent 1px); background-size: 28px 28px; opacity: .4; pointer-events: none; }
    .content { position: relative; height: 100%; display: flex; flex-direction: column; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; }
    .brand { display: flex; align-items: center; gap: 10px; }
    .brand .dot { width: 12px; height: 12px; background: #0f172a; border-radius: 50%; }
    .brand .name { font-size: 14px; font-weight: 700; color: #0f172a; letter-spacing: -.01em; }
    .meta { font-size: 11px; color: #64748b; text-align: right; line-height: 1.6; }
    .meta b { color: #0f172a; }
    .eyebrow { font-size: 11px; letter-spacing: .3em; text-transform: uppercase; color: #64748b; font-weight: 600; margin-bottom: 6px; }
    h1 { font-size: 56px; margin: 0 0 14px; color: #0f172a; font-weight: 800; letter-spacing: -.03em; line-height: 1; }
    .workshop-name { font-size: 22px; color: #475569; margin-bottom: 28px; max-width: 720px; }
    .row { display: grid; grid-template-columns: 2fr 1fr; gap: 36px; align-items: start; flex: 1; }
    .left .label { font-size: 11px; letter-spacing: .25em; text-transform: uppercase; color: #94a3b8; font-weight: 600; }
    .name { font-size: 44px; color: #0f172a; margin: 4px 0 22px; font-weight: 800; letter-spacing: -.02em; }
    .topics { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .topic { font-size: 11px; padding: 4px 10px; background: #f1f5f9; color: #0f172a; border-radius: 999px; font-weight: 500; }
    .right { background: #0f172a; color: white; padding: 22px; border-radius: 12px; }
    .right .stat { display: flex; justify-content: space-between; align-items: baseline; padding: 10px 0; border-bottom: 1px solid #1e293b; }
    .right .stat:last-child { border-bottom: none; }
    .right .k { font-size: 11px; color: #94a3b8; letter-spacing: .1em; text-transform: uppercase; }
    .right .v { font-size: 16px; font-weight: 700; }
    .footer { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 22px; padding-top: 16px; border-top: 1px solid #e2e8f0; }
    .sig { font-size: 12px; color: #64748b; }
    .sig b { display: block; color: #0f172a; font-size: 14px; font-weight: 700; }
    .qr { width: 64px; height: 64px; background: #0f172a; color: white; display: grid; place-items: center; font-size: 9px; letter-spacing: .1em; text-align: center; border-radius: 8px; padding: 4px; line-height: 1.2; }
  </style>
</head>
<body>
  <div class="cert">
    <div class="grid-bg"></div>
    <div class="content">
      <div class="header">
        <div class="brand">
          <div class="dot"></div>
          <div class="name">{{ .organization }}</div>
        </div>
        <div class="meta">
          Cert ID: <b>{{ .certId }}</b><br />
          {{ .date | formatDate "January 2, 2006" }}
        </div>
      </div>

      <div class="eyebrow">Certificate of Attendance</div>
      <h1>Workshop attended</h1>
      <div class="workshop-name">{{ .workshop.name }}</div>

      <div class="row">
        <div class="left">
          <div class="label">Awarded to</div>
          <div class="name">{{ .recipient.name }}</div>
          <div class="label">Topics covered</div>
          <div class="topics">
            {{ range .workshop.topics }}<span class="topic">{{ . }}</span>{{ end }}
          </div>
        </div>
        <div class="right">
          <div class="stat"><span class="k">Duration</span><span class="v">{{ .workshop.duration }}</span></div>
          <div class="stat"><span class="k">Format</span><span class="v">{{ .workshop.format }}</span></div>
          <div class="stat"><span class="k">Speaker</span><span class="v">{{ .workshop.speaker }}</span></div>
          <div class="stat"><span class="k">Venue</span><span class="v">{{ .workshop.venue }}</span></div>
        </div>
      </div>

      <div class="footer">
        <div class="sig">
          <b>{{ .signatory.name }}</b>
          {{ .signatory.title }} · {{ .organization }}
        </div>
        <div class="qr">VERIFY<br />ONLINE</div>
      </div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    organization: "Drive360 Studio",
    certId: "WS-2026-0731",
    date: "2026-04-22",
    workshop: {
      name: "Design Systems at Scale: From Tokens to Production",
      duration: "8 hours",
      format: "In-person",
      speaker: "Hana Yoshida",
      venue: "Drive360 HQ, Bengaluru",
      topics: [
        "Design tokens",
        "Component APIs",
        "Theming",
        "Accessibility",
        "Versioning",
        "Documentation",
        "Adoption playbooks",
      ],
    },
    recipient: { name: "Priya Ramesh" },
    signatory: {
      name: "Alex Morgan",
      title: "Programme Lead",
    },
  },
};
