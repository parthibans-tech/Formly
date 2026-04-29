import type { Starter } from "./types";

export const certificateAwardStarter: Starter = {
  id: "certificate-award",
  name: "Award certificate",
  description:
    "Modern bold award certificate for competitions, hackathons, and contests — placement, prize, and category.",
  category: "Certificates",
  tags: ["certificate", "award", "competition"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .placement }} — {{ .recipient.name }}</title>
  <style>
    @page { size: A4 landscape; margin: 0; }
    body { font-family: "Inter", system-ui, sans-serif; margin: 0; padding: 0; background: #faf5ff; color: #1e1b4b; }
    .cert { padding: 40px 56px; height: 100%; box-sizing: border-box; position: relative; background: white; }
    .stripe-l, .stripe-r { position: absolute; top: 0; bottom: 0; width: 16px; }
    .stripe-l { left: 0; background: linear-gradient(180deg, #7c3aed, #ec4899); }
    .stripe-r { right: 0; background: linear-gradient(180deg, #ec4899, #7c3aed); }
    .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding-left: 16px; padding-right: 16px; }
    .brand { font-size: 12px; font-weight: 700; color: #7c3aed; letter-spacing: .18em; text-transform: uppercase; }
    .event-tag { font-size: 11px; color: #6b21a8; background: #f3e8ff; padding: 4px 10px; border-radius: 999px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
    .hero { text-align: center; padding: 8px 16px 0; }
    .placement { display: inline-block; font-size: 14px; letter-spacing: .35em; text-transform: uppercase; color: #7c3aed; font-weight: 700; margin-bottom: 4px; }
    h1 { font-size: 80px; margin: 0; line-height: 1; color: #1e1b4b; font-weight: 900; letter-spacing: -.04em; background: linear-gradient(135deg, #7c3aed 0%, #ec4899 100%); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
    .subtitle { font-size: 16px; color: #475569; margin: 14px 0 26px; }
    .winner-block { background: linear-gradient(135deg, #faf5ff 0%, #fdf4ff 100%); border: 1px solid #e9d5ff; border-radius: 14px; padding: 22px 28px; max-width: 760px; margin: 0 auto 26px; text-align: center; }
    .winner-label { font-size: 11px; letter-spacing: .25em; text-transform: uppercase; color: #7c3aed; font-weight: 600; margin-bottom: 4px; }
    .name { font-size: 48px; color: #1e1b4b; font-weight: 800; letter-spacing: -.02em; margin: 0; }
    .team { font-size: 13px; color: #6b21a8; margin-top: 4px; }
    .details { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; max-width: 760px; margin: 0 auto 24px; padding: 0 16px; }
    .detail { text-align: center; }
    .detail .k { font-size: 10px; letter-spacing: .15em; text-transform: uppercase; color: #94a3b8; }
    .detail .v { font-size: 16px; font-weight: 700; color: #1e1b4b; margin-top: 2px; }
    .footer { display: flex; justify-content: space-between; align-items: flex-end; padding: 0 16px; margin-top: 18px; }
    .sig { font-size: 12px; color: #64748b; border-top: 2px solid #7c3aed; padding-top: 6px; min-width: 220px; }
    .sig b { display: block; color: #1e1b4b; font-size: 14px; }
    .trophy { font-size: 56px; line-height: 1; }
  </style>
</head>
<body>
  <div class="cert">
    <div class="stripe-l"></div>
    <div class="stripe-r"></div>
    <div class="top">
      <div class="brand">{{ .organization }}</div>
      <div class="event-tag">{{ .event }} · {{ .year }}</div>
    </div>
    <div class="hero">
      <div class="placement">{{ .placement }}</div>
      <h1>{{ .placementBig }}</h1>
      <div class="subtitle">in the category of <b>{{ .category }}</b></div>

      <div class="trophy">🏆</div>

      <div class="winner-block">
        <div class="winner-label">Awarded to</div>
        <div class="name">{{ .recipient.name }}</div>
        {{ if .recipient.team }}<div class="team">Team {{ .recipient.team }}</div>{{ end }}
      </div>

      <div class="details">
        <div class="detail"><div class="k">Prize</div><div class="v">{{ .prize }}</div></div>
        <div class="detail"><div class="k">Date</div><div class="v">{{ .date | formatDate "Jan 2, 2006" }}</div></div>
        <div class="detail"><div class="k">Cert ID</div><div class="v">{{ .certId }}</div></div>
      </div>
    </div>

    <div class="footer">
      <div class="sig">
        <b>{{ .judge.name }}</b>
        {{ .judge.title }}
      </div>
      <div class="sig" style="text-align:right">
        <b>{{ .organizer.name }}</b>
        {{ .organizer.title }}
      </div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    organization: "Drive360 Hackathon",
    event: "Build the Future",
    year: "2026",
    placement: "Winner",
    placementBig: "1st Place",
    category: "AI & Productivity",
    recipient: {
      name: "Priya Ramesh",
      team: "Lumen Labs",
    },
    prize: "₹5,00,000",
    date: "2026-04-20",
    certId: "AWD-2026-1ST",
    judge: {
      name: "Dr. Karan Mehta",
      title: "Head Judge",
    },
    organizer: {
      name: "Alex Morgan",
      title: "Hackathon Director",
    },
  },
};
