// The eyedropper: which colour is stored at a point of the page. It reads the
// drawing's data (strokes, shapes, text boxes), never the pixels on screen, so
// it returns the canonical colour that is stored, whatever the theme draws.
//
// Two kinds of source answer, nearest the top first:
//   - an ink engine registers itself while it has pointer handlers (its strokes
//     and shapes live in a canvas, not in the DOM): `registerColorSource`;
//   - anything the page draws as DOM carries `data-ink-color="#rrggbb"` (a text
//     box; later a slide's text): found by where its box is on screen.
// The hit-testing of a drawing is `colorInDrawing`, pure.

import { visibleRuns } from "@onden/markdown/ink";
import { shapeTouches } from "./shapes";
import { normalizeHex } from "./palette";
import type { ErasedIntervals, InkShape, InkStroke } from "./types";

/** How far from a line a press still counts as on it (CSS px): a pen's tip is
 *  small, a finger's is not. */
export const PICK_REACH_PX = 16;

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function strokeTouches(stroke: InkStroke, erased: ErasedIntervals, x: number, y: number, reach: number): boolean {
  const limit = reach + (Number.isFinite(stroke.size) ? stroke.size / 2 : 0);
  for (const [a, b] of visibleRuns(stroke.points.length, erased[stroke.id])) {
    if (a === b) {
      const p = stroke.points[a]!;
      if (Math.hypot(x - p[0], y - p[1]) <= limit) return true;
      continue;
    }
    for (let i = a + 1; i <= b; i++) {
      const p = stroke.points[i - 1]!, q = stroke.points[i]!;
      if (distToSegment(x, y, p[0], p[1], q[0], q[1]) <= limit) return true;
    }
  }
  return false;
}

/** The stored colour of whatever is drawn at (x, y) in document units, within
 *  `reach` of it; null when nothing is. The last drawn wins, and shapes are
 *  drawn over strokes. A part erased away does not count. */
export function colorInDrawing(
  drawing: { strokes: readonly InkStroke[]; erased: ErasedIntervals; shapes: readonly InkShape[] },
  x: number,
  y: number,
  reach: number,
): string | null {
  for (let i = drawing.shapes.length - 1; i >= 0; i--) {
    const shape = drawing.shapes[i]!;
    const color = shape && normalizeHex(shape.color);
    if (color && shapeTouches(shape, x, y, reach)) return color;
  }
  for (let i = drawing.strokes.length - 1; i >= 0; i--) {
    const stroke = drawing.strokes[i]!;
    const color = stroke && normalizeHex(stroke.color);
    if (color && strokeTouches(stroke, drawing.erased, x, y, reach)) return color;
  }
  return null;
}

/** Something on screen that can say what colour is at a point. */
export interface ColorSource {
  /** The part of the screen it answers for. */
  element: HTMLElement;
  /** Colour at the viewport point, or null. */
  colorAt(clientX: number, clientY: number): string | null;
}

const sources = new Set<ColorSource>();

/** Offer a source to the eyedropper; call the result to withdraw it. */
export function registerColorSource(source: ColorSource): () => void {
  sources.add(source);
  return () => { sources.delete(source); };
}

const inside = (rect: DOMRect, x: number, y: number) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

/** The stored colour at a viewport point: text on top (`data-ink-color`
 *  boxes), then the ink engines whose surface is under the point. */
export function pickColorAt(clientX: number, clientY: number): string | null {
  if (typeof document !== "undefined") {
    const marked = [...document.querySelectorAll<HTMLElement>("[data-ink-color]")].reverse();
    for (const el of marked) {
      const color = normalizeHex(el.dataset.inkColor);
      if (color && inside(el.getBoundingClientRect(), clientX, clientY)) return color;
    }
  }
  for (const source of [...sources].reverse()) {
    if (!inside(source.element.getBoundingClientRect(), clientX, clientY)) continue;
    const color = source.colorAt(clientX, clientY);
    if (color) return color;
  }
  return null;
}
