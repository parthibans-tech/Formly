import { offerLetterStarter } from "@/lib/starters/offer-letter";
import { importHtml } from "@/lib/doc/import";
import { JSDOM } from "jsdom";

const { DOMParser } = new JSDOM().window;
const parser = new DOMParser() as unknown as DOMParser;

// Bisect: try progressively larger prefixes of the offer-letter HTML to find
// the offending fragment.
const html = offerLetterStarter.html;

// Extract body content only to skip the head/style stuff.
const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
const body = bodyMatch ? bodyMatch[1] : html;

const pieces = body.split(/(?=<h[12]|<p|<div|<dl|<ul)/i);
console.log("pieces:", pieces.length);

for (let k = 1; k <= pieces.length; k++) {
  const frag = pieces.slice(0, k).join("");
  const t0 = Date.now();
  try {
    const r = importHtml(frag, { parser });
    const dt = Date.now() - t0;
    console.log(`k=${k} len=${frag.length} dt=${dt}ms blocks=${r.doc.content.length}`);
    if (dt > 2000) {
      console.log("SLOW FRAGMENT:\n" + frag);
      break;
    }
  } catch (e) {
    console.error("k=" + k + " FAILED:", (e as Error).message);
    break;
  }
}
