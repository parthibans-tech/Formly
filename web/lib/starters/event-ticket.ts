import type { Starter } from "./types";

export const eventTicketStarter: Starter = {
  id: "event-ticket",
  name: "Event ticket",
  description:
    "Two-part admission ticket with event details, seat info, and tear-off stub.",
  category: "Events",
  tags: ["ticket", "event", "admission"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Ticket — {{ .event.name }}</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; color: #0f172a; padding: 60px; max-width: 820px; margin: auto; background: #f8fafc; }
    .ticket { display: grid; grid-template-columns: 1fr 200px; background: white; border-radius: 14px; overflow: hidden; box-shadow: 0 1px 0 #e2e8f0, 0 8px 24px rgba(15, 23, 42, .08); position: relative; }
    .ticket::before, .ticket::after { content: ""; position: absolute; width: 24px; height: 24px; background: #f8fafc; border-radius: 50%; right: 188px; }
    .ticket::before { top: -12px; }
    .ticket::after { bottom: -12px; }
    .main { padding: 28px 32px; background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); color: white; }
    .eyebrow { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #93c5fd; font-weight: 700; }
    h1 { margin: 6px 0 4px; font-size: 28px; letter-spacing: -.01em; line-height: 1.15; }
    .by { color: #cbd5e1; font-size: 13px; }
    .info { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-top: 24px; padding-top: 18px; border-top: 1px dashed rgba(255, 255, 255, .25); }
    .info .label { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: #93c5fd; font-weight: 700; }
    .info .value { font-size: 14px; font-weight: 600; margin-top: 3px; }
    .info .value.lg { font-size: 18px; }
    .holder { margin-top: 18px; padding-top: 16px; border-top: 1px dashed rgba(255, 255, 255, .25); }
    .holder .name { font-size: 16px; font-weight: 600; }
    .holder .ticketId { font-family: ui-monospace, "SF Mono", monospace; font-size: 11px; color: #94a3b8; margin-top: 4px; letter-spacing: .04em; }
    .stub { padding: 28px 22px; border-left: 2px dashed #e2e8f0; text-align: center; display: flex; flex-direction: column; justify-content: space-between; }
    .stub .small { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: #64748b; font-weight: 700; }
    .stub h2 { margin: 6px 0 0; font-size: 20px; letter-spacing: -.01em; }
    .stub .when { font-size: 13px; color: #475569; margin-top: 8px; }
    .stub .seat { background: #0f172a; color: white; border-radius: 8px; padding: 10px; margin-top: 14px; }
    .stub .seat .row { font-size: 11px; color: #94a3b8; letter-spacing: .12em; text-transform: uppercase; }
    .stub .seat .val { font-size: 16px; font-weight: 700; margin-top: 2px; }
    .stub .barcode { margin-top: 14px; font-family: ui-monospace, monospace; font-size: 9px; letter-spacing: .12em; color: #475569; }
    .stub .bars { display: flex; gap: 1px; height: 36px; margin: 6px auto 6px; justify-content: center; }
    .stub .bars .b { width: 2px; background: #0f172a; }
  </style>
</head>
<body>
  <div class="ticket">
    <div class="main">
      <div class="eyebrow">{{ .event.kind }}</div>
      <h1>{{ .event.name }}</h1>
      <div class="by">{{ .event.presenter }}</div>

      <div class="info">
        <div><div class="label">Date</div><div class="value lg">{{ .event.date | formatDate "Mon, Jan 2" }}</div></div>
        <div><div class="label">Doors</div><div class="value lg">{{ .event.doors }}</div></div>
        <div><div class="label">Show</div><div class="value lg">{{ .event.show }}</div></div>
      </div>

      <div class="info">
        <div><div class="label">Venue</div><div class="value">{{ .venue.name }}</div></div>
        <div><div class="label">City</div><div class="value">{{ .venue.city }}</div></div>
        <div><div class="label">Type</div><div class="value">{{ .ticket.type }}</div></div>
      </div>

      <div class="holder">
        <div class="name">{{ .holder.name }}</div>
        <div class="ticketId">Ticket · {{ .ticket.id }}</div>
      </div>
    </div>

    <div class="stub">
      <div>
        <div class="small">Admission</div>
        <h2>{{ .event.shortName }}</h2>
        <div class="when">{{ .event.date | formatDate "Jan 2, 2006" }}</div>

        <div class="seat">
          <div class="row">Sec · Row · Seat</div>
          <div class="val">{{ .seat.section }} · {{ .seat.row }} · {{ .seat.number }}</div>
        </div>
      </div>

      <div>
        <div class="bars">
          <div class="b" style="height:36px"></div><div class="b" style="height:24px"></div><div class="b" style="height:36px"></div>
          <div class="b" style="height:18px"></div><div class="b" style="height:36px"></div><div class="b" style="height:30px"></div>
          <div class="b" style="height:24px"></div><div class="b" style="height:36px"></div><div class="b" style="height:18px"></div>
          <div class="b" style="height:36px"></div><div class="b" style="height:24px"></div><div class="b" style="height:36px"></div>
          <div class="b" style="height:30px"></div><div class="b" style="height:18px"></div><div class="b" style="height:36px"></div>
        </div>
        <div class="barcode">{{ .ticket.id }}</div>
      </div>
    </div>
  </div>
</body>
</html>
`,
  sampleData: {
    event: {
      kind: "Concert",
      name: "Hollow & The Hours · Live in San Francisco",
      shortName: "Hollow & The Hours",
      presenter: "Riverbend Presents",
      date: "2026-09-18",
      doors: "7:00 PM",
      show: "8:00 PM",
    },
    venue: { name: "The Independent", city: "San Francisco, CA" },
    ticket: { id: "RB-2026-918-A0421", type: "GA + Reserved" },
    seat: { section: "Floor", row: "B", number: "14" },
    holder: { name: "Avery Johnson" },
  },
};
