// Coordinate conversion between browser space (top-left, px at current scale)
// and PDF space (bottom-left, points).
//
// Contract: widgets in the designer state are ALWAYS stored in PDF space,
// so that zoom level is irrelevant to saved config.

export type PageInfo = {
  widthPts: number;   // intrinsic PDF width in points
  heightPts: number;  // intrinsic PDF height in points
  scale: number;      // current render scale (browser px per PDF point)
};

export type BrowserRect = { x: number; y: number; w: number; h: number };
export type PdfRect = { x: number; y: number; w: number; h: number };

export function browserToPdf(r: BrowserRect, p: PageInfo): PdfRect {
  const x = r.x / p.scale;
  const w = r.w / p.scale;
  const h = r.h / p.scale;
  // Browser Y grows downward from top of the canvas; PDF Y grows upward from bottom.
  // Widget's PDF y = distance from bottom of page to bottom of widget rect.
  const yTopInPoints = r.y / p.scale;
  const y = p.heightPts - yTopInPoints - h;
  return { x, y, w, h };
}

export function pdfToBrowser(r: PdfRect, p: PageInfo): BrowserRect {
  const x = r.x * p.scale;
  const w = r.w * p.scale;
  const h = r.h * p.scale;
  const yTopInPoints = p.heightPts - r.y - r.h;
  const y = yTopInPoints * p.scale;
  return { x, y, w, h };
}
