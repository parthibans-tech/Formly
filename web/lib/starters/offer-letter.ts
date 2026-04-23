import type { Starter } from "./types";

export const offerLetterStarter: Starter = {
  id: "offer-letter",
  name: "Offer letter",
  description:
    "Standard employment offer letter with compensation, equity (optional), and start date.",
  category: "HR",
  tags: ["employment", "offer", "hr"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Offer: {{ .candidate.name }}</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; color: #111; padding: 56px; max-width: 720px; margin: auto; line-height: 1.6; }
    .brand { font-weight: 700; color: #0f766e; font-size: 20px; margin-bottom: 4px; }
    .muted { color: #666; font-size: 13px; }
    h1 { font-size: 22px; margin: 36px 0 8px; }
    h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .06em; margin-top: 24px; }
    p { text-align: justify; }
    .facts { display: grid; grid-template-columns: 180px 1fr; gap: 8px 16px; background: #f0fdfa; border: 1px solid #99f6e4; padding: 16px 20px; border-radius: 8px; }
    .facts dt { font-weight: 600; color: #0f766e; }
    .sig { margin-top: 64px; display: grid; grid-template-columns: 1fr 1fr; gap: 40px; }
    .sig .line { border-top: 1px solid #111; padding-top: 6px; font-size: 13px; }
    .sig .muted { font-size: 11px; }
  </style>
</head>
<body>
  <div class="brand">{{ .company.name }}</div>
  <div class="muted">{{ .company.address }}</div>
  <div class="muted">{{ .letterDate | formatDate "January 2, 2006" }}</div>

  <h1>Dear {{ .candidate.name }},</h1>

  <p>
    We are delighted to offer you the position of <strong>{{ .role.title }}</strong> at
    {{ .company.name }}, reporting to {{ .role.manager }}. We believe you will make an exceptional
    addition to our {{ .role.team }} team.
  </p>

  <h2>Summary of your offer</h2>
  <dl class="facts">
    <dt>Start date</dt><dd>{{ .start | formatDate "Monday, January 2, 2006" }}</dd>
    <dt>Base salary</dt><dd>{{ .comp.base | formatCurrency "USD" }} per year</dd>
    {{ if .comp.bonus }}<dt>Annual target bonus</dt><dd>{{ .comp.bonus | formatCurrency "USD" }}</dd>{{ end }}
    {{ if .comp.equity }}<dt>Equity</dt><dd>{{ .comp.equity }}</dd>{{ end }}
    <dt>Location</dt><dd>{{ .role.location }}</dd>
    <dt>Employment type</dt><dd>{{ .role.type }}</dd>
  </dl>

  <h2>Benefits</h2>
  <ul>
    {{ range .benefits }}<li>{{ . }}</li>{{ end }}
  </ul>

  <h2>Next steps</h2>
  <p>
    Please sign this letter below by {{ .expiresAt | formatDate "January 2, 2006" }} to accept the offer.
    Your employment will be contingent upon successful completion of a background check and reference
    verification.
  </p>

  <p>
    We can't wait to welcome you to the team. If you have any questions, reach out to
    {{ .recruiter.name }} at {{ .recruiter.email }}.
  </p>

  <p>Warmly,</p>

  <div class="sig">
    <div class="line">
      {{ .company.signatory }}
      <div class="muted">{{ .company.signatoryTitle }} · {{ .company.name }}</div>
    </div>
    <div class="line">
      {{ .candidate.name }}
      <div class="muted">Accepted on ______________</div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    letterDate: "2026-04-23",
    start: "2026-05-19",
    expiresAt: "2026-04-30",
    company: {
      name: "Acme Studios, Inc.",
      address: "100 Main Street, Portland, OR 97201",
      signatory: "Alex Morgan",
      signatoryTitle: "CEO",
    },
    candidate: { name: "Priya Ramesh" },
    role: {
      title: "Senior Product Designer",
      manager: "Sam Okafor (Head of Design)",
      team: "Design",
      location: "Remote (US)",
      type: "Full-time",
    },
    comp: {
      base: 165000,
      bonus: 15000,
      equity: "2,500 RSUs over 4 years, 25% after first year",
    },
    benefits: [
      "Unlimited paid time off, 10 company holidays",
      "Comprehensive medical, dental, and vision",
      "$2,000 annual learning & development budget",
      "Home office stipend",
    ],
    recruiter: {
      name: "Dana Lee",
      email: "dana.lee@acme.example",
    },
  },
};
