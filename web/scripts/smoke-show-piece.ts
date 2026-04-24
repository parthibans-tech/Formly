import { offerLetterStarter } from "@/lib/starters/offer-letter";

const html = offerLetterStarter.html;
const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
const body = bodyMatch ? bodyMatch[1] : html;
const pieces = body.split(/(?=<h[12]|<p|<div|<dl|<ul)/i);

const i = parseInt(process.argv[2] || "16", 10);
console.log("piece index:", i, "of", pieces.length);
console.log("--- piece ---");
console.log(pieces[i]);
console.log("--- end ---");
console.log("len:", pieces[i].length);
