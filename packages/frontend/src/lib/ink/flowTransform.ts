// React Flow viewport → InkTransform adapter .
//
// The knowledge-canvas host stores strokes in CANVAS MODEL coordinates (the
// same space React Flow nodes live in). The pane viewport is
// `screen = model * zoom + (x, y)`, so the injected transform is its inverse
// plus the (scale, offset) pair the committed renderer uses as its stage
// transform. Pure math — the getter indirection keeps it live across pans
// without re-creating the engine.

import type { InkTransform } from "./types";

export interface FlowViewportLike {
  x: number;
  y: number;
  zoom: number;
}

export function flowInkTransform(get: () => FlowViewportLike): Required<InkTransform> {
  return {
    toDoc(cssX: number, cssY: number): [number, number] {
      const v = get();
      return [(cssX - v.x) / v.zoom, (cssY - v.y) / v.zoom];
    },
    scale(): number {
      return get().zoom;
    },
    offset(): [number, number] {
      const v = get();
      return [v.x, v.y];
    },
  };
}
