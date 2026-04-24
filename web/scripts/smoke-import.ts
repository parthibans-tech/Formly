/**
 * Smoke test for the HTML→AST importer.
 *
 * Runs each entry in the starter library through `importHtml`, then
 * renders the resulting AST via `renderDoc` using the starter's own
 * sampleData, and sanity-checks the output.  Failures log which starter
 * regressed and a short diff.
 *
 * Usage:
 *   cd web && ./node_modules/.bin/tsx scripts/smoke-import.ts
 */

import { STARTERS } from "@/lib/starters";
import { importHtml } from "@/lib/doc/import";
import { renderDoc } from "@/lib/doc/render";
import { JSDOM } from "jsdom";

const { DOMParser } = new JSDOM().window;
const parser = new DOMParser();

function stats(doc: ReturnType<typeof importHtml>["doc"]) {
  let headings = 0;
  let paragraphs = 0;
  let fields = 0;
  let repeats = 0;
  let ifs = 0;
  let tables = 0;
  let raws = 0;
  function walk(blocks: unknown): void {
    if (!Array.isArray(blocks)) return;
    for (const b of blocks as Array<Record<string, unknown>>) {
      switch (b.type) {
        case "heading":
          headings++;
          break;
        case "paragraph":
          paragraphs++;
          countFields(b.content as unknown[]);
          break;
        case "table":
          tables++;
          break;
        case "repeat":
          repeats++;
          walk(b.children);
          break;
        case "if":
          ifs++;
          walk(b.children);
          walk(b.else as unknown[]);
          break;
        case "raw":
          raws++;
          break;
      }
    }
  }
  function countFields(inl: unknown[]): void {
    if (!Array.isArray(inl)) return;
    for (const i of inl as Array<Record<string, unknown>>) {
      if (i.type === "field") fields++;
    }
  }
  walk(doc.content);
  return { headings, paragraphs, fields, repeats, ifs, tables, raws };
}

async function main() {
  let failures = 0;
  for (const s of STARTERS) {
    const res = importHtml(s.html, { parser: parser as unknown as DOMParser });
    const rend = renderDoc(res.doc, { data: s.sampleData });
    const outline = stats(res.doc);
    console.log(`── ${s.id} ────────────────────────────────────────────────`);
    console.log("  blocks:", res.doc.content.length);
    console.log("  outline:", outline);
    console.log("  import diagnostics:", res.diagnostics.length);
    for (const d of res.diagnostics) {
      console.log(`    [${d.severity}] ${d.message}`);
    }
    console.log("  render diagnostics:", rend.diagnostics.length);
    for (const d of rend.diagnostics.slice(0, 5)) {
      console.log(`    [${d.severity}] ${d.message}`);
    }
    console.log("  html preview (first 200 chars):");
    console.log("    " + rend.html.replace(/\s+/g, " ").slice(0, 200));

    // Sanity: at least SOME content came through.
    if (res.doc.content.length === 0) {
      console.error(`  ✗ ${s.id}: no blocks`);
      failures++;
    }
    if (outline.fields === 0 && /\{\{\s*\./.test(s.html)) {
      console.error(`  ✗ ${s.id}: template had fields but none imported`);
      failures++;
    }
  }
  console.log("");
  if (failures > 0) {
    console.error(`FAILURES: ${failures}`);
    process.exit(1);
  }
  console.log("All starters imported.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
