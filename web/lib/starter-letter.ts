// Typed wrapper for /v1/starters/letters/ai/rewrite — tone/format
// rewrite for Correspondence-category starters.

import { api } from "./api";

export interface RewriteRequest {
  body: string;
  goal: string;
  tone?: "friendly" | "formal" | "direct" | "apologetic" | "neutral";
  format?: "html" | "markdown" | "plain";
}

export interface RewriteResponse {
  body: string;
  notes: string[];
  format: "html" | "markdown" | "plain";
  provider: string;
  model?: string;
}

export function rewriteLetter(body: RewriteRequest): Promise<RewriteResponse> {
  return api<RewriteResponse>("/v1/starters/letters/ai/rewrite", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
