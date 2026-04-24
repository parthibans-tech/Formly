import { importHtml } from "@/lib/doc/import";
import { JSDOM } from "jsdom";

const { DOMParser } = new JSDOM().window;
const parser = new DOMParser() as unknown as DOMParser;

// Try isolating the final <div class="sig"> block in various shapes.
const cases: Array<[string, string]> = [
  ["sig empty", `<div class="sig"></div>`],
  ["sig one line closed", `<div class="sig"><div class="line">a</div></div>`],
  ["sig line open only", `<div class="sig"><div class="line">a`],
  [
    "sig line with muted closed",
    `<div class="sig"><div class="line">a<div class="muted">b</div></div>`,
  ],
  [
    "sig line with muted, both closed",
    `<div class="sig"><div class="line">a<div class="muted">b</div></div></div>`,
  ],
  [
    "sig line only (k=16 equivalent)",
    `<div class="sig"><div class="line">\n{{ .company.signatory }}\n`,
  ],
  [
    "sig line + muted (k=17 equivalent)",
    `<div class="sig"><div class="line">\n{{ .company.signatory }}\n<div class="muted">{{ .company.signatoryTitle }}</div>\n</div>\n`,
  ],
  [
    "two adjacent fields",
    `<div class="muted">{{ .a.b }} · {{ .c.d }}</div>`,
  ],
];

for (const [label, frag] of cases) {
  const t0 = Date.now();
  try {
    const r = importHtml(frag, { parser });
    console.log(`OK  ${label}  dt=${Date.now() - t0}ms blocks=${r.doc.content.length}`);
  } catch (e) {
    console.log(`ERR ${label}  ${(e as Error).message}`);
  }
}
