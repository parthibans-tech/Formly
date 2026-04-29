// Typed wrappers for /v1/starters/reports/ai/* — extract action items
// and summarise long status documents.

import { api } from "./api";

// -- extract actions -----------------------------------------------------

export interface ExtractActionsRequest {
  source?: "minutes" | "transcript" | "notes" | string;
  text: string;
}

export interface ActionItem {
  owner?: string;
  task: string;
  dueDate?: string;
  notes?: string;
}

export interface ExtractActionsResponse {
  actions: ActionItem[];
  provider: string;
  model?: string;
}

export function extractActions(
  body: ExtractActionsRequest,
): Promise<ExtractActionsResponse> {
  return api<ExtractActionsResponse>("/v1/starters/reports/ai/extract-actions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// -- summarize -----------------------------------------------------------

export interface SummarizeRequest {
  text: string;
  audience?: "exec" | "team" | "client";
  length?: "brief" | "medium" | "bullets";
}

export interface SummarizeResponse {
  summary: string;
  highlights: string[];
  risks: string[];
  provider: string;
  model?: string;
}

export function summarizeReport(
  body: SummarizeRequest,
): Promise<SummarizeResponse> {
  return api<SummarizeResponse>("/v1/starters/reports/ai/summarize", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
