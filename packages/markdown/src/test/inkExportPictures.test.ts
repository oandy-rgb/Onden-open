import { expect, it } from "vitest";
import { inkOverlayToSvg, inkToSvg, inkToSvgFrame, type InkDocument } from "../ink.js";

const doc: InkDocument = {
  version: 1, erased: {}, page: { width: 1000 },
  strokes: [{ id: "s", color: "#123456", size: 4, toolId: "pen", points: [[10, 10], [60, 50], [120, 30]] }],
};

it("inkToSvgFrame is inkToSvg plus its viewBox in whole units", () => {
  const frame = inkToSvgFrame(doc)!;
  expect(frame.svg).toBe(inkToSvg(doc));
  const [x, y, w, h] = /viewBox="([^"]+)"/.exec(frame.svg)![1]!.split(" ").map(Number);
  expect(frame).toMatchObject({ x: Math.round(x!), y: Math.round(y!), width: Math.round(w!), height: Math.round(h!) });
  expect(inkToSvgFrame({ ...doc, strokes: [] })).toBeNull();
});

it("inkOverlayToSvg: strokes keep inkToSvg's path, text is escaped, nothing else is painted", () => {
  const size = { width: 1000, height: 1400 };
  const svg = inkOverlayToSvg({ size, doc }, [{ x: 5, y: 7, w: 200, text: "a <b> & \"c\"", size: 20, color: "#000", align: "center" }])!;
  const strokePath = /<path d="([^"]+)"/.exec(inkToSvg(doc)!)![1]!;
  expect(svg).toContain(`<path d="${strokePath}"`);
  expect(svg).toContain("a &lt;b&gt; &amp; &quot;c&quot;");
  expect(svg).toContain('text-anchor="middle"');
  expect(svg).toContain('viewBox="0 0 1000 1400"');
  expect(svg).not.toContain("<rect");
  expect(inkOverlayToSvg({ size, doc: { ...doc, strokes: [] } }, [])).toBeNull();
  expect(inkOverlayToSvg({ size, doc: { ...doc, strokes: [] } }, [{ x: 0, y: 0, w: 100, text: "  ", size: 20, color: "#000", align: "left" }])).toBeNull();
});
