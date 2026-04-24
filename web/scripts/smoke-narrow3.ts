import { importHtml } from "@/lib/doc/import";
import { JSDOM } from "jsdom";

const { DOMParser } = new JSDOM().window;
const parser = new DOMParser() as unknown as DOMParser;

function run(label: string, frag: string) {
  const t0 = Date.now();
  try {
    const r = importHtml(frag, { parser });
    console.log(`OK ${label}  dt=${Date.now() - t0}ms blocks=${r.doc.content.length}`);
  } catch (e) {
    console.log(`ERR ${label}  ${(e as Error).message}`);
  }
}

run("1", `<div>a</div>`);
run("2", `<div>{{ .x }}</div>`);
run("3", `<div>a<b>bb</b></div>`);
run("4", `<div><div>a</div></div>`);
run("5", `<div>a<div>b</div></div>`);
run("6", `<div>{{ .x }}<div>b</div></div>`);
run("7", `<div>a<div>{{ .y }}</div></div>`);
run("8", `<div>{{ .x }}<div>{{ .y }}</div></div>`);
