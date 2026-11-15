import { expect, it } from "vitest";
import { layoutSectionHeadings } from "../lib/sectionHeadings";

const frames = [
  { id: "inner", x: 325, y: 107, width: 460 },
  { id: "outer", x: 291, y: 100, width: 730 },
  { id: "same", x: 325, y: 107, width: 460 },
  { id: "distant", x: 2500, y: 100, width: 400 },
];
it.each([0.1, 0.31, 0.55, 1, 1.2, 2])("keeps headings apart at %sx without changing frame geometry", zoom => {
  const before = JSON.stringify(frames);
  const headings = layoutSectionHeadings(frames, zoom);
  const rects = frames.map(frame => {
    const heading = headings.get(frame.id)!;
    expect(heading.width).toBeGreaterThanOrEqual(220);
    expect(heading.width).toBeLessThanOrEqual(240);
    expect(heading.scale * zoom).toBeCloseTo(1);
    return { x: (frame.x + heading.left) * zoom, y: (frame.y + heading.top) * zoom, width: heading.width, height: 44 };
  });
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j];
    expect(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y).toBe(false);
  }
  expect(layoutSectionHeadings([...frames].reverse(), zoom)).toEqual(headings);
  expect(JSON.stringify(frames)).toBe(before);
});
