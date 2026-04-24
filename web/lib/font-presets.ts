// Typography presets and font-family catalogue for the static PDF designer.
// Presets apply a curated set of style props to the selected widget; the
// font family list is restricted to the 14 built-in PDF fonts that every
// PDF viewer must support so generated documents look identical everywhere.

export type TypographyPreset = {
  id: string;
  label: string;
  props: {
    fontSize: number;
    fontFamily: string;
    bold?: boolean;
    italic?: boolean;
    color?: string;
    lineHeight?: number;
  };
};

export const TYPOGRAPHY_PRESETS: TypographyPreset[] = [
  {
    id: "h1",
    label: "H1",
    props: { fontSize: 22, fontFamily: "Helvetica", bold: true, color: "#111827" },
  },
  {
    id: "h2",
    label: "H2",
    props: { fontSize: 16, fontFamily: "Helvetica", bold: true, color: "#111827" },
  },
  {
    id: "h3",
    label: "H3",
    props: { fontSize: 13, fontFamily: "Helvetica", bold: true, color: "#374151" },
  },
  {
    id: "body",
    label: "Body",
    props: { fontSize: 11, fontFamily: "Helvetica", color: "#111827" },
  },
  {
    id: "caption",
    label: "Caption",
    props: { fontSize: 9, fontFamily: "Helvetica", color: "#6b7280" },
  },
  {
    id: "label",
    label: "Label",
    props: { fontSize: 9, fontFamily: "Helvetica", bold: true, color: "#374151" },
  },
  {
    id: "mono",
    label: "Mono",
    props: { fontSize: 10, fontFamily: "Courier", color: "#111827" },
  },
];

// Standard PDF-14 font families. Every PDF viewer renders these without
// embedding, keeping file size small and cross-platform consistency perfect.
export const FONT_FAMILIES = [
  { value: "Helvetica", label: "Helvetica (Sans)" },
  { value: "Times",     label: "Times New Roman" },
  { value: "Courier",   label: "Courier (Mono)"  },
  { value: "Symbol",    label: "Symbol"           },
] as const;

export type FontFamily = typeof FONT_FAMILIES[number]["value"];
