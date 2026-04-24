import { STARTERS, BLANK_STARTER } from "@/lib/starters";
import { importHtml } from "@/lib/doc/import";
import { JSDOM } from "jsdom";

const { DOMParser } = new JSDOM().window;
const parser = new DOMParser() as unknown as DOMParser;

const id = process.argv[2];
const starter = id === "blank" ? BLANK_STARTER : STARTERS.find((s) => s.id === id);
if (!starter) {
  console.error("not found:", id);
  process.exit(1);
}
console.log("starter:", starter.id, "/", starter.name, "- html length:", starter.html.length);
const t0 = Date.now();
const r = importHtml(starter.html, { parser });
console.log("took", Date.now() - t0, "ms");
console.log("blocks:", r.doc.content.length);
console.log("diagnostics:", r.diagnostics.length);
for (const d of r.diagnostics) console.log(" -", d.severity, d.message);
