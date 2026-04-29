import type { Starter } from "./types";

export const sopStarter: Starter = {
  id: "sop",
  name: "Standard operating procedure",
  description:
    "Numbered SOP with purpose, scope, responsibilities, step-by-step instructions, and revision history.",
  category: "Operations",
  tags: ["sop", "process", "ops"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>SOP {{ .doc.number }}</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: Inter, system-ui, sans-serif; color: #111827; padding: 56px 64px; max-width: 820px; margin: auto; line-height: 1.55; }
    .head { border: 1px solid #d1d5db; border-radius: 8px; overflow: hidden; }
    .head .strip { display: flex; justify-content: space-between; padding: 10px 16px; background: #0f172a; color: white; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; font-weight: 700; }
    .head .body { padding: 18px 22px; }
    .head h1 { margin: 0; font-size: 22px; letter-spacing: -.01em; }
    .head .meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-top: 14px; font-size: 12px; }
    .head .meta b { display: block; color: #6b7280; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; margin-bottom: 2px; }
    h2 { font-size: 15px; margin: 28px 0 6px; padding-bottom: 4px; border-bottom: 2px solid #0f172a; letter-spacing: .02em; text-transform: uppercase; }
    p { margin: 0 0 12px; font-size: 14px; }
    ol.steps { padding: 0; margin: 8px 0 0; list-style: none; counter-reset: step; }
    ol.steps li { counter-increment: step; position: relative; padding: 10px 12px 10px 52px; background: #f9fafb; border-left: 3px solid #0f172a; margin-bottom: 8px; border-radius: 0 6px 6px 0; }
    ol.steps li::before { content: counter(step); position: absolute; left: 14px; top: 50%; transform: translateY(-50%); width: 24px; height: 24px; background: #0f172a; color: white; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; }
    ol.steps li b { display: block; font-size: 13px; }
    ol.steps li .detail { font-size: 13px; color: #4b5563; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
    th, td { padding: 9px 10px; border-bottom: 1px solid #e5e7eb; text-align: left; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; font-weight: 700; background: #f3f4f6; }
    .resp-list { margin: 0; padding-left: 18px; font-size: 14px; }
    .resp-list li { margin-bottom: 4px; }
  </style>
</head>
<body>
  <div class="head">
    <div class="strip">
      <span>SOP · {{ .doc.number }}</span>
      <span>v{{ .doc.version }}</span>
    </div>
    <div class="body">
      <h1>{{ .doc.title }}</h1>
      <div class="meta">
        <div><b>Department</b>{{ .doc.department }}</div>
        <div><b>Effective</b>{{ .doc.effectiveAt | formatDate "Jan 2, 2006" }}</div>
        <div><b>Owner</b>{{ .doc.owner }}</div>
        <div><b>Approver</b>{{ .doc.approver }}</div>
      </div>
    </div>
  </div>

  <h2>Purpose</h2>
  <p>{{ .purpose }}</p>

  <h2>Scope</h2>
  <p>{{ .scope }}</p>

  <h2>Responsibilities</h2>
  <ul class="resp-list">
    {{ range .responsibilities }}
    <li><b>{{ .role }}</b> — {{ .duty }}</li>
    {{ end }}
  </ul>

  <h2>Procedure</h2>
  <ol class="steps">
    {{ range .steps }}
    <li>
      <b>{{ .title }}</b>
      <div class="detail">{{ .detail }}</div>
    </li>
    {{ end }}
  </ol>

  <h2>Revision history</h2>
  <table>
    <thead>
      <tr><th>Version</th><th>Date</th><th>Author</th><th>Notes</th></tr>
    </thead>
    <tbody>
      {{ range .revisions }}
      <tr>
        <td>v{{ .version }}</td>
        <td>{{ .date | formatDate "Jan 2, 2006" }}</td>
        <td>{{ .author }}</td>
        <td>{{ .notes }}</td>
      </tr>
      {{ end }}
    </tbody>
  </table>
</body>
</html>
`,
  sampleData: {
    doc: {
      number: "OPS-014",
      title: "Inbound Shipment Receiving",
      department: "Warehouse Operations",
      version: "2.1",
      effectiveAt: "2026-04-01",
      owner: "Daniel Cho, Ops Manager",
      approver: "Margaret Liu, VP Operations",
    },
    purpose:
      "Define the standard process for receiving, inspecting, and putting away inbound shipments at all Northwind distribution centers, ensuring inventory accuracy and same-day stocking of priority SKUs.",
    scope:
      "Applies to all inbound deliveries — supplier shipments, inter-facility transfers, and customer returns — at DC-1 through DC-7 during normal operating hours.",
    responsibilities: [
      { role: "Receiving lead", duty: "Verifies paperwork, assigns dock door, oversees inspection." },
      { role: "Forklift operator", duty: "Unloads shipment, stages pallets in receiving zone." },
      { role: "QA inspector", duty: "Performs sample inspection per the QA matrix." },
      { role: "Inventory clerk", duty: "Reconciles received quantity against PO and posts to WMS." },
    ],
    steps: [
      { title: "Confirm appointment & paperwork", detail: "Driver presents BOL; receiving lead matches PO number, vendor, and expected SKUs in WMS." },
      { title: "Assign dock & unload", detail: "Direct truck to assigned door. Forklift operator unloads and stages pallets in zone R." },
      { title: "Inspect", detail: "QA inspector reviews seal integrity, count accuracy, and damage. Damaged pallets are quarantined to zone Q." },
      { title: "Reconcile to PO", detail: "Inventory clerk scans pallets; WMS flags variance. Discrepancies escalate to receiving lead." },
      { title: "Putaway", detail: "Approved pallets are tasked to putaway lanes per slotting plan. Priority SKUs (P1) are put away within 2 hours." },
      { title: "Close & file", detail: "Receiving lead signs BOL, files in receiving binder, and emails reconciliation summary to procurement." },
    ],
    revisions: [
      { version: "1.0", date: "2024-01-15", author: "D. Cho", notes: "Initial release." },
      { version: "2.0", date: "2025-08-02", author: "D. Cho", notes: "Added quarantine zone procedure." },
      { version: "2.1", date: "2026-04-01", author: "D. Cho", notes: "Updated WMS scan steps for new mobile app." },
    ],
  },
};
