// Typed wrappers for the /v1/starters/* endpoints exposed by the
// `starterai` Go package. Mirrors the field names + shapes verbatim so
// a `?` here matches a `,omitempty` on the server.
//
// All five endpoints go through the shared `api()` helper which:
//
//   - prepends NEXT_PUBLIC_API_URL
//   - attaches the bearer token from localStorage
//   - normalises errors into ApiError so callers can branch on
//     err.code (e.g. "ai_disabled", "render_failed") in toasts.
//
// Keep these functions as thin pass-throughs — call sites in
// fill-page.tsx do all the UX glue (loading states, mutating form
// data, navigation).

import { api } from "./api";

// -- profile summary ------------------------------------------------------

export interface ProfileSummaryRequest {
  starterId: string;
  data: Record<string, unknown>;
  tone?: "confident" | "neutral" | "warm";
  length?: "short" | "medium" | "long";
  targetRole?: string;
}

export interface ProfileSummaryResponse {
  summary: string;
  alternatives: string[];
  provider: string;
  model?: string;
}

export function generateProfileSummary(
  body: ProfileSummaryRequest,
): Promise<ProfileSummaryResponse> {
  return api<ProfileSummaryResponse>("/v1/starters/ai/profile-summary", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// -- cover letter ---------------------------------------------------------

export interface JobPosting {
  company?: string;
  title?: string;
  description?: string;
  url?: string;
}

export interface CoverLetterRequest {
  starterId: string;
  data: Record<string, unknown>;
  job?: JobPosting;
  tone?: "confident" | "neutral" | "warm";
  length?: "short" | "medium" | "long";
  format?: "html" | "markdown" | "plain";
}

export interface CoverLetterPayload {
  greeting: string;
  body: string;
  closing: string;
  format: "html" | "markdown" | "plain";
}

export interface CoverLetterResponse {
  coverLetter: CoverLetterPayload;
  starterId: string; // always "cover-letter"
  starterData: Record<string, unknown>;
  provider: string;
  model?: string;
}

export function generateCoverLetter(
  body: CoverLetterRequest,
): Promise<CoverLetterResponse> {
  return api<CoverLetterResponse>("/v1/starters/ai/cover-letter", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// -- review ---------------------------------------------------------------

export interface ReviewRequest {
  starterId: string;
  data: Record<string, unknown>;
  targetRole?: string;
}

export type ReviewStatus = "good" | "warn" | "fail";

export interface ReviewSuggestion {
  path: string;
  before: string;
  after: string;
}

export interface ReviewSection {
  id: string;
  label: string;
  status: ReviewStatus;
  notes: string;
  suggestions?: ReviewSuggestion[];
  missingKeywords?: string[];
}

export interface ReviewResponse {
  score: number;
  verdict: string;
  sections: ReviewSection[];
  provider: string;
  model?: string;
}

export function reviewResume(body: ReviewRequest): Promise<ReviewResponse> {
  return api<ReviewResponse>("/v1/starters/ai/review", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// -- export ---------------------------------------------------------------

export interface LayoutHints {
  pageSize?: "Letter" | "A4" | "Legal" | "A3" | "A5";
  orientation?: "portrait" | "landscape";
  marginIn?: number;
}

export interface ExportRequest {
  html: string;
  data: Record<string, unknown>;
  customize?: Record<string, unknown>;
  format?: "pdf" | "html";
  filename?: string;
  layout?: LayoutHints;
}

export interface ExportResponse {
  url: string;
  expiresAt: string;
  size: number;
  filename: string;
  format: "pdf" | "html";
}

export function exportStarter(
  starterId: string,
  body: ExportRequest,
): Promise<ExportResponse> {
  return api<ExportResponse>(
    `/v1/starters/${encodeURIComponent(starterId)}/export`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

// -- save to drive --------------------------------------------------------

export interface SaveToDriveRequest extends ExportRequest {
  folderId?: string;
}

export interface SaveToDriveResponse {
  fileId: string;
  filename: string;
  url: string; // /drive/d/{fileId}
  size: number;
}

export function saveStarterToDrive(
  starterId: string,
  body: SaveToDriveRequest,
): Promise<SaveToDriveResponse> {
  return api<SaveToDriveResponse>(
    `/v1/starters/${encodeURIComponent(starterId)}/save-to-drive`,
    { method: "POST", body: JSON.stringify(body) },
  );
}
