import type { Starter } from "./types";

export const certificateStarter: Starter = {
  id: "certificate",
  name: "Certificate",
  description:
    "Landscape-style certificate of completion with ornate border, ideal for courses and awards.",
  category: "Certificates",
  tags: ["certificate", "award", "training"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Certificate</title>
  <style>
    @page { size: A4 landscape; margin: 0; }
    body { font-family: Georgia, "Times New Roman", serif; margin: 0; padding: 40px; background: #fffbf0; color: #1f2937; }
    .cert {
      border: 10px double #92400e;
      border-radius: 6px;
      padding: 48px 56px;
      height: 100%;
      text-align: center;
      background: linear-gradient(135deg, #fffbf0 0%, #fef3c7 100%);
      box-sizing: border-box;
    }
    .eyebrow { letter-spacing: .3em; text-transform: uppercase; font-size: 12px; color: #92400e; }
    h1 { font-size: 44px; letter-spacing: .05em; margin: 8px 0 24px; color: #78350f; }
    .presented { font-size: 15px; color: #444; }
    .name { font-family: "Brush Script MT", "Snell Roundhand", cursive; font-size: 56px; color: #78350f; margin: 8px 0; }
    .description { font-size: 16px; max-width: 600px; margin: 18px auto 40px; color: #333; }
    .course { font-weight: 700; }
    .footer { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 32px; font-size: 13px; color: #555; }
    .sig { border-top: 1px solid #555; padding-top: 4px; min-width: 180px; font-size: 12px; }
    .seal { width: 90px; height: 90px; border-radius: 50%; border: 3px solid #92400e; display: grid; place-items: center; color: #92400e; font-weight: 700; font-size: 11px; letter-spacing: .2em; background: #fef3c7; }
  </style>
</head>
<body>
  <div class="cert">
    <div class="eyebrow">{{ .eyebrow }}</div>
    <h1>Certificate of Completion</h1>

    <div class="presented">This certificate is proudly presented to</div>
    <div class="name">{{ .recipient.name }}</div>

    <div class="description">
      for successfully completing
      <span class="course">{{ .course.name }}</span>
      on {{ .completedAt | formatDate "January 2, 2006" }}
      with a total of {{ .course.hours }} hours of instruction.
    </div>

    <div class="footer">
      <div class="sig">
        {{ .issuer.signatory }}
        <div>{{ .issuer.title }}</div>
      </div>
      <div class="seal">OFFICIAL</div>
      <div class="sig">
        #{{ .certId }}
        <div>Issued {{ .issuedAt | formatDate "2006-01-02" }}</div>
      </div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    eyebrow: "Drive360 Academy",
    recipient: { name: "Priya Ramesh" },
    course: {
      name: "Advanced Document Automation",
      hours: 24,
    },
    completedAt: "2026-04-22",
    issuedAt: "2026-04-23",
    certId: "FA-2026-00412",
    issuer: {
      signatory: "Alex Morgan",
      title: "Director of Education",
    },
  },
};
