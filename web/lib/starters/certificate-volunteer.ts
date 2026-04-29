import type { Starter } from "./types";

export const certificateVolunteerStarter: Starter = {
  id: "certificate-volunteer",
  name: "Volunteer service certificate",
  description:
    "Warm green certificate recognising volunteer hours and community impact — perfect for NGOs and CSR programmes.",
  category: "Certificates",
  tags: ["certificate", "volunteer", "service"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Volunteer Certificate — {{ .recipient.name }}</title>
  <style>
    @page { size: A4 landscape; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; margin: 0; padding: 28px; background: #f0fdf4; color: #14532d; }
    .cert { background: white; border-radius: 14px; padding: 52px 68px; height: 100%; box-sizing: border-box; position: relative; overflow: hidden; box-shadow: 0 0 0 1px #bbf7d0 inset; }
    .leaf-l, .leaf-r { position: absolute; font-size: 80px; color: #86efac; opacity: .35; line-height: 1; }
    .leaf-l { top: 12px; left: 12px; transform: rotate(-20deg); }
    .leaf-r { bottom: 12px; right: 12px; transform: rotate(160deg); }
    .header { text-align: center; }
    .org-row { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 6px; }
    .logo { width: 32px; height: 32px; border-radius: 50%; background: #16a34a; color: white; display: grid; place-items: center; font-size: 16px; font-weight: 800; }
    .org { font-size: 14px; font-weight: 700; color: #166534; letter-spacing: .14em; text-transform: uppercase; }
    .eyebrow { font-size: 11px; letter-spacing: .35em; text-transform: uppercase; color: #16a34a; font-weight: 600; margin: 16px 0 4px; }
    h1 { font-size: 44px; margin: 0 0 8px; color: #14532d; font-weight: 800; letter-spacing: -.01em; }
    .sub { font-size: 14px; color: #16a34a; font-style: italic; margin-bottom: 24px; }
    .presented { font-size: 14px; color: #475569; }
    .name { font-size: 50px; color: #14532d; margin: 6px 0 4px; font-weight: 700; letter-spacing: -.01em; }
    .impact-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; max-width: 720px; margin: 22px auto; padding: 16px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; }
    .impact { text-align: center; }
    .impact .v { font-size: 26px; font-weight: 800; color: #15803d; }
    .impact .k { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: #4b5563; margin-top: 2px; }
    .description { text-align: center; font-size: 14px; max-width: 740px; margin: 0 auto 28px; color: #334155; line-height: 1.75; }
    .cause { color: #15803d; font-weight: 600; }
    .footer { display: flex; justify-content: space-between; align-items: flex-end; gap: 32px; margin-top: 14px; }
    .sig { font-size: 12px; color: #4b5563; border-top: 2px solid #16a34a; padding-top: 6px; flex: 1; }
    .sig b { display: block; color: #14532d; font-size: 14px; }
    .seal { width: 84px; height: 84px; border-radius: 50%; background: linear-gradient(135deg, #16a34a, #15803d); color: white; display: grid; place-items: center; font-size: 9px; letter-spacing: .12em; font-weight: 700; text-align: center; line-height: 1.3; padding: 6px; }
  </style>
</head>
<body>
  <div class="cert">
    <span class="leaf-l">❀</span>
    <span class="leaf-r">❀</span>
    <div class="header">
      <div class="org-row">
        <div class="logo">♥</div>
        <div class="org">{{ .organization }}</div>
      </div>
      <div class="eyebrow">Certificate of Volunteer Service</div>
      <h1>In Grateful Recognition</h1>
      <div class="sub">For making the world a little better</div>
    </div>

    <div style="text-align:center">
      <div class="presented">Awarded to</div>
      <div class="name">{{ .recipient.name }}</div>
    </div>

    <div class="impact-row">
      <div class="impact"><div class="v">{{ .impact.hours }}</div><div class="k">Hours of service</div></div>
      <div class="impact"><div class="v">{{ .impact.events }}</div><div class="k">Events attended</div></div>
      <div class="impact"><div class="v">{{ .impact.peopleHelped }}</div><div class="k">People impacted</div></div>
    </div>

    <div class="description">
      For dedicated and selfless service in support of <span class="cause">{{ .cause }}</span>
      from {{ .startDate | formatDate "January 2006" }} through {{ .endDate | formatDate "January 2006" }}.
      {{ .message }}
    </div>

    <div class="footer">
      <div class="sig">
        <b>{{ .coordinator.name }}</b>
        {{ .coordinator.title }}
      </div>
      <div class="seal">VOLUNTEER<br />HONOUR</div>
      <div class="sig" style="text-align:right">
        <b>{{ .director.name }}</b>
        {{ .director.title }}
      </div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    organization: "Drive360 Foundation",
    recipient: { name: "Tara Williams" },
    impact: {
      hours: 124,
      events: 18,
      peopleHelped: 540,
    },
    cause: "child literacy and after-school education in underserved communities",
    startDate: "2025-08-01",
    endDate: "2026-04-30",
    message:
      "Your generosity of time and spirit has touched many lives. We are profoundly grateful.",
    coordinator: {
      name: "Maya Iyer",
      title: "Volunteer Coordinator",
    },
    director: {
      name: "Alex Morgan",
      title: "Executive Director",
    },
  },
};
