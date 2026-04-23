import type { Starter } from "./types";

// Kept so the browser dialog can offer "Start blank" alongside starters.
export const blankStarter: Starter = {
  id: "blank",
  name: "Blank",
  description: "Start from an empty document.",
  category: "Commerce",
  tags: ["blank"],
  html: `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>{{ .title }}</title>
    <style>body { font-family: Inter, system-ui, sans-serif; padding: 48px; color: #111; }</style>
  </head>
  <body>
    <h1>Hello, {{ .name }}</h1>
    <p>Start writing your template…</p>
  </body>
</html>
`,
  sampleData: { title: "Untitled", name: "Ada" },
};
