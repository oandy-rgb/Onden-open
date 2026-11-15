// 白板的框選也要選到筆畫與形狀：哪些畫在一個矩形（文件座標）裡。
// 「看得見的點」沿用橡皮擦的規則（被擦掉的區段不算），形狀用畫出它的那組折線（shapeStrokes）。

import { visibleRuns } from "./erase";
import { shapeStrokes } from "./shapes";
import type { ErasedIntervals, InkShape, InkStroke } from "./types";

export type InkRect = { x1: number; y1: number; x2: number; y2: number };
export type InkSelection = { strokeIds: string[]; shapeIds: string[] };

const touches = (stroke: InkStroke, erased: ErasedIntervals[string] | undefined, r: InkRect): boolean =>
  visibleRuns(stroke.points.length, erased).some(([a, b]) => {
    for (let i = a; i <= b; i++) {
      const [x, y] = stroke.points[i]!;
      if (x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2) return true;
    }
    return false;
  });

/** The strokes and shapes with a visible point inside `rect` (corners in any order). */
export function inkItemsInRect(
  doc: { strokes: readonly InkStroke[]; erased: ErasedIntervals; shapes: readonly InkShape[] },
  rect: InkRect,
): InkSelection {
  const r = { x1: Math.min(rect.x1, rect.x2), y1: Math.min(rect.y1, rect.y2), x2: Math.max(rect.x1, rect.x2), y2: Math.max(rect.y1, rect.y2) };
  return {
    strokeIds: doc.strokes.filter((s) => touches(s, doc.erased[s.id], r)).map((s) => s.id),
    shapeIds: doc.shapes.filter((shape) => shapeStrokes(shape).some((s) => touches(s, undefined, r))).map((shape) => shape.id),
  };
}

/** Box around the selected items in document coordinates, or null when none is left. */
export function inkSelectionBounds(
  doc: { strokes: readonly InkStroke[]; erased: ErasedIntervals; shapes: readonly InkShape[] },
  selection: InkSelection,
): InkRect | null {
  const ids = new Set(selection.strokeIds), shapeIds = new Set(selection.shapeIds);
  const lines = [
    ...doc.strokes.filter((s) => ids.has(s.id)).map((s) => ({ s, erased: doc.erased[s.id] })),
    ...doc.shapes.filter((shape) => shapeIds.has(shape.id)).flatMap(shapeStrokes).map((s) => ({ s, erased: undefined })),
  ];
  let box: InkRect | null = null;
  for (const { s, erased } of lines) {
    for (const [a, b] of visibleRuns(s.points.length, erased)) {
      for (let i = a; i <= b; i++) {
        const [x, y] = s.points[i]!;
        box = box ? { x1: Math.min(box.x1, x), y1: Math.min(box.y1, y), x2: Math.max(box.x2, x), y2: Math.max(box.y2, y) } : { x1: x, y1: y, x2: x, y2: y };
      }
    }
  }
  return box;
}
