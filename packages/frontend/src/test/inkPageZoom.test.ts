// The page layout and transform math the engine's page-growth tests use as a fixture, and the canvas
// pixel cap every page surface uses.
import { describe, expect, it } from "vitest";
import {
  MAX_CANVAS_PIXELS, PAGE_BOTTOM_PEEK, PAGE_GUTTER,
  cappedPixelRatio, pageInkTransform, pageLayout,
  type PageCamera,
} from "../lib/ink/pageZoom";

const base: PageCamera = {
  viewportWidth: 824, // fit width = 800 → scale 0.8 at zoom 1
  viewportHeight: 600,
  pageWidth: 1000,
  pageHeight: 1400,
  zoom: 1,
  scrollLeft: 0,
  scrollTop: 0,
};

/** Where a document point appears in the viewport. */
function docToViewport(c: PageCamera, x: number, y: number): [number, number] {
  const l = pageLayout(c);
  return [l.pageLeft - c.scrollLeft + x * l.scale, l.pageTop - c.scrollTop + y * l.scale];
}

describe("pageLayout", () => {
  it("zoom 1 fits the page width inside the gutters", () => {
    const l = pageLayout(base);
    expect(l.scale).toBeCloseTo(0.8);
    expect(l.pageLeft).toBe(PAGE_GUTTER);
    expect(l.pageCssWidth).toBe(800);
    expect(l.contentWidth).toBe(824); // no horizontal scroll at fit width
    // The paper plus one viewport of empty space below it (minus the peek).
    expect(l.contentHeight).toBe(600 + PAGE_GUTTER + 1400 * 0.8 - PAGE_BOTTOM_PEEK);
  });

  it("zoomed out, the page is centred and the content is never smaller than the viewport", () => {
    const l = pageLayout({ ...base, zoom: 0.5 });
    expect(l.pageCssWidth).toBe(400);
    expect(l.pageLeft).toBe(PAGE_GUTTER + 200);
    expect(l.contentWidth).toBe(824);
    expect(l.contentHeight).toBe(600 + PAGE_GUTTER + 700 * 0.8 - PAGE_BOTTOM_PEEK);
  });
});

describe("pageInkTransform", () => {
  it("a stroke drawn at any zoom lands on the same document coordinates", () => {
    const docPoint: [number, number] = [420, 610];
    for (const zoom of [0.5, 1, 2.5, 4]) {
      const c = { ...base, zoom, scrollLeft: zoom > 1 ? 300 : 0, scrollTop: 250 };
      const transform = pageInkTransform(() => c);
      const [vx, vy] = docToViewport(c, ...docPoint);
      const [x, y] = transform.toDoc(vx, vy);
      expect(x).toBeCloseTo(docPoint[0], 6);
      expect(y).toBeCloseTo(docPoint[1], 6);
      expect(transform.scale()).toBeCloseTo(0.8 * zoom);
      const [ox, oy] = transform.offset();
      expect(ox).toBeCloseTo(pageLayout(c).pageLeft - c.scrollLeft);
      expect(oy).toBeCloseTo(PAGE_GUTTER - 250);
    }
  });

  it("reads the camera live (no rebuild across scrolls)", () => {
    const c = { ...base };
    const transform = pageInkTransform(() => c);
    const before = transform.toDoc(100, 100);
    c.scrollTop = 80;
    const after = transform.toDoc(100, 100);
    expect(after[1] - before[1]).toBeCloseTo(80 / 0.8);
  });
});

describe("cappedPixelRatio", () => {
  it("uses the device ratio unless the viewport canvas would pass the iOS limit", () => {
    expect(cappedPixelRatio(1024, 768, 2)).toBe(2);
    const r = cappedPixelRatio(3000, 2000, 3);
    expect(r).toBeLessThan(3);
    expect(3000 * 2000 * r * r).toBeLessThanOrEqual(MAX_CANVAS_PIXELS + 1);
    expect(cappedPixelRatio(100, 100, 0)).toBe(1);
  });
});
