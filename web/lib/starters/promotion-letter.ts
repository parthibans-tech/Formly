import type { Starter } from "./types";

export const promotionLetterStarter: Starter = {
  id: "promotion-letter",
  name: "Promotion letter",
  description:
    "Warm, formal letter announcing a promotion with new title, compensation, and effective date.",
  category: "HR",
  tags: ["promotion", "employment", "letter"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Promotion — {{ .employee.name }}</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #111; padding: 56px 72px; max-width: 720px; margin: auto; line-height: 1.65; font-size: 13px; }
    .brand { font-weight: 700; color: #4338ca; font-size: 18px; }
    .muted { color: #666; font-size: 12px; }
    h1 { font-size: 22px; margin: 32px 0 14px; color: #1e1b4b; }
    .facts { display: grid; grid-template-columns: 200px 1fr; gap: 8px 16px; background: #eef2ff; border: 1px solid #c7d2fe; padding: 16px 20px; border-radius: 8px; margin: 18px 0; }
    .facts dt { font-weight: 600; color: #4338ca; }
    p { text-align: justify; }
    .sig { margin-top: 56px; }
    .sig b { display: block; font-size: 13px; }
  </style>
</head>
<body>
  <div class="brand">{{ .company.name }}</div>
  <div class="muted">{{ .letterDate | formatDate "January 2, 2006" }}</div>

  <h1>Dear {{ .employee.name }},</h1>

  <p>
    On behalf of the leadership team at {{ .company.name }}, I'm thrilled to share that you have
    been promoted to <b>{{ .role.newTitle }}</b>, effective
    {{ .role.effective | formatDate "Monday, January 2, 2006" }}.
  </p>

  <p>
    Your contributions over the past {{ .tenure }} — particularly {{ .recognition }} — have been
    central to our progress, and this promotion reflects both the impact you've already made and
    the trust we have in what you'll do next.
  </p>

  <h2>Summary of changes</h2>
  <dl class="facts">
    <dt>Previous title</dt><dd>{{ .role.oldTitle }}</dd>
    <dt>New title</dt><dd>{{ .role.newTitle }}</dd>
    <dt>Reports to</dt><dd>{{ .role.manager }}</dd>
    <dt>Effective date</dt><dd>{{ .role.effective | formatDate "January 2, 2006" }}</dd>
    <dt>New base salary</dt><dd>{{ .comp.newBase | formatCurrency .comp.currency }} per year</dd>
    {{ if .comp.bonus }}<dt>Annual target bonus</dt><dd>{{ .comp.bonus | formatCurrency .comp.currency }}</dd>{{ end }}
    {{ if .comp.equity }}<dt>Equity refresh</dt><dd>{{ .comp.equity }}</dd>{{ end }}
  </dl>

  <p>
    With this expanded scope come expanded expectations. {{ .role.manager }} will work with you
    over the next two weeks to align on goals for the next two quarters. All other terms of your
    employment remain unchanged.
  </p>

  <p>
    Congratulations again — we're proud to have you on the team and excited for what's ahead.
  </p>

  <div class="sig">
    <p>Warmly,</p>
    <b>{{ .company.signatory }}</b>
    <span class="muted">{{ .company.signatoryTitle }} · {{ .company.name }}</span>
  </div>
</body>
</html>
`,
  sampleData: {
    letterDate: "2026-04-30",
    tenure: "two years",
    recognition:
      "leading the analytics platform redesign and mentoring three of our newest engineers",
    company: {
      name: "Lumen Labs, Inc.",
      signatory: "Alex Morgan",
      signatoryTitle: "Chief Executive Officer",
    },
    employee: { name: "Priya Ramesh" },
    role: {
      oldTitle: "Software Engineer II",
      newTitle: "Senior Software Engineer",
      manager: "Sam Okafor (Engineering Manager)",
      effective: "2026-06-01",
    },
    comp: {
      currency: "USD",
      newBase: 175000,
      bonus: 20000,
      equity: "1,500 RSUs vesting over 4 years",
    },
  },
};
