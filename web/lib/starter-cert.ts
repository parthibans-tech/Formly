// Typed wrapper for /v1/starters/certificates/ai/citation — formal
// citation copywriter for Achievement / Completion / Recognition
// certificate starters.

import { api } from "./api";

export interface CitationRequest {
  recipient: string;
  reason: string;
  style?: "formal" | "warm";
  length?: "short" | "medium";
}

export interface CitationResponse {
  citation: string;
  alternatives: string[];
  provider: string;
  model?: string;
}

export function generateCitation(
  body: CitationRequest,
): Promise<CitationResponse> {
  return api<CitationResponse>("/v1/starters/certificates/ai/citation", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
