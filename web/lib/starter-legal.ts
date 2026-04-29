// Typed wrappers for /v1/starters/legal/* — clause explain, clause
// suggest, and the pure-function redline tree-diff.

import { api } from "./api";

// -- explain --------------------------------------------------------------

export interface ExplainRequest {
  starterId?: string;
  clause: string;
  audience?: "layperson" | "counsel";
  jurisdiction?: string;
}

export interface ExplainRisk {
  severity: "low" | "med" | "high";
  note: string;
}

export interface ExplainResponse {
  plain: string;
  bullets: string[];
  risks: ExplainRisk[];
  provider: string;
  model?: string;
}

export function explainClause(body: ExplainRequest): Promise<ExplainResponse> {
  return api<ExplainResponse>("/v1/starters/legal/ai/explain", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// -- clause suggest -------------------------------------------------------

export interface ClauseSuggestRequest {
  starterId?: string;
  topic: string;
  context?: string;
  style?: "formal" | "plain";
}

export interface ClauseDraft {
  heading: string;
  body: string;
}

export interface ClauseSuggestResponse {
  clauses: ClauseDraft[];
  provider: string;
  model?: string;
}

export function suggestClause(
  body: ClauseSuggestRequest,
): Promise<ClauseSuggestResponse> {
  return api<ClauseSuggestResponse>("/v1/starters/legal/ai/clause-suggest", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// -- redline (pure tree diff) --------------------------------------------

export interface RedlineRequest {
  starterId?: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export type RedlineOp = "add" | "remove" | "change";

export interface RedlineChange {
  op: RedlineOp;
  path: string;
  before?: unknown;
  after?: unknown;
}

export interface RedlineCounts {
  added: number;
  removed: number;
  changed: number;
}

export interface RedlineResponse {
  changes: RedlineChange[];
  counts: RedlineCounts;
}

export function redline(body: RedlineRequest): Promise<RedlineResponse> {
  return api<RedlineResponse>("/v1/starters/legal/redline", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
