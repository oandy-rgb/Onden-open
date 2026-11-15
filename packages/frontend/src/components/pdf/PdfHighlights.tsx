// Presentational annotation renderers — positioned divs/SVG inside a page
// overlay. Replaces the lib's TextHighlight / AreaHighlight / ShapeHighlight
// / drawing <img>: same stored format in, same visuals out, no library.
//
// Everything converts stored Scaled coords against the CURRENT page viewport
// at render time, so annotations stay glued through zoom without ever
// rewriting the stored record.

import { memo, useMemo, type CSSProperties } from "react";
import { scaledPositionToViewport, type PageViewportLike, type PdfHighlightRecord } from "../../lib/pdf/coords";

// Dynamic rects ride CSS custom properties (project rule: no inline style
// values; the lint rule requires the literal object at the call site). The
// consuming rules live in PdfNodeView.css (.pdf-hl-rect).
type RectVars = CSSProperties;
const px = (n: number) => `${n}px`;

/** The text and area highlights of one page, current-viewport positioned. The
 *  drawing and shape records are the older form of the page's strokes and
 *  shapes (lib/pdf/pageUnits): PageInkSvg draws those from the page itself. */
export function PdfPageHighlights({
  highlights,
  pageNumber,
  viewport,
}: {
  highlights: PdfHighlightRecord[];
  pageNumber: number;
  viewport: PageViewportLike;
}) {
  // The caller may build the viewport anew on every render; what the memoized views compare is its size.
  const stable = useMemo(() => ({ width: viewport.width, height: viewport.height }), [viewport.width, viewport.height]);
  return (
    <>
      {highlights
        .filter((h) => h.position?.boundingRect?.pageNumber === pageNumber && h.type !== "drawing" && h.type !== "shape")
        .map((h) => (
          <PdfHighlightView key={h.id} record={h} viewport={stable} />
        ))}
    </>
  );
}

/** One annotation. Memoized: records are immutable-by-identity and the
 *  viewport object only changes identity on zoom, so unrelated state churn
 *  in PdfNodeView never re-renders committed annotation DOM. */
export const PdfHighlightView = memo(function PdfHighlightView({
  record,
  viewport,
}: {
  record: PdfHighlightRecord;
  viewport: PageViewportLike;
}) {
  const { boundingRect, rects } = scaledPositionToViewport(record.position, viewport);
  if (record.type === "text") {
    // Legacy quirk repair: old alt+drag area selections were committed as
    // type:"text" with EMPTY rects (and were invisible). Fall back to the
    // bounding box so that data finally renders.
    const parts = rects.length > 0 ? rects : [boundingRect];
    return (
      <div className="pdf-hl">
        {parts.map((r, i) => (
          <div
            key={i}
            className="pdf-hl-part pdf-hl-rect pdf-hl-text"
            style={{
              "--pdf-hl-left": px(r.left),
              "--pdf-hl-top": px(r.top),
              "--pdf-hl-width": px(r.width),
              "--pdf-hl-height": px(r.height),
            } as RectVars}
          />
        ))}
      </div>
    );
  }
  // "area" + anything unknown ("image"/"freetext" were never created by this
  // app; a translucent box is the honest fallback for stray records).
  return (
    <div className="pdf-hl">
      <div
        className="pdf-hl-part pdf-hl-rect pdf-hl-area"
        style={{
          "--pdf-hl-left": px(boundingRect.left),
          "--pdf-hl-top": px(boundingRect.top),
          "--pdf-hl-width": px(boundingRect.width),
          "--pdf-hl-height": px(boundingRect.height),
        } as RectVars}
      />
    </div>
  );
});
