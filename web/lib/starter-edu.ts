// Typed wrapper for /v1/starters/edu/ai/syllabus — course outline
// generator for Education-category starters (syllabus, course outline,
// lesson plan, study guide).

import { api } from "./api";

export interface SyllabusRequest {
  course: string;
  level?: "highschool" | "undergrad" | "grad" | "adult-ed" | string;
  weeks?: number; // default 14
  hoursPerWeek?: number; // default 3
  outcomes?: string[];
}

export interface SyllabusModule {
  week: number;
  title: string;
  topics: string[];
  readings?: string[];
  activity?: string;
}

export interface SyllabusAssessment {
  name: string;
  type: "homework" | "quiz" | "midterm" | "final" | "project";
  weight: number;
  week?: number;
}

export interface SyllabusResponse {
  course: string;
  description: string;
  outcomes: string[];
  prerequisites: string[];
  modules: SyllabusModule[];
  assessments: SyllabusAssessment[];
  policies?: string[];
  provider: string;
  model?: string;
}

export function generateSyllabus(
  body: SyllabusRequest,
): Promise<SyllabusResponse> {
  return api<SyllabusResponse>("/v1/starters/edu/ai/syllabus", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
