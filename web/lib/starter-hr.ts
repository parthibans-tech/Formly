// Typed wrappers for /v1/starters/hr/ai/* — JD, performance review,
// and PIP draft generation.

import { api } from "./api";

// -- JD -------------------------------------------------------------------

export interface JDRequest {
  role: string;
  level?: "intern" | "jr" | "mid" | "sr" | "staff" | "principal";
  company?: string;
  location?: string;
  mode?: "remote" | "hybrid" | "onsite";
  mustHaves?: string[];
  niceToHave?: string[];
}

export interface JDResponse {
  title: string;
  summary: string;
  responsibilities: string[];
  requirements: string[];
  niceToHave: string[];
  benefits: string[];
  provider: string;
  model?: string;
}

export function generateJD(body: JDRequest): Promise<JDResponse> {
  return api<JDResponse>("/v1/starters/hr/ai/jd", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// -- Performance Review --------------------------------------------------

export interface PerfReviewRequest {
  employee: string;
  role?: string;
  period?: string;
  tone?: "candid" | "encouraging" | "balanced";
  facts?: Record<string, unknown>;
}

export interface PerfReviewResponse {
  strengths: string[];
  growthAreas: string[];
  overallNarrative: string;
  rating?: "exceeds" | "meets" | "below" | "";
  provider: string;
  model?: string;
}

export function generatePerfReview(
  body: PerfReviewRequest,
): Promise<PerfReviewResponse> {
  return api<PerfReviewResponse>("/v1/starters/hr/ai/perf-review", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// -- PIP -----------------------------------------------------------------

export interface PIPRequest {
  employee: string;
  role?: string;
  issues: string[];
  durationWeeks?: number; // default 4, capped at 26
}

export interface PIPMilestone {
  weekFrom: number;
  weekTo: number;
  goal: string;
  measure: string;
}

export interface PIPResponse {
  summary: string;
  expectations: string[];
  milestones: PIPMilestone[];
  successCriteria: string[];
  consequences: string;
  durationWeeks: number;
  provider: string;
  model?: string;
}

export function generatePIP(body: PIPRequest): Promise<PIPResponse> {
  return api<PIPResponse>("/v1/starters/hr/ai/pip", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
