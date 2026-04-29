// Typed wrapper for /v1/starters/ops/ai/sop — Standard Operating
// Procedure generator covering SOP / runbook / checklist starters.

import { api } from "./api";

export interface SOPRequest {
  task: string;
  audience?: string;
  constraints?: string[];
  includeRoles?: boolean;
}

export interface SOPStep {
  number: number;
  title: string;
  detail: string;
  tools?: string[];
  warningFlag?: boolean;
  warning?: string;
}

export interface SOPRole {
  role: string;
  responsibility: string;
}

export interface SOPResponse {
  title: string;
  purpose: string;
  scope?: string;
  prerequisites: string[];
  steps: SOPStep[];
  roles?: SOPRole[];
  successCriteria: string[];
  provider: string;
  model?: string;
}

export function generateSOP(body: SOPRequest): Promise<SOPResponse> {
  return api<SOPResponse>("/v1/starters/ops/ai/sop", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
