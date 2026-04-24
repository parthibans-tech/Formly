import { importHtml } from "@/lib/doc/import";
import { JSDOM } from "jsdom";

const { DOMParser } = new JSDOM().window;
const parser = new DOMParser() as unknown as DOMParser;

const cases: Array<[string, string]> = [
  ["a", `<div class="line">{{ .x }}<div class="muted">{{ .y }}</div></div>`],
  ["b", `<div class="line">a<div class="muted">b</div></div>`],
  ["c", `<div class="line">{{ .x }}<div>{{ .y }}</div></div>`],
  ["d", `<div>{{ .x }}<div>{{ .y }}</div></div>`],
  ["e", `<div>x<div>y</div></div>`],
  ["f", `<div>{{ .x }}<div>y</div></div>`],
  ["g", `<div>a<div>{{ .y }}</div></div>`],
  ["h", `<p>{{ .x }}<div>{{ .y }}</div></p>`],
];

for (const [label, frag] of cases) {
  const t0 = Date.now();
  try {
    const r = importHtml(frag, { parser });
    console.log(`OK ${label}  dt=${Date.now() - t0}ms blocks=${r.doc.content.length}`);
  } catch (e) {
    console.log(`ERR ${label}  ${(e as Error).message}`);
  }
}
