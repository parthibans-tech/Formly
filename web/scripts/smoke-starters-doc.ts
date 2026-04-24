/**
 * Verify getStarterDoc() works for every starter — this is the entry
 * point Phase 4 will call at template-creation time.
 */
import { STARTERS, BLANK_STARTER, getStarterDoc } from "@/lib/starters";
import { JSDOM } from "jsdom";

const { DOMParser } = new JSDOM().window;
const parser = new DOMParser() as unknown as DOMParser;

for (const s of [BLANK_STARTER, ...STARTERS]) {
  const t0 = Date.now();
  const { stored, diagnostics } = getStarterDoc(s, { parser });
  const dt = Date.now() - t0;
  const themeLen = stored.themeCss?.length ?? 0;
  console.log(
    `${s.id.padEnd(14)} v${stored.version} blocks=${stored.doc.content.length} diagnostics=${diagnostics.length} themeCss=${themeLen}B dt=${dt}ms`,
  );
}
