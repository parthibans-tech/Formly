// Typed wrappers for /v1/starters/marketing/ai/* — section drafts
// and headline candidate generator.

import { api } from "./api";

// -- section --------------------------------------------------------------

export interface SectionRequest {
  name: string; // hero | features | cta | about | testimonial | pricing | ...
  brief: string;
  audience?: string;
  tone?: "bold" | "friendly" | "technical" | "playful";
}

export interface SectionResponse {
  heading: string;
  subheading?: string;
  body: string;
  bullets?: string[];
  cta?: string;
  provider: string;
  model?: string;
}

export function generateSection(
  body: SectionRequest,
): Promise<SectionResponse> {
  return api<SectionResponse>("/v1/starters/marketing/ai/section", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// -- headline -------------------------------------------------------------

export interface HeadlineRequest {
  brief: string;
  count?: number; // default 8, capped at 20
  style?: "punchy" | "benefit-led" | "curiosity";
}

export interface HeadlineResponse {
  headlines: string[];
  provider: string;
  model?: string;
}

export function generateHeadlines(
  body: HeadlineRequest,
): Promise<HeadlineResponse> {
  return api<HeadlineResponse>("/v1/starters/marketing/ai/headline", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
