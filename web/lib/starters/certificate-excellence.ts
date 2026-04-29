import type { Starter } from "./types";

export const certificateExcellenceStarter: Starter = {
  id: "certificate-excellence",
  name: "Certificate of excellence",
  description:
    "Premium emerald and gold certificate for outstanding performance — sophisticated, formal, awards-night feel.",
  category: "Certificates",
  tags: ["certificate", "excellence", "premium"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Certificate of Excellence — {{ .recipient.name }}</title>
  <style>
    @page { size: A4 landscape; margin: 0; }
    body { font-family: "Cormorant Garamond", "Playfair Display", Georgia, serif; margin: 0; padding: 24px; background: #022c22; color: #ecfdf5; }
    .cert { background: linear-gradient(135deg, #064e3b 0%, #022c22 100%); border: 1px solid #d4af37; padding: 56px 72px; height: 100%; box-sizing: border-box; position: relative; }
    .frame { position: absolute; top: 12px; right: 12px; bottom: 12px; left: 12px; border: 1px solid rgba(212,175,55,.5); pointer-events: none; }
    .crest { text-align: center; color: #d4af37; font-size: 38px; line-height: 1; margin: 4px 0 6px; }
    .eyebrow { letter-spacing: .4em; text-transform: uppercase; font-size: 11px; color: #d4af37; text-align: center; margin-bottom: 6px; font-family: Inter, sans-serif; font-weight: 600; }
    h1 { font-family: "Playfair Display", Georgia, serif; font-size: 56px; text-align: center; margin: 0 0 4px; color: #fef3c7; font-weight: 700; letter-spacing: .02em; }
    .sub { text-align: center; font-size: 13px; letter-spacing: .25em; text-transform: uppercase; color: #6ee7b7; font-family: Inter, sans-serif; margin-bottom: 28px; }
    .presented { text-align: center; font-size: 16px; color: #a7f3d0; font-style: italic; }
    .name { text-align: center; font-size: 64px; color: #d4af37; margin: 10px 0 8px; font-weight: 600; letter-spacing: -.01em; }
    .scroll { display: block; text-align: center; color: #d4af37; margin: 0 0 18px; letter-spacing: .8em; }
    .description { text-align: center; font-family: Inter, sans-serif; font-size: 15px; max-width: 700px; margin: 0 auto 36px; color: #d1fae5; line-height: 1.8; }
    .area { color: #fef3c7; font-style: italic; font-weight: 600; }
    .footer { display: grid; grid-template-columns: 1fr auto 1fr; align-items: end; gap: 32px; margin-top: 28px; font-family: Inter, sans-serif; }
    .sig { font-size: 12px; color: #a7f3d0; border-top: 1px solid #d4af37; padding-top: 6px; }
    .sig b { display: block; color: #fef3c7; font-size: 14px; font-family: "Playfair Display", Georgia, serif; }
    .medal { width: 96px; height: 96px; border-radius: 50%; background: radial-gradient(circle at 30% 30%, #fde68a 0%, #d4af37 60%, #92400e 100%); display: grid; place-items: center; color: #022c22; font-size: 28px; font-weight: 800; box-shadow: 0 0 0 4px #022c22, 0 0 0 6px #d4af37; }
  </style>
</head>
<body>
  <div class="cert">
    <div class="frame"></div>
    <div class="crest">✦</div>
    <div class="eyebrow">{{ .organization }}</div>
    <h1>Certificate of Excellence</h1>
    <div class="sub">Awarded for distinguished merit</div>

    <div class="presented">This honour is bestowed upon</div>
    <div class="name">{{ .recipient.name }}</div>
    <div class="scroll">— ✦ —</div>

    <div class="description">
      In recognition of demonstrated excellence in <span class="area">{{ .area }}</span>,
      and for upholding the highest standards of professionalism, integrity, and craftsmanship.
      {{ .citation }}
    </div>

    <div class="footer">
      <div class="sig">
        <b>{{ .president.name }}</b>
        {{ .president.title }}
      </div>
      <div class="medal">★</div>
      <div class="sig" style="text-align:right">
        <b>{{ .awardedAt | formatDate "January 2, 2006" }}</b>
        Reg. {{ .certId }}
      </div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    organization: "Drive360 Honours Society",
    recipient: { name: "Dr. Anaya Krishnan" },
    area: "research and innovation in machine learning",
    citation:
      "Whose contributions have advanced the state of the art and inspired colleagues across the discipline.",
    president: {
      name: "Prof. Edward Whitfield",
      title: "President of the Society",
    },
    awardedAt: "2026-04-22",
    certId: "EXC-2026-0044",
  },
};
