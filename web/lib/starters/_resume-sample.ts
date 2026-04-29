// Shared sample-data and form-schema for all resume variants.  Every resume
// starter uses this exact shape so the design picker on the fill page can
// swap layouts without losing the user's data.

import type { FormSchema } from "./types";

export const RESUME_SAMPLE = {
  person: {
    name: "Maya Chen",
    title: "Senior Product Designer",
    email: "maya.chen@example.com",
    phone: "+1 (415) 555-0188",
    location: "San Francisco, CA",
    website: "mayachen.design",
  },
  summary:
    "Product designer with 8+ years shipping consumer and B2B SaaS at scale. Lead design for cross-functional teams, with deep experience in design systems, accessibility, and qualitative research. Hands-on prototyper who partners closely with engineering.",
  skills: [
    "Figma",
    "Design systems",
    "Prototyping",
    "User research",
    "Accessibility",
    "Design ops",
    "HTML / CSS",
  ],
  languages: [
    { name: "English", level: "Native" },
    { name: "Mandarin", level: "Fluent" },
    { name: "Spanish", level: "Conversational" },
  ],
  experience: [
    {
      title: "Senior Product Designer",
      company: "Lumen Labs",
      location: "San Francisco",
      when: "2022 — Present",
      highlights: [
        "Led design for the analytics platform redesign, growing weekly active users 38% in two quarters.",
        "Established the company's first design system, adopted by 12 product squads in six months.",
        "Mentored four junior designers; ran weekly critique and pairing sessions.",
      ],
    },
    {
      title: "Product Designer",
      company: "Northwind",
      location: "Seattle",
      when: "2018 — 2022",
      highlights: [
        "Owned end-to-end design for the onboarding funnel; lifted activation by 22%.",
        "Partnered with engineering to ship a component library used across three product surfaces.",
      ],
    },
  ],
  education: [
    {
      degree: "B.F.A., Interaction Design",
      school: "California College of the Arts",
      when: "2014 — 2018",
    },
  ],
};

export const RESUME_SCHEMA: FormSchema = {
  groups: [
    {
      kind: "object",
      id: "person",
      label: "Personal info",
      path: "person",
      fields: [
        { id: "name", label: "Full name", type: "text" },
        { id: "title", label: "Headline", type: "text", placeholder: "e.g. Senior Product Designer" },
        { id: "email", label: "Email", type: "email" },
        { id: "phone", label: "Phone", type: "tel" },
        { id: "location", label: "Location", type: "text" },
        { id: "website", label: "Website", type: "url", optional: true },
      ],
    },
    {
      kind: "scalar",
      id: "summary",
      label: "Summary",
      path: "summary",
      type: "longtext",
      placeholder: "A short paragraph about your experience and strengths.",
    },
    {
      kind: "string-list",
      id: "skills",
      label: "Skills",
      path: "skills",
      itemPlaceholder: "Skill (e.g. Figma)",
    },
    {
      kind: "object-list",
      id: "experience",
      label: "Experience",
      path: "experience",
      itemLabel: "{title} — {company}",
      newItem: { title: "", company: "", location: "", when: "", highlights: [""] },
      fields: [
        { id: "title", label: "Job title", type: "text" },
        { id: "company", label: "Company", type: "text" },
        { id: "location", label: "Location", type: "text" },
        { id: "when", label: "When", type: "text", placeholder: "2022 — Present" },
        { id: "highlights", label: "Highlights", type: "string-list", itemPlaceholder: "Achievement or responsibility" },
      ],
    },
    {
      kind: "object-list",
      id: "education",
      label: "Education",
      path: "education",
      itemLabel: "{degree}",
      newItem: { degree: "", school: "", when: "" },
      fields: [
        { id: "degree", label: "Degree", type: "text" },
        { id: "school", label: "School", type: "text" },
        { id: "when", label: "When", type: "text", placeholder: "2014 — 2018" },
      ],
    },
    {
      kind: "object-list",
      id: "languages",
      label: "Languages",
      path: "languages",
      itemLabel: "{name}",
      newItem: { name: "", level: "" },
      fields: [
        { id: "name", label: "Language", type: "text" },
        { id: "level", label: "Level", type: "text", placeholder: "Native / Fluent / Conversational" },
      ],
    },
  ],
};
