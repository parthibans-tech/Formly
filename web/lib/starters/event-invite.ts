import type { Starter } from "./types";

export const eventInviteStarter: Starter = {
  id: "event-invite",
  name: "Event invitation",
  description:
    "Elegant invitation with venue, date, dress code, and RSVP details.",
  category: "Events",
  tags: ["event", "invite", "rsvp"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .event.name }}</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: "Cormorant Garamond", Georgia, serif; color: #1f2937; padding: 64px 72px; max-width: 760px; margin: auto; text-align: center; }
    .frame { border: 1px solid #b08968; padding: 56px 48px; position: relative; }
    .frame::before, .frame::after { content: ""; position: absolute; left: 12px; right: 12px; height: 1px; background: #b08968; }
    .frame::before { top: 12px; } .frame::after { bottom: 12px; }
    .eyebrow { font-family: Inter, sans-serif; font-size: 11px; letter-spacing: .3em; text-transform: uppercase; color: #b08968; font-weight: 600; }
    h1 { font-size: 44px; margin: 14px 0 6px; font-weight: 500; letter-spacing: -.01em; line-height: 1.1; }
    .by { font-size: 16px; color: #6b7280; font-style: italic; margin-bottom: 28px; }
    .request { font-size: 17px; line-height: 1.6; color: #374151; max-width: 460px; margin: 0 auto; }
    .request .who { font-weight: 600; }
    .divider { display: flex; align-items: center; justify-content: center; margin: 24px 0; gap: 12px; color: #b08968; }
    .divider .line { flex: 0 0 60px; height: 1px; background: #b08968; }
    .divider .ornament { font-size: 20px; }
    .when { font-size: 22px; margin: 8px 0; }
    .where { font-size: 16px; color: #4b5563; margin-bottom: 4px; }
    .footer { margin-top: 28px; font-family: Inter, sans-serif; font-size: 12px; color: #6b7280; letter-spacing: .04em; }
    .footer b { color: #1f2937; font-weight: 600; }
    .footer .row { margin-top: 4px; }
  </style>
</head>
<body>
  <div class="frame">
    <div class="eyebrow">{{ .event.kind }}</div>
    <h1>{{ .event.name }}</h1>
    <div class="by">hosted by {{ .host }}</div>

    <div class="request">
      The pleasure of your company is requested
      {{ if .recipient }}of <span class="who">{{ .recipient }}</span>{{ end }}
      for an evening of {{ .event.theme }}.
    </div>

    <div class="divider"><span class="line"></span><span class="ornament">✦</span><span class="line"></span></div>

    <div class="when">{{ .event.date | formatDate "Saturday, January 2, 2006" }}</div>
    <div class="when" style="font-size: 17px; color: #4b5563;">{{ .event.time }}</div>

    <div class="divider"><span class="line"></span><span class="ornament">✦</span><span class="line"></span></div>

    <div style="font-size: 19px; font-weight: 500;">{{ .venue.name }}</div>
    <div class="where">{{ .venue.address }}</div>

    <div class="footer">
      <div class="row"><b>Dress</b> · {{ .dress }}</div>
      <div class="row"><b>RSVP</b> · {{ .rsvpBy | formatDate "Jan 2" }} to {{ .rsvpEmail }}</div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    event: {
      kind: "You're invited to",
      name: "An Evening at the Astoria",
      theme: "music, conversation, and a long table dinner",
      date: "2026-06-14",
      time: "Seven o'clock in the evening",
    },
    host: "Northwind Partners",
    recipient: "Mr. & Mrs. Carter",
    venue: {
      name: "The Astoria Club",
      address: "44 Lexington Avenue · New York City",
    },
    dress: "Cocktail",
    rsvpBy: "2026-05-25",
    rsvpEmail: "rsvp@northwind.example",
  },
};
