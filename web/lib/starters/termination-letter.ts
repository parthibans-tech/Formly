import type { Starter } from "./types";

export const terminationLetterStarter: Starter = {
  id: "termination-letter",
  name: "Termination letter",
  description:
    "Formal end-of-employment letter covering reason, last day, final pay, and benefits continuation.",
  category: "HR",
  tags: ["termination", "separation", "employment"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Notice of Termination — {{ .employee.name }}</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: "Times New Roman", Georgia, serif; color: #111; padding: 56px 72px; max-width: 720px; margin: auto; line-height: 1.65; font-size: 12.5px; }
    .brand { font-weight: 700; font-size: 18px; }
    .muted { color: #555; font-size: 12px; }
    h1 { font-size: 18px; margin: 28px 0 12px; text-transform: uppercase; letter-spacing: .04em; }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; margin: 22px 0 8px; }
    p { text-align: justify; margin: 0 0 12px; }
    .facts { display: grid; grid-template-columns: 180px 1fr; gap: 6px 16px; background: #fef2f2; border: 1px solid #fecaca; padding: 14px 18px; border-radius: 6px; margin: 12px 0 18px; }
    .facts dt { font-weight: 600; color: #991b1b; }
    .sig { margin-top: 48px; }
    .sig b { display: block; }
  </style>
</head>
<body>
  <div class="brand">{{ .company.name }}</div>
  <div class="muted">{{ .company.address }}</div>
  <div class="muted">{{ .letterDate | formatDate "January 2, 2006" }}</div>

  <h1>Notice of Termination of Employment</h1>

  <p>Dear {{ .employee.name }},</p>

  <p>
    This letter confirms that your employment with {{ .company.name }} as
    <b>{{ .employee.title }}</b> will end on
    <b>{{ .lastDay | formatDate "Monday, January 2, 2006" }}</b>. The reason for termination is
    <b>{{ .reason }}</b>.
  </p>

  <h2>Key dates and amounts</h2>
  <dl class="facts">
    <dt>Last working day</dt><dd>{{ .lastDay | formatDate "January 2, 2006" }}</dd>
    <dt>Final paycheck</dt><dd>{{ .finalPayDate | formatDate "January 2, 2006" }}</dd>
    <dt>Severance</dt><dd>{{ if .severance.amount }}{{ .severance.amount | formatCurrency .severance.currency }} ({{ .severance.terms }}){{ else }}None{{ end }}</dd>
    <dt>Accrued PTO payout</dt><dd>{{ .ptoPayout | formatCurrency .severance.currency }}</dd>
    <dt>Benefits end</dt><dd>{{ .benefitsEnd | formatDate "January 2, 2006" }} (COBRA continuation paperwork to follow)</dd>
  </dl>

  <h2>Return of company property</h2>
  <p>
    Please return the following items to {{ .returnTo }} no later than your last working day:
    laptop, access cards, and any printed materials containing confidential information.
  </p>

  <h2>Continuing obligations</h2>
  <p>
    Your obligations regarding confidentiality, non-solicitation, and intellectual property
    under your employment agreement remain in effect after your last day, in accordance with
    the terms of that agreement.
  </p>

  <h2>Next steps</h2>
  <p>
    {{ .hrContact.name }} ({{ .hrContact.email }}) will follow up with COBRA, 401(k) rollover,
    and final-payment paperwork. {{ if .severance.amount }}Severance is contingent on signing
    the separation agreement enclosed with this letter.{{ end }}
  </p>

  <p>We thank you for your contributions and wish you success in your next chapter.</p>

  <div class="sig">
    <p>Sincerely,</p>
    <b>{{ .company.signatory }}</b>
    <div class="muted">{{ .company.signatoryTitle }} · {{ .company.name }}</div>
  </div>
</body>
</html>
`,
  sampleData: {
    letterDate: "2026-04-30",
    lastDay: "2026-05-15",
    finalPayDate: "2026-05-22",
    benefitsEnd: "2026-05-31",
    reason: "elimination of position due to organizational restructuring",
    returnTo: "the People Operations team (people@lumenlabs.example)",
    ptoPayout: 4200,
    company: {
      name: "Lumen Labs, Inc.",
      address: "100 Market Street, San Francisco, CA 94105",
      signatory: "Alex Morgan",
      signatoryTitle: "Chief Executive Officer",
    },
    employee: {
      name: "Jordan Kim",
      title: "Senior Marketing Manager",
    },
    severance: {
      amount: 25000,
      currency: "USD",
      terms: "8 weeks of base salary",
    },
    hrContact: {
      name: "Dana Lee",
      email: "dana.lee@lumenlabs.example",
    },
  },
};
