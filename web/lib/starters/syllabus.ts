import type { Starter } from "./types";

export const syllabusStarter: Starter = {
  id: "syllabus",
  name: "Course syllabus",
  description:
    "University course syllabus with description, learning outcomes, schedule, and grading.",
  category: "Education",
  tags: ["syllabus", "course", "education"],
  html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{{ .course.code }} — {{ .course.title }}</title>
  <style>
    @page { size: Letter; margin: 0; }
    body { font-family: "Source Serif Pro", Georgia, serif; color: #1f2937; padding: 60px 64px; max-width: 820px; margin: auto; line-height: 1.55; }
    .head { padding-bottom: 14px; border-bottom: 3px double #1f2937; }
    .code { font-family: Inter, sans-serif; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #6b7280; font-weight: 700; }
    h1 { font-size: 28px; margin: 4px 0 4px; letter-spacing: -.01em; line-height: 1.15; }
    .term { font-size: 13px; color: #6b7280; }
    .meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; margin: 18px 0 4px; font-size: 13px; font-family: Inter, sans-serif; }
    .meta b { display: block; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: #6b7280; margin-bottom: 2px; font-weight: 700; }
    h2 { font-size: 16px; margin: 28px 0 8px; font-family: Inter, sans-serif; letter-spacing: .04em; text-transform: uppercase; color: #1f2937; border-bottom: 1px solid #d1d5db; padding-bottom: 4px; }
    p { margin: 0 0 12px; font-size: 14px; }
    ol, ul { font-size: 14px; padding-left: 22px; margin: 6px 0 0; }
    ol li, ul li { margin-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; font-family: Inter, sans-serif; font-size: 13px; }
    th, td { padding: 9px 10px; border-bottom: 1px solid #e5e7eb; text-align: left; vertical-align: top; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; font-weight: 700; }
    .grading { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 8px; }
    .grading .row { display: flex; justify-content: space-between; padding: 8px 12px; background: #f9fafb; border-radius: 6px; font-family: Inter, sans-serif; font-size: 13px; }
    .grading .row b { font-weight: 600; }
  </style>
</head>
<body>
  <div class="head">
    <div class="code">{{ .course.code }} · {{ .course.credits }} credits</div>
    <h1>{{ .course.title }}</h1>
    <div class="term">{{ .course.term }} · {{ .course.institution }}</div>
    <div class="meta">
      <div><b>Instructor</b>{{ .instructor.name }} ({{ .instructor.email }})</div>
      <div><b>Office hours</b>{{ .instructor.officeHours }}</div>
      <div><b>Meets</b>{{ .schedule.meets }}</div>
      <div><b>Location</b>{{ .schedule.location }}</div>
    </div>
  </div>

  <h2>Course description</h2>
  <p>{{ .description }}</p>

  <h2>Learning outcomes</h2>
  <p>By the end of this course, students will be able to:</p>
  <ol>
    {{ range .outcomes }}
    <li>{{ . }}</li>
    {{ end }}
  </ol>

  <h2>Required materials</h2>
  <ul>
    {{ range .materials }}
    <li>{{ . }}</li>
    {{ end }}
  </ul>

  <h2>Schedule</h2>
  <table>
    <thead><tr><th>Week</th><th>Topic</th><th>Readings</th><th>Due</th></tr></thead>
    <tbody>
      {{ range .schedule.weeks }}
      <tr>
        <td><b>{{ .week }}</b></td>
        <td>{{ .topic }}</td>
        <td>{{ .readings }}</td>
        <td>{{ .due }}</td>
      </tr>
      {{ end }}
    </tbody>
  </table>

  <h2>Grading</h2>
  <div class="grading">
    {{ range .grading }}
    <div class="row"><span>{{ .item }}</span><b>{{ .weight }}</b></div>
    {{ end }}
  </div>

  <h2>Policies</h2>
  <p>{{ .policies }}</p>
</body>
</html>
`,
  sampleData: {
    course: {
      code: "CS 240",
      title: "Introduction to Human-Computer Interaction",
      credits: 4,
      term: "Spring 2026",
      institution: "Westbrook University",
    },
    instructor: {
      name: "Dr. Elena Marquez",
      email: "emarquez@westbrook.example",
      officeHours: "Tu/Th 2:00–3:30 PM, Bowen Hall 314",
    },
    schedule: {
      meets: "M/W 10:00–11:50 AM",
      location: "Lockwood Lab 102",
      weeks: [
        { week: "1", topic: "Foundations & history of HCI", readings: "Norman Ch. 1–2", due: "—" },
        { week: "2", topic: "User research & interviews", readings: "Portigal Ch. 1–4", due: "—" },
        { week: "3", topic: "Sketching & rapid prototyping", readings: "Buxton Ch. 5", due: "P1: Sketches" },
        { week: "4", topic: "Heuristic evaluation", readings: "Nielsen 1994", due: "—" },
        { week: "5", topic: "Information architecture", readings: "Rosenfeld Ch. 4", due: "P2: IA exercise" },
        { week: "6", topic: "Visual design & typography", readings: "Lupton Ch. 2", due: "—" },
        { week: "7", topic: "Midterm review & critique", readings: "Studio readings", due: "Midterm project" },
        { week: "8", topic: "Accessibility & inclusive design", readings: "Holmes Ch. 1–3", due: "—" },
        { week: "9", topic: "Mobile & touch interfaces", readings: "Selected papers", due: "P3: A11y audit" },
        { week: "10", topic: "Evaluation methods & analytics", readings: "Lazar Ch. 3", due: "—" },
        { week: "11", topic: "Conversational & voice UI", readings: "Pearl Ch. 1–4", due: "—" },
        { week: "12", topic: "Ethics in design", readings: "Costanza-Chock", due: "Final proposal" },
        { week: "13", topic: "Final studio", readings: "—", due: "—" },
        { week: "14", topic: "Final critique & wrap-up", readings: "—", due: "Final project" },
      ],
    },
    description:
      "This course introduces the principles, methods, and craft of human-computer interaction. Students learn to research user needs, generate and prototype design alternatives, and evaluate them through heuristic and empirical methods. The course is studio-driven: most weeks include hands-on work that culminates in a portfolio-ready final project.",
    outcomes: [
      "Conduct user research and synthesize insights into design opportunities.",
      "Generate and critique multiple design alternatives at appropriate levels of fidelity.",
      "Apply established usability heuristics and accessibility standards to evaluate designs.",
      "Communicate design rationale clearly through writing, sketches, and presentations.",
      "Reflect on the social and ethical implications of interactive systems.",
    ],
    materials: [
      "Norman, *The Design of Everyday Things* (revised edition).",
      "Portigal, *Interviewing Users* (2nd edition).",
      "Selected papers posted to the course site weekly.",
      "Sketchbook & blank index cards (provided).",
    ],
    grading: [
      { item: "Studio projects (×3)", weight: "30%" },
      { item: "Midterm project", weight: "20%" },
      { item: "Final project", weight: "30%" },
      { item: "Critique participation", weight: "10%" },
      { item: "Reading responses", weight: "10%" },
    ],
    policies:
      "Late work loses 10% per day for up to 3 days; after that it is not accepted without prior arrangement. Generative AI may be used for ideation and editing but not for the analysis or final design itself — disclose all AI assistance in your project log. Accommodations are arranged through the Student Accessibility Office.",
  },
};
