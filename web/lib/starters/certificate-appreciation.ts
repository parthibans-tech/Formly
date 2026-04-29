import type { Starter } from "./types";

export const certificateAppreciationStarter: Starter = {
  id: "certificate-appreciation",
  name: "Certificate of appreciation",
  description:
    "Warm coral certificate for thank-you moments — recognise contribution, kindness, or extra effort.",
  category: "Certificates",
  tags: ["certificate", "appreciation", "thank-you"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Certificate of Appreciation — {{ .recipient.name }}</title>
  <style>
    @page { size: A4 landscape; margin: 0; }
    body { font-family: "Inter", system-ui, sans-serif; margin: 0; padding: 28px; background: #fff7ed; color: #431407; }
    .cert { background: white; border-radius: 16px; padding: 56px 72px; height: 100%; box-sizing: border-box; position: relative; overflow: hidden; box-shadow: 0 0 0 1px #fed7aa inset; }
    .ribbon { position: absolute; top: 0; left: 0; right: 0; height: 8px; background: linear-gradient(90deg, #fb7185 0%, #fb923c 50%, #f59e0b 100%); }
    .corner { position: absolute; width: 140px; height: 140px; border-radius: 50%; opacity: .14; }
    .corner.tl { top: -50px; left: -50px; background: #fb7185; }
    .corner.br { bottom: -50px; right: -50px; background: #fb923c; }
    .header { text-align: center; margin-top: 14px; }
    .eyebrow { letter-spacing: .35em; text-transform: uppercase; font-size: 11px; color: #c2410c; margin-bottom: 10px; font-weight: 700; }
    h1 { font-size: 46px; margin: 0 0 6px; color: #9a3412; font-weight: 800; letter-spacing: -.01em; }
    .sub { font-size: 14px; color: #7c2d12; font-style: italic; margin-bottom: 30px; }
    .presented { text-align: center; font-size: 14px; color: #78350f; }
    .name { text-align: center; font-size: 56px; color: #9a3412; margin: 8px 0 6px; font-weight: 700; letter-spacing: -.02em; }
    .heart { display: block; text-align: center; color: #fb7185; font-size: 22px; margin: 4px 0 18px; }
    .description { text-align: center; font-size: 15px; max-width: 720px; margin: 0 auto 36px; color: #44403c; line-height: 1.7; }
    .reason { color: #9a3412; font-weight: 600; }
    .footer { display: flex; justify-content: space-between; align-items: flex-end; gap: 40px; margin-top: 30px; }
    .sig { font-size: 12px; color: #78350f; border-top: 2px solid #fb923c; padding-top: 6px; flex: 1; }
    .sig b { display: block; font-size: 14px; color: #9a3412; }
    .stamp { text-align: center; font-size: 10px; color: #c2410c; letter-spacing: .15em; text-transform: uppercase; }
    .stamp b { display: block; font-size: 16px; color: #9a3412; letter-spacing: .04em; text-transform: none; }
  </style>
</head>
<body>
  <div class="cert">
    <div class="ribbon"></div>
    <div class="corner tl"></div>
    <div class="corner br"></div>
    <div class="header">
      <div class="eyebrow">{{ .organization }}</div>
      <h1>Certificate of Appreciation</h1>
      <div class="sub">A heartfelt thank you</div>
    </div>

    <div class="presented">Presented with gratitude to</div>
    <div class="name">{{ .recipient.name }}</div>
    <div class="heart">♥</div>

    <div class="description">
      In sincere appreciation for <span class="reason">{{ .reason }}</span>.
      {{ .message }}
    </div>

    <div class="footer">
      <div class="sig">
        <b>{{ .signatory.name }}</b>
        {{ .signatory.title }} · {{ .organization }}
      </div>
      <div class="stamp">
        Presented on
        <b>{{ .presentedAt | formatDate "January 2, 2006" }}</b>
      </div>
      <div class="sig" style="text-align:right">
        <b>Ref: {{ .certId }}</b>
        With our sincere thanks
      </div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    organization: "Drive360 Customer Success",
    recipient: { name: "Marcus Chen" },
    reason: "going above and beyond to support our community",
    message:
      "Your kindness, dedication, and willingness to help others has made a lasting impact on everyone you've worked with this year.",
    signatory: {
      name: "Alex Morgan",
      title: "Head of People",
    },
    presentedAt: "2026-04-22",
    certId: "APR-2026-0892",
  },
};
