import { describe, expect, it } from "vitest";
import { openViewport } from "../lib/boardFit";

// The first view never zooms past 1 (the cards' own size) nor below 0.75 (the smallest a card stays readable).
const OPEN_ZOOM_MAX = 1;
const READABLE_ZOOM = 0.75;

const pad = { top: 64, right: 24, bottom: 96, left: 24 };

describe("the view a board opens at", () => {
  it("fits everything when that is readable, centred", () => {
    const view = openViewport({ x: 0, y: 0, width: 600, height: 300 }, { width: 800, height: 600 }, pad);
    expect(view.zoom).toBe(OPEN_ZOOM_MAX);
    expect(view.x).toBeCloseTo(24 + (752 - 600) / 2, 5);
  });

  it("never goes below the readable scale: a tablet's 435px column showing a 4-wide grid", () => {
    const view = openViewport({ x: 0, y: 0, width: 1160, height: 700 }, { width: 435, height: 600 }, pad);
    expect(view.zoom).toBe(READABLE_ZOOM);
    // what does not fit is off to the right and below; the first card starts at the padding
    expect(view.x).toBe(24);
    expect(view.y).toBe(64);
  });

  it("starts at the top-left of content that sits away from the origin", () => {
    const view = openViewport({ x: 500, y: 300, width: 2000, height: 2000 }, { width: 435, height: 600 }, pad);
    expect(view).toEqual({ zoom: READABLE_ZOOM, x: 24 - 500 * READABLE_ZOOM, y: 64 - 300 * READABLE_ZOOM });
  });
});
