import type { Node } from "@xyflow/react";
import type { GraphPosition } from "./api";
import { DEFAULT_CARD_H, DEFAULT_CARD_W } from "./cardGeometry";

export type CanvasAlignment = "left" | "centerX" | "right" | "top" | "middleY" | "bottom" | "distH" | "distV";

/** Align the selected, rendered cards in canvas coordinates. Measurements own
 * the visible size (including folding/compact mode); explicit sizes and then
 * defaults are used before measurement. Returns only changed positions, never
 * dimensions: a view's temporary size must not replace the stored card size.
 * Distribution keeps the two end cards fixed and requires at least three.
 */
export function alignCanvasCards(nodes: readonly Node[], selectedIds: readonly string[], mode: CanvasAlignment): GraphPosition[] {
  const selected = new Set(selectedIds);
  const horizontal = mode === "left" || mode === "centerX" || mode === "right" || mode === "distH";
  const distribute = mode === "distH" || mode === "distV";
  const dimension = horizontal ? "width" : "height";
  const axis = horizontal ? "x" : "y";
  const boxes = nodes.filter(n => n.type === "card" && selected.has(n.id)).map(n => ({
    id: n.id,
    ...n.position,
    size: n.measured?.[dimension] ?? n[dimension]
      ?? (typeof n.style?.[dimension] === "number" ? n.style[dimension] : undefined)
      ?? (horizontal ? DEFAULT_CARD_W : DEFAULT_CARD_H),
  }));
  if (boxes.length < (distribute ? 3 : 2)) return [];

  let target: (box: typeof boxes[number]) => number;
  if (distribute) {
    boxes.sort((a, b) => a[axis] - b[axis]);
    const first = boxes[0];
    const last = boxes[boxes.length - 1];
    const gap = (last[axis] + last.size - first[axis] - boxes.reduce((sum, b) => sum + b.size, 0)) / (boxes.length - 1);
    let cursor = first[axis];
    target = box => {
      const position = cursor;
      cursor += box.size + gap;
      return position;
    };
  } else if (mode === "left" || mode === "top") {
    const edge = Math.min(...boxes.map(b => b[axis]));
    target = () => edge;
  } else if (mode === "right" || mode === "bottom") {
    const edge = Math.max(...boxes.map(b => b[axis] + b.size));
    target = box => edge - box.size;
  } else {
    const center = boxes.reduce((sum, b) => sum + b[axis] + b.size / 2, 0) / boxes.length;
    target = box => center - box.size / 2;
  }
  return boxes.flatMap(box => {
    const position = Math.round(target(box));
    return position === Math.round(box[axis]) ? [] : [{ nodeId: box.id, x: box.x, y: box.y, [axis]: position }];
  });
}
