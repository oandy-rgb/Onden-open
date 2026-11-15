// Zoom limits and canvas limits for page hosts, and the pure math of the old
// viewport-sized-canvas page camera (pageLayout, pageInkTransform), which the
// engine's page-growth tests still use as a fixture: where a growing page sits
// in the scroll content at a zoom, and the InkTransform the engine maps pointers
// and paints through. Strokes stay in DOCUMENT coordinates; only the
// transform changes, so the stored format never sees the zoom.
//
//   zoom 1 = "fit width": the page fills the viewport width minus gutters.
//   doc → CSS px scale = fitWidth × zoom / pageWidth.
//   doc origin inside the viewport = (pageLeft − scrollLeft, pageTop − scrollTop).

import type { InkTransform } from "./types";

export const PAGE_ZOOM_MIN = 0.5;
export const PAGE_ZOOM_MAX = 4;
/** Space around the page inside the scroll area (CSS px). Also the most the
 *  view may show of non-paper beside the paper when it is wider than the
 *  viewport. */
export const PAGE_GUTTER = 12;
/** Ink-bearing page still in view (CSS px) when scrolled to the very bottom.
 *  Below it the camera allows at most one more viewport — room to keep
 *  writing, since the page grows with the ink (engine `maybeGrow`). That room
 *  is drawn as paper too (`paperCssHeight`), as endless-scroll notebooks do:
 *  the paper never stops above an empty void you can still write in. */
export const PAGE_BOTTOM_PEEK = 64;

/** Everything the camera depends on. Widths/heights in CSS px except the
 *  page size, which is in document units. */
export interface PageCamera {
  viewportWidth: number;
  viewportHeight: number;
  pageWidth: number;
  pageHeight: number;
  zoom: number;
  scrollLeft: number;
  scrollTop: number;
}

export interface PageLayout {
  /** doc → CSS px. */
  scale: number;
  /** Page box inside the scroll content (CSS px). */
  pageLeft: number;
  pageTop: number;
  pageCssWidth: number;
  pageCssHeight: number;
  /** The paper as drawn: from the page top to the bottom of the scroll
   *  content, so it reaches past the ink into the room to keep writing. */
  paperCssHeight: number;
  /** Scroll content size (never smaller than the viewport). Vertically it is
   *  the paper plus one viewport of empty space below it (PAGE_BOTTOM_PEEK). */
  contentWidth: number;
  contentHeight: number;
}

export function pageLayout(c: Omit<PageCamera, "scrollLeft" | "scrollTop">): PageLayout {
  const fitWidth = Math.max(1, c.viewportWidth - 2 * PAGE_GUTTER);
  const pageCssWidth = fitWidth * c.zoom;
  const scale = pageCssWidth / Math.max(1, c.pageWidth);
  const pageCssHeight = c.pageHeight * scale;
  // Zoomed out, the page is centred; zoomed in, it starts at the gutter.
  const pageLeft = PAGE_GUTTER + Math.max(0, (fitWidth - pageCssWidth) / 2);
  const contentHeight = c.viewportHeight + Math.max(0, PAGE_GUTTER + pageCssHeight - PAGE_BOTTOM_PEEK);
  return {
    scale,
    pageLeft,
    pageTop: PAGE_GUTTER,
    pageCssWidth,
    pageCssHeight,
    contentWidth: Math.max(c.viewportWidth, pageCssWidth + 2 * PAGE_GUTTER),
    paperCssHeight: contentHeight - PAGE_GUTTER,
    contentHeight,
  };
}

/** Viewport CSS px → document coordinates. */
export function viewportToDoc(c: PageCamera, x: number, y: number, layout = pageLayout(c)): [number, number] {
  return [
    (x - (layout.pageLeft - c.scrollLeft)) / layout.scale,
    (y - (layout.pageTop - c.scrollTop)) / layout.scale,
  ];
}

/** The engine's transform for the page host, read live from `get` (the
 *  getter indirection keeps it current across scrolls without rebuilding
 *  the engine — same pattern as flowInkTransform). */
export function pageInkTransform(get: () => PageCamera): Required<InkTransform> {
  return {
    toDoc(cssX: number, cssY: number): [number, number] {
      return viewportToDoc(get(), cssX, cssY);
    },
    scale(): number {
      return pageLayout(get()).scale;
    },
    offset(): [number, number] {
      const c = get();
      const layout = pageLayout(c);
      return [layout.pageLeft - c.scrollLeft, layout.pageTop - c.scrollTop];
    },
  };
}

/** Largest canvas backing store we allocate, in device pixels: iOS Safari
 *  refuses canvases over 16,777,216 px (4096²); other browsers allow more. */
export const MAX_CANVAS_PIXELS = 16_777_216;

/** Pixel ratio for a viewport-sized canvas: the device ratio, lowered only
 *  when the backing store would exceed MAX_CANVAS_PIXELS. Zoom never grows
 *  the canvas — strokes are re-rendered at scale × ratio into the viewport. */
export function cappedPixelRatio(cssWidth: number, cssHeight: number, devicePixelRatio: number): number {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const area = Math.max(1, cssWidth) * Math.max(1, cssHeight);
  return Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / area));
}
