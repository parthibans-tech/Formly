export type PageSize = "Letter" | "A4" | "Legal" | "A3" | "A5";
export type Orientation = "portrait" | "landscape";
export type PageNumberPosition =
  | "bottom-center"
  | "bottom-left"
  | "bottom-right"
  | "top-center"
  | "top-left"
  | "top-right";

export type PageLayout = {
  pageSize?: PageSize;
  orientation?: Orientation;
  margins?: {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
  };
  header?: { enabled?: boolean; html?: string };
  footer?: { enabled?: boolean; html?: string };
  pageNumbers?: {
    enabled?: boolean;
    format?: string;
    position?: PageNumberPosition;
  };
  watermark?: {
    enabled?: boolean;
    text?: string;
    opacity?: number;
    angle?: number;
    fontSize?: number;
    color?: string;
  };
};

export const DEFAULT_LAYOUT: Required<
  Pick<PageLayout, "pageSize" | "orientation">
> & {
  margins: { top: number; right: number; bottom: number; left: number };
  header: { enabled: boolean; html: string };
  footer: { enabled: boolean; html: string };
  pageNumbers: {
    enabled: boolean;
    format: string;
    position: PageNumberPosition;
  };
  watermark: {
    enabled: boolean;
    text: string;
    opacity: number;
    angle: number;
    fontSize: number;
    color: string;
  };
} = {
  pageSize: "Letter",
  orientation: "portrait",
  margins: { top: 0.4, right: 0.4, bottom: 0.4, left: 0.4 },
  header: { enabled: false, html: "" },
  footer: { enabled: false, html: "" },
  pageNumbers: {
    enabled: false,
    format: "Page {page} of {total}",
    position: "bottom-center",
  },
  watermark: {
    enabled: false,
    text: "DRAFT",
    opacity: 0.12,
    angle: -30,
    fontSize: 120,
    color: "#000000",
  },
};

export function mergeLayout(existing?: PageLayout): typeof DEFAULT_LAYOUT {
  return {
    ...DEFAULT_LAYOUT,
    ...existing,
    margins: { ...DEFAULT_LAYOUT.margins, ...(existing?.margins || {}) },
    header: { ...DEFAULT_LAYOUT.header, ...(existing?.header || {}) },
    footer: { ...DEFAULT_LAYOUT.footer, ...(existing?.footer || {}) },
    pageNumbers: {
      ...DEFAULT_LAYOUT.pageNumbers,
      ...(existing?.pageNumbers || {}),
    },
    watermark: {
      ...DEFAULT_LAYOUT.watermark,
      ...(existing?.watermark || {}),
    },
  };
}
