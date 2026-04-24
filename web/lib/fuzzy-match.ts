// Lightweight fuzzy matcher — scores candidate strings against a query by
// combining Levenshtein distance and trigram overlap. Used to suggest
// dataKey ↔ sample-JSON-path pairings in the AcroForm Designer auto-map
// dialog.

export type Match = {
  candidate: string;
  score: number; // 0..1, 1 = perfect match
};

export function scoreMatch(query: string, candidate: string): number {
  if (!query || !candidate) return 0;
  const q = normalize(query);
  const c = normalize(candidate);
  if (q === c) return 1;
  if (c.includes(q) || q.includes(c)) return 0.92;

  const lev = levenshtein(q, c);
  const maxLen = Math.max(q.length, c.length) || 1;
  const levScore = 1 - lev / maxLen;

  const tri = trigramOverlap(q, c);

  // Token-level overlap (split by non-alnum); rewards e.g. "first_name" vs "firstName".
  const qTokens = tokenize(q);
  const cTokens = tokenize(c);
  const tokenOverlap = tokenSetOverlap(qTokens, cTokens);

  return clamp(0.45 * levScore + 0.35 * tri + 0.20 * tokenOverlap, 0, 1);
}

export function bestMatches(
  query: string,
  candidates: string[],
  limit = 3
): Match[] {
  const scored = candidates.map((c) => ({
    candidate: c,
    score: scoreMatch(query, c),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// Flatten a JSON value to a map of dot-paths → leaf value.
// { a: { b: 1 }, c: [10, 20] } → { "a.b": 1, "c[0]": 10, "c[1]": 20 }
export function flattenPaths(
  input: unknown,
  prefix = ""
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input === null || input === undefined) {
    if (prefix) out[prefix] = input;
    return out;
  }
  if (Array.isArray(input)) {
    input.forEach((v, i) => {
      Object.assign(out, flattenPaths(v, `${prefix}[${i}]`));
    });
    return out;
  }
  if (typeof input === "object") {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      Object.assign(out, flattenPaths(v, path));
    }
    return out;
  }
  if (prefix) out[prefix] = input;
  return out;
}

// --- helpers ---

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tokenize(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

function tokenSetOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function trigrams(s: string): Set<string> {
  const pad = `  ${s}  `;
  const out = new Set<string>();
  for (let i = 0; i <= pad.length - 3; i++) out.add(pad.slice(i, i + 3));
  return out;
}

function trigramOverlap(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
