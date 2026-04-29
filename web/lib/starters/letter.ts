import type { Starter } from "./types";

export const letterStarter: Starter = {
  id: "letter",
  name: "Business letter",
  description:
    "Formal letterhead-style correspondence with sender block, recipient, body paragraphs, and signature line.",
  category: "Correspondence",
  tags: ["letter", "formal", "correspondence"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Letter</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Georgia, "Times New Roman", serif; color: #1f2937; padding: 64px 72px; max-width: 780px; margin: auto; line-height: 1.6; }
    .letterhead { border-bottom: 2px solid #1f2937; padding-bottom: 14px; margin-bottom: 36px; display: flex; justify-content: space-between; align-items: flex-end; }
    .brand { font-family: Inter, system-ui, sans-serif; font-size: 22px; font-weight: 700; color: #1f2937; letter-spacing: -.01em; }
    .sender { font-family: Inter, system-ui, sans-serif; text-align: right; font-size: 12px; color: #6b7280; line-height: 1.5; }
    .meta { color: #6b7280; font-size: 13px; margin-bottom: 28px; }
    .recipient { margin-bottom: 28px; font-size: 14px; }
    .recipient .name { font-weight: 600; color: #111827; }
    .salutation { margin-bottom: 16px; font-size: 15px; }
    p { margin: 0 0 14px; font-size: 15px; }
    .closing { margin-top: 36px; font-size: 15px; }
    .signature { margin-top: 48px; }
    .signature .line { border-top: 1px solid #1f2937; width: 220px; padding-top: 6px; font-size: 13px; }
    .signature .name { font-weight: 600; color: #111827; }
    .signature .title { color: #6b7280; font-size: 12px; }
  </style>
</head>
<body>
  <div class="letterhead">
    <div class="brand">{{ .sender.company }}</div>
    <div class="sender">
      {{ .sender.address }}<br />
      {{ .sender.cityState }}<br />
      {{ .sender.email }}
    </div>
  </div>

  <div class="meta">{{ .sentAt | formatDate "January 2, 2006" }}</div>

  <div class="recipient">
    <div class="name">{{ .recipient.name }}</div>
    <div>{{ .recipient.title }}</div>
    <div>{{ .recipient.company }}</div>
    <div>{{ .recipient.address }}</div>
    <div>{{ .recipient.cityState }}</div>
  </div>

  <div class="salutation">Dear {{ .recipient.salutation }},</div>

  <p>{{ .body.opening }}</p>

  <p>{{ .body.middle }}</p>

  {{ if .body.closing }}
  <p>{{ .body.closing }}</p>
  {{ end }}

  <div class="closing">{{ .closing }},</div>

  <div class="signature">
    <div class="line">
      <div class="name">{{ .sender.name }}</div>
      <div class="title">{{ .sender.title }}</div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    sender: {
      company: "Northwind Partners",
      name: "Sarah Whitaker",
      title: "Director of Operations",
      address: "240 Pine Street, Suite 1100",
      cityState: "Seattle, WA 98101",
      email: "sarah@northwind.example",
    },
    recipient: {
      name: "Mr. James Carter",
      salutation: "Mr. Carter",
      title: "Chief Financial Officer",
      company: "Carter & Associates",
      address: "85 Madison Avenue, 12th Floor",
      cityState: "New York, NY 10016",
    },
    sentAt: "2026-04-22",
    body: {
      opening:
        "Thank you for taking the time to meet with our team last week. We greatly appreciated the candid discussion about your firm's expansion plans and the operational challenges that have surfaced over the past quarter.",
      middle:
        "Following our conversation, I've prepared the proposal we discussed, outlining a phased engagement that addresses each priority you raised. Our team is prepared to begin within two weeks of countersignature, and we'd welcome the opportunity to walk through the timeline with your leadership at your earliest convenience.",
      closing:
        "Please don't hesitate to reach out with any questions. I look forward to continuing the discussion and hopefully working together in the months ahead.",
    },
    closing: "Warm regards",
  },
};
