import type { Starter } from "./types";

export const certificateTrainingStarter: Starter = {
  id: "certificate-training",
  name: "Certificate of training",
  description:
    "Corporate teal certificate for completed training programmes — modules, hours, and final assessment.",
  category: "Certificates",
  tags: ["certificate", "training", "course"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Training Certificate — {{ .recipient.name }}</title>
  <style>
    @page { size: A4 landscape; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; margin: 0; padding: 24px; background: #f0fdfa; color: #042f2e; }
    .cert { background: white; border-radius: 14px; padding: 48px 60px; height: 100%; box-sizing: border-box; position: relative; box-shadow: 0 0 0 1px #99f6e4 inset; display: flex; flex-direction: column; }
    .stripe { position: absolute; left: 0; top: 0; bottom: 0; width: 12px; background: linear-gradient(180deg, #0d9488 0%, #14b8a6 100%); }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 18px; }
    .brand { font-size: 13px; font-weight: 700; color: #0f766e; letter-spacing: .14em; text-transform: uppercase; }
    .meta { font-size: 11px; color: #475569; text-align: right; }
    .meta b { color: #0f766e; }
    .title-block { text-align: center; margin: 6px 0 18px; }
    .eyebrow { letter-spacing: .3em; text-transform: uppercase; font-size: 11px; color: #0d9488; font-weight: 600; }
    h1 { font-size: 40px; margin: 4px 0 0; color: #134e4a; font-weight: 800; letter-spacing: -.01em; }
    .presented { text-align: center; font-size: 13px; color: #475569; margin-top: 4px; }
    .name { text-align: center; font-size: 40px; color: #134e4a; margin: 4px 0 4px; font-weight: 700; letter-spacing: -.01em; }
    .program-line { text-align: center; font-size: 14px; color: #334155; margin-bottom: 22px; }
    .program { color: #0f766e; font-weight: 600; }
    .modules { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 28px; margin: 0 auto 22px; max-width: 760px; }
    .module { display: flex; gap: 10px; align-items: flex-start; font-size: 13px; color: #1e293b; }
    .module .check { color: #0d9488; font-weight: 700; flex-shrink: 0; }
    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; max-width: 760px; margin: 0 auto 24px; padding: 14px; background: #f0fdfa; border: 1px solid #99f6e4; border-radius: 10px; }
    .stat { text-align: center; }
    .stat .v { font-size: 20px; font-weight: 800; color: #0f766e; }
    .stat .k { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: #64748b; margin-top: 2px; }
    .footer { display: flex; justify-content: space-between; align-items: flex-end; gap: 32px; margin-top: auto; }
    .sig { font-size: 12px; color: #475569; border-top: 2px solid #0d9488; padding-top: 6px; flex: 1; }
    .sig b { display: block; color: #134e4a; font-size: 14px; }
    .seal { width: 78px; height: 78px; border-radius: 50%; background: #0d9488; color: white; display: grid; place-items: center; font-size: 9px; letter-spacing: .12em; font-weight: 700; text-align: center; line-height: 1.3; padding: 6px; }
  </style>
</head>
<body>
  <div class="cert">
    <div class="stripe"></div>
    <div class="header">
      <div class="brand">{{ .organization }}</div>
      <div class="meta">
        Cert ID: <b>{{ .certId }}</b><br />
        Issued: {{ .issuedAt | formatDate "Jan 2, 2006" }}
      </div>
    </div>

    <div class="title-block">
      <div class="eyebrow">Certificate of Training</div>
      <h1>Successfully Completed</h1>
    </div>

    <div class="presented">This certifies that</div>
    <div class="name">{{ .recipient.name }}</div>
    <div class="program-line">
      has successfully completed the programme
      <span class="program">{{ .program.name }}</span>
    </div>

    <div class="modules">
      {{ range .program.modules }}
      <div class="module"><span class="check">✓</span><span>{{ . }}</span></div>
      {{ end }}
    </div>

    <div class="stats">
      <div class="stat"><div class="v">{{ .program.hours }}h</div><div class="k">Total hours</div></div>
      <div class="stat"><div class="v">{{ .program.modules | len }}</div><div class="k">Modules</div></div>
      <div class="stat"><div class="v">{{ .program.score }}%</div><div class="k">Final score</div></div>
      <div class="stat"><div class="v">{{ .program.grade }}</div><div class="k">Grade</div></div>
    </div>

    <div class="footer">
      <div class="sig">
        <b>{{ .instructor.name }}</b>
        {{ .instructor.title }}
      </div>
      <div class="seal">TRAINING<br />COMPLETE</div>
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
    organization: "Drive360 Learning Academy",
    certId: "TRN-2026-3318",
    issuedAt: "2026-04-22",
    recipient: { name: "Rohan Kapoor" },
    program: {
      name: "Advanced Cloud Architecture (AWS)",
      modules: [
        "Infrastructure as Code with Terraform",
        "VPC, Subnets & Security Groups",
        "ECS, Fargate & Container Orchestration",
        "Observability with CloudWatch & X-Ray",
        "Cost Optimisation & FinOps",
        "Disaster Recovery Patterns",
      ],
      hours: 40,
      score: 94,
      grade: "A",
    },
    instructor: {
      name: "Lisa Tanaka",
      title: "Lead Instructor",
    },
    director: {
      name: "Alex Morgan",
      title: "Director, Learning & Development",
    },
  },
};
