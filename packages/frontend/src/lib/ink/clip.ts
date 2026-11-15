// 白板複製貼上時的筆跡：選到的筆畫與形狀取出成一份獨立的副本，貼上時換新 id、整份平移。
// 被橡皮擦擦掉的區段不帶走（沿用 select.ts 的「看得見的點」規則）：一條被擦成兩段的筆畫，
// 貼上去是兩條各自完整的新筆畫。

import { visibleRuns } from "./erase";
import { shapeStrokes } from "./shapes";
import type { InkSelection, InkRect } from "./select";
import type { ErasedIntervals, InkShape, InkStroke } from "./types";

export type InkClip = { strokes: InkStroke[]; shapes: InkShape[] };

export const isEmptyInkClip = (clip: InkClip | null | undefined): boolean => !clip || (clip.strokes.length === 0 && clip.shapes.length === 0);

/** Copies of the selected strokes (split at erased parts) and shapes. */
export function extractInkClip(
  doc: { strokes: readonly InkStroke[]; erased: ErasedIntervals; shapes: readonly InkShape[] },
  selection: InkSelection,
): InkClip {
  const strokeIds = new Set(selection.strokeIds), shapeIds = new Set(selection.shapeIds);
  const strokes: InkStroke[] = [];
  for (const stroke of doc.strokes) {
    if (!strokeIds.has(stroke.id)) continue;
    for (const [a, b] of visibleRuns(stroke.points.length, doc.erased[stroke.id])) {
      strokes.push({ ...stroke, points: stroke.points.slice(a, b + 1).map((p) => [...p] as InkStroke["points"][number]) });
    }
  }
  const shapes = doc.shapes.filter((shape) => shapeIds.has(shape.id)).map((shape) => ({ ...shape, start: [...shape.start] as [number, number], end: [...shape.end] as [number, number] }));
  return { strokes, shapes };
}

/** The clip moved by (dx, dy), every item under a new id from `newId`. */
export function placeInkClip(clip: InkClip, dx: number, dy: number, newId: () => string): InkClip {
  return {
    strokes: clip.strokes.map((s) => ({ ...s, id: newId(), points: s.points.map((p) => [p[0] + dx, p[1] + dy, ...p.slice(2)] as InkStroke["points"][number]) })),
    shapes: clip.shapes.map((shape) => ({ ...shape, id: newId(), start: [shape.start[0] + dx, shape.start[1] + dy], end: [shape.end[0] + dx, shape.end[1] + dy] })),
  };
}

/** Box around everything in the clip (document coordinates), or null when empty. */
export function inkClipBounds(clip: InkClip): InkRect | null {
  let box: InkRect | null = null;
  const lines = [...clip.strokes, ...clip.shapes.flatMap(shapeStrokes)];
  for (const s of lines) {
    for (const [x, y] of s.points) {
      box = box ? { x1: Math.min(box.x1, x), y1: Math.min(box.y1, y), x2: Math.max(box.x2, x), y2: Math.max(box.y2, y) } : { x1: x, y1: y, x2: x, y2: y };
    }
  }
  return box;
}
