import { offerLetterStarter } from "@/lib/starters/offer-letter";

const html = offerLetterStarter.html;
const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
const body = bodyMatch ? bodyMatch[1] : html;
const pieces = body.split(/(?=<h[12]|<p|<div|<dl|<ul)/i);

const k = parseInt(process.argv[2] || "17", 10);
const frag = pieces.slice(0, k).join("");
console.log("k:", k);
console.log("--- frag ---");
console.log(frag);
console.log("--- end ---");
console.log("len:", frag.length);
