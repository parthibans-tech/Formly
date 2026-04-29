import type { Starter } from "./types";

export const leaseAgreementStarter: Starter = {
  id: "lease-agreement",
  name: "Lease agreement",
  description:
    "Residential lease covering parties, premises, term, rent, deposit, and signatures.",
  category: "Legal",
  tags: ["lease", "rental", "real estate", "agreement"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Lease Agreement</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Georgia, "Times New Roman", serif; color: #111; padding: 64px 72px; max-width: 780px; margin: auto; line-height: 1.6; }
    h1 { text-align: center; margin: 0 0 4px; font-size: 24px; letter-spacing: .04em; }
    .subtitle { text-align: center; font-size: 13px; color: #4b5563; margin-bottom: 28px; font-family: Inter, sans-serif; letter-spacing: .12em; text-transform: uppercase; }
    p { margin: 0 0 12px; font-size: 14px; }
    h2 { font-size: 14px; margin: 22px 0 6px; letter-spacing: .04em; text-transform: uppercase; font-family: Inter, sans-serif; border-bottom: 1px solid #d1d5db; padding-bottom: 4px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; font-size: 14px; }
    .grid b { display: block; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #6b7280; font-weight: 700; margin-bottom: 2px; font-family: Inter, sans-serif; }
    .signbox { display: grid; grid-template-columns: 1fr 1fr; gap: 36px; margin-top: 56px; }
    .signbox .line { border-top: 1px solid #111; padding-top: 6px; font-family: Inter, sans-serif; font-size: 12px; color: #6b7280; }
    .signbox .line b { color: #111; display: block; font-size: 13px; }
  </style>
</head>
<body>
  <h1>Residential Lease Agreement</h1>
  <div class="subtitle">{{ .agreement.executedAt | formatDate "January 2, 2006" }}</div>

  <p>
    This Residential Lease Agreement ("Agreement") is entered into as of {{ .agreement.executedAt | formatDate "January 2, 2006" }} between
    <b>{{ .landlord.name }}</b> ("Landlord") and <b>{{ .tenant.name }}</b> ("Tenant"), collectively referred to as the "Parties."
  </p>

  <h2>1. Premises</h2>
  <p>
    Landlord leases to Tenant the residential premises located at <b>{{ .premises.address }}, {{ .premises.cityState }} {{ .premises.zip }}</b> ("Premises"), together with the fixtures and appliances described in Exhibit A.
  </p>

  <h2>2. Term</h2>
  <div class="grid">
    <div><b>Start date</b>{{ .term.start | formatDate "January 2, 2006" }}</div>
    <div><b>End date</b>{{ .term.end | formatDate "January 2, 2006" }}</div>
  </div>

  <h2>3. Rent & deposit</h2>
  <div class="grid" style="margin-bottom: 8px;">
    <div><b>Monthly rent</b>{{ .rent.monthly | formatCurrency "USD" }}, due on the {{ .rent.dueDay }} of each month.</div>
    <div><b>Security deposit</b>{{ .rent.deposit | formatCurrency "USD" }}, paid at signing.</div>
    <div><b>Late fee</b>{{ .rent.lateFee | formatCurrency "USD" }} after a {{ .rent.grace }}-day grace period.</div>
    <div><b>Payment method</b>{{ .rent.method }}</div>
  </div>

  <h2>4. Utilities & services</h2>
  <p>{{ .utilities }}</p>

  <h2>5. Use of premises</h2>
  <p>{{ .use }}</p>

  <h2>6. Maintenance & repairs</h2>
  <p>{{ .maintenance }}</p>

  <h2>7. Pets</h2>
  <p>{{ .pets }}</p>

  <h2>8. Termination</h2>
  <p>{{ .termination }}</p>

  <h2>9. Governing law</h2>
  <p>This Agreement is governed by the laws of {{ .state }}.</p>

  <p style="margin-top: 18px;">By signing below, the Parties agree to be bound by the terms of this Agreement.</p>

  <div class="signbox">
    <div class="line">Landlord<b>{{ .landlord.name }}</b></div>
    <div class="line">Tenant<b>{{ .tenant.name }}</b></div>
  </div>
</body>
</html>
`,
  sampleData: {
    agreement: { executedAt: "2026-04-22" },
    landlord: { name: "Westbridge Property Management LLC" },
    tenant: { name: "Avery Johnson" },
    premises: {
      address: "1240 Lakeshore Drive, Apt 3B",
      cityState: "Madison, WI",
      zip: "53715",
    },
    term: { start: "2026-05-01", end: "2027-04-30" },
    rent: { monthly: 2150, dueDay: "1st", deposit: 2150, lateFee: 75, grace: 5, method: "ACH or money order; no cash" },
    utilities:
      "Tenant is responsible for electricity, internet, and renter's insurance ($100,000 minimum liability). Landlord covers water, sewer, and trash collection.",
    use:
      "The Premises shall be used solely as a private residence for Tenant and the named occupants in Exhibit B. No commercial or unlawful use is permitted.",
    maintenance:
      "Tenant agrees to maintain the Premises in clean, sanitary condition and report needed repairs in writing within 5 days. Landlord is responsible for major systems (HVAC, plumbing, electrical) and shall make repairs within a reasonable time after notice.",
    pets:
      "One domestic cat or dog under 40 lbs is permitted with a $300 non-refundable pet fee. All other animals require prior written consent.",
    termination:
      "Either party may terminate this Agreement at the end of its term with 60 days' written notice. Early termination by Tenant requires payment of two months' rent as liquidated damages, except where prohibited by law.",
    state: "the State of Wisconsin",
  },
};
