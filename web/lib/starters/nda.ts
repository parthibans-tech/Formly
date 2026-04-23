import type { Starter } from "./types";

export const ndaStarter: Starter = {
  id: "nda",
  name: "Mutual NDA",
  description:
    "Mutual non-disclosure agreement between two parties, with effective date and signature blocks.",
  category: "Legal",
  tags: ["contract", "legal", "nda"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Mutual NDA</title>
  <style>
    body { font-family: Georgia, "Times New Roman", serif; color: #111; padding: 56px; max-width: 720px; margin: auto; line-height: 1.6; }
    h1 { text-align: center; font-size: 22px; letter-spacing: .04em; text-transform: uppercase; margin-bottom: 4px; }
    .sub { text-align: center; color: #666; font-size: 13px; margin-bottom: 32px; }
    h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .06em; margin-top: 24px; }
    p { text-align: justify; }
    .parties { margin: 28px 0; padding: 16px; background: #fafafa; border: 1px solid #e5e7eb; border-radius: 6px; }
    .sig-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-top: 48px; }
    .sig-box { border-top: 1px solid #111; padding-top: 6px; font-size: 13px; }
    .sig-box .muted { color: #666; font-size: 11px; }
  </style>
</head>
<body>
  <h1>Mutual Non-Disclosure Agreement</h1>
  <div class="sub">
    Effective as of {{ .effectiveDate | formatDate "January 2, 2006" }}
  </div>

  <div class="parties">
    <p>
      This Mutual Non-Disclosure Agreement (the "<strong>Agreement</strong>") is entered into by and between
      <strong>{{ .partyA.name }}</strong>, with a principal place of business at {{ .partyA.address }}
      ("Party A"), and <strong>{{ .partyB.name }}</strong>, with a principal place of business at
      {{ .partyB.address }} ("Party B"), each a "Party" and collectively the "Parties".
    </p>
  </div>

  <h2>1. Confidential Information</h2>
  <p>
    "Confidential Information" means any non-public information disclosed by one Party to the other,
    whether orally or in writing, that is designated as confidential or that reasonably should be
    understood to be confidential given the nature of the information and the circumstances of disclosure.
  </p>

  <h2>2. Obligations</h2>
  <p>
    Each Party agrees to (a) use the Confidential Information solely for the purpose of
    <strong>{{ .purpose }}</strong>, (b) not disclose such information to any third party without the
    prior written consent of the disclosing Party, and (c) protect the information with the same degree
    of care it uses to protect its own confidential information, but in no case less than reasonable care.
  </p>

  <h2>3. Term</h2>
  <p>
    The obligations in this Agreement survive for a period of {{ .termYears }} year{{ if ne .termYears 1.0 }}s{{ end }}
    from the Effective Date.
  </p>

  <h2>4. Governing Law</h2>
  <p>This Agreement shall be governed by the laws of {{ .governingLaw }}.</p>

  <p style="margin-top: 32px;">
    <strong>IN WITNESS WHEREOF,</strong> the Parties have executed this Agreement as of the Effective Date.
  </p>

  <div class="sig-grid">
    <div class="sig-box">
      <div>{{ .partyA.signatory }}</div>
      <div class="muted">{{ .partyA.title }} · {{ .partyA.name }}</div>
    </div>
    <div class="sig-box">
      <div>{{ .partyB.signatory }}</div>
      <div class="muted">{{ .partyB.title }} · {{ .partyB.name }}</div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    effectiveDate: "2026-04-23",
    purpose: "evaluating a potential business relationship",
    termYears: 2,
    governingLaw: "the State of Delaware, USA",
    partyA: {
      name: "Acme Studios, Inc.",
      address: "100 Main Street, Portland, OR 97201",
      signatory: "Alex Morgan",
      title: "Chief Executive Officer",
    },
    partyB: {
      name: "Globex Corporation",
      address: "500 Market St, San Francisco, CA 94103",
      signatory: "Jordan Park",
      title: "VP Partnerships",
    },
  },
};
