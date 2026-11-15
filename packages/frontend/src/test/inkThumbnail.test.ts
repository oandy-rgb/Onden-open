// Static ink thumbnail (lib/ink/thumbnail) — the read-only SVG a #review
// handwritten card renders instead of a blank body. Pure, DOM-free: same
// document → same string. Covers the empty/garbage/fully-erased cases that
// must yield null so the host can fall back to "This note is empty."

import { describe, it, expect } from "vitest";
import { inkThumbnailSvg } from "../lib/ink/thumbnail";
import type { InkDocument, InkStroke } from "../lib/ink/types";

const stroke = (id: string, pts: [number, number][], extra?: Partial<InkStroke>): InkStroke => ({
  id,
  points: pts,
  color: "#1a1a1a",
  size: 4,
  toolId: "pen",
  ...extra,
});

const doc = (strokes: InkStroke[], erased: InkDocument["erased"] = {}): InkDocument => ({
  version: 1,
  strokes,
  erased,
  page: { width: 1000 },
});

describe("inkThumbnailSvg", () => {
  it("sanitises an attacker-controlled stroke color (no fill=\"\" breakout → stored XSS)", () => {
    // ink_data is attacker-controllable and the SVG is injected via
    // dangerouslySetInnerHTML; an unescaped color must not break out of fill="".
    const svg = inkThumbnailSvg(doc([
      stroke("x", [[0, 0], [10, 10], [20, 0]], { color: 'red" onload="alert(1)' }),
    ]))!;
    expect(svg).not.toContain("onload=");
    expect(svg).not.toContain('red"');
    expect(svg).toContain('fill="#000"'); // fell back to the safe default
    // legitimate colors (hex / named / rgb) survive untouched
    expect(inkThumbnailSvg(doc([stroke("h", [[0, 0], [10, 10], [20, 0]], { color: "#abcdef" })]))!).toContain('fill="#abcdef"');
    expect(inkThumbnailSvg(doc([stroke("n", [[0, 0], [10, 10], [20, 0]], { color: "rebeccapurple" })]))!).toContain('fill="rebeccapurple"');
    expect(inkThumbnailSvg(doc([stroke("r", [[0, 0], [10, 10], [20, 0]], { color: "rgb(10, 20, 30)" })]))!).toContain('fill="rgb(10, 20, 30)"');
  });

  it("renders an <svg> with a path per drawable stroke", () => {
    const svg = inkThumbnailSvg(doc([
      stroke("a", [[10, 10], [40, 40], [80, 20]]),
      stroke("b", [[100, 100], [140, 130]]),
    ]));
    expect(svg).toContain("<svg");
    expect(svg).toContain("viewBox=");
    expect((svg!.match(/<path /g) ?? []).length).toBe(2);
  });

  it("is deterministic — same document yields the same string", () => {
    const d = doc([stroke("a", [[0, 0], [20, 20], [50, 5]])]);
    expect(inkThumbnailSvg(d)).toBe(inkThumbnailSvg(d));
  });

  it("marks highlighter strokes translucent", () => {
    const svg = inkThumbnailSvg(doc([
      stroke("h", [[0, 0], [60, 0]], { toolId: "highlighter", color: "#ffd400" }),
    ]));
    expect(svg).toContain("fill-opacity=\"0.4\"");
  });

  it("honours erased intervals — a fully erased stroke contributes nothing", () => {
    const pts: [number, number][] = [[0, 0], [10, 10], [20, 20], [30, 30]];
    const svg = inkThumbnailSvg(doc([stroke("a", pts)], { a: [[0, 3]] }));
    expect(svg).toBeNull();
  });

  it("returns null for empty / strokeless documents", () => {
    expect(inkThumbnailSvg(null)).toBeNull();
    expect(inkThumbnailSvg(undefined)).toBeNull();
    expect(inkThumbnailSvg(doc([]))).toBeNull();
    // a single-point stroke is not a drawable polyline
    expect(inkThumbnailSvg(doc([stroke("a", [[5, 5]])]))).toBeNull();
  });
});
