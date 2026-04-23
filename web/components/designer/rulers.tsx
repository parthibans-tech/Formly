"use client";

// Top + left rulers rendered *inside* a page frame. Ticks every 10pt
// (minor) and 50pt (major, labelled). A small pink indicator tracks the
// cursor's current PDF position.

type Props = {
  widthBrowser: number;
  heightBrowser: number;
  pageW: number; // PDF points
  pageH: number; // PDF points
  zoom: number;
  cursor?: { x: number; y: number } | null; // PDF points
};

export function Rulers({
  widthBrowser,
  heightBrowser,
  pageW,
  pageH,
  zoom,
  cursor,
}: Props) {
  const RULER_THICK = 16;
  const ticks = buildTicks(pageW, zoom);
  const ticksY = buildTicks(pageH, zoom);

  return (
    <>
      {/* Top ruler */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-0 flex items-end overflow-hidden border-b border-border/60 bg-muted/80 text-[9px] font-mono text-muted-foreground"
        style={{
          top: -RULER_THICK,
          width: widthBrowser,
          height: RULER_THICK,
        }}
      >
        {ticks.map((t) => (
          <div
            key={"x" + t.pt}
            className="absolute bottom-0 flex flex-col items-center"
            style={{ left: t.px }}
          >
            <div
              className="bg-foreground/60"
              style={{
                width: 1,
                height: t.major ? 8 : 4,
              }}
            />
            {t.major && <div className="mb-0.5 leading-none">{t.pt}</div>}
          </div>
        ))}
        {cursor && (
          <div
            className="absolute bottom-0 bg-primary"
            style={{ left: cursor.x * zoom, width: 1, height: RULER_THICK }}
          />
        )}
      </div>
      {/* Left ruler */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-0 flex flex-col overflow-hidden border-r border-border/60 bg-muted/80 text-[9px] font-mono text-muted-foreground"
        style={{
          left: -RULER_THICK,
          width: RULER_THICK,
          height: heightBrowser,
        }}
      >
        {ticksY.map((t) => (
          <div
            key={"y" + t.pt}
            className="absolute right-0 flex items-center"
            style={{
              // PDF y grows up but browser grows down — invert for display.
              top: heightBrowser - t.px,
            }}
          >
            <div
              className="bg-foreground/60"
              style={{
                height: 1,
                width: t.major ? 8 : 4,
              }}
            />
            {t.major && (
              <div
                className="absolute right-2 -rotate-90 origin-right leading-none"
                style={{ transformOrigin: "right" }}
              >
                {t.pt}
              </div>
            )}
          </div>
        ))}
        {cursor && (
          <div
            className="absolute right-0 bg-primary"
            style={{
              top: heightBrowser - cursor.y * zoom,
              height: 1,
              width: RULER_THICK,
            }}
          />
        )}
      </div>
      {/* Corner patch so the two rulers don't show their padding through. */}
      <div
        aria-hidden
        className="pointer-events-none absolute border-b border-r border-border/60 bg-muted/80"
        style={{ left: -RULER_THICK, top: -RULER_THICK, width: RULER_THICK, height: RULER_THICK }}
      />
    </>
  );
}

// Build tick marks across a length in PDF points. Minor every 10pt, major
// (labelled) every 50pt. Auto-downsample at low zoom so ticks don't pile up.
function buildTicks(lengthPts: number, zoom: number) {
  // When zoom is small, 10pt ticks become visually dense. Fall back to 25pt.
  const minorStep = zoom < 0.8 ? 25 : 10;
  const majorStep = zoom < 0.5 ? 100 : 50;
  const out: { pt: number; px: number; major: boolean }[] = [];
  for (let pt = 0; pt <= lengthPts; pt += minorStep) {
    out.push({ pt, px: pt * zoom, major: pt % majorStep === 0 });
  }
  return out;
}
