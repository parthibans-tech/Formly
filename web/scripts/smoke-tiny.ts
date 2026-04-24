/**
 * Minimal importer repro to isolate issues.
 */
import { importHtml } from "@/lib/doc/import";
import { JSDOM } from "jsdom";

const { DOMParser } = new JSDOM().window;
const parser = new DOMParser() as unknown as DOMParser;

function run(label: string, html: string) {
  console.log(`\n── ${label} ────────────────`);
  const r = importHtml(html, { parser });
  console.log("  blocks:", r.doc.content.length);
  console.log("  diagnostics:", r.diagnostics.length);
  console.log("  content:", JSON.stringify(r.doc.content, null, 2).slice(0, 400));
}

run("plain p", `<p>Hello</p>`);
run("field", `<p>Total: {{ .invoice.total }}</p>`);
run("formatted field", `<p>Total: {{ .invoice.total | formatCurrency "USD" }}</p>`);
run("if", `<p>Hello</p>{{ if .paid }}<p>PAID</p>{{ end }}`);
run("if else", `{{ if .paid }}<p>PAID</p>{{ else }}<p>due</p>{{ end }}`);
run("range", `{{ range .items }}<p>{{ .name }}</p>{{ end }}`);
run("heading", `<h1>Invoice {{ .invoice.number }}</h1>`);

console.log("\nDONE");
