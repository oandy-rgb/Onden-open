// Host-agnostic ink engine — shared types.
//
// Strokes are IMMUTABLE once committed. Erasure never mutates points: the
// per-stroke `erased` interval map marks dead index ranges along the
// polyline and rendering filters them out. This keeps every mutation an
// append-shaped op (add stroke / add intervals), which is what makes the
// in-engine undo stack and the eventual CRDT story cheap.

// The stored document format (strokes, erasure, shapes, page) is shared with
// the server, which merges concurrent saves (@onden/markdown/ink).
import type { ErasedIntervals, InkDocument, InkShape, InkStroke, InkToolId } from "@onden/markdown/ink";
import { INK_DEFAULT_PAGE_WIDTH } from "@onden/markdown/ink";

export type {
  InkPoint, InkToolId, InkStroke, EraseInterval, ErasedIntervals, InkPage, InkShape, InkShapeFill, InkShapeKind, InkDocument,
} from "@onden/markdown/ink";
export { INK_DEFAULT_PAGE_WIDTH } from "@onden/markdown/ink";

/** The active tool the engine consults on pointerdown — flat dispatch
 *  (AFFiNE pattern), no state-machine hierarchy. Eraser is a tool here but
 *  never a stroke `toolId` (it produces erase intervals, not strokes); "hand"
 *  draws nothing at all: it pans (inputPolicy.ts). "shape" drags out the shape
 *  the engine's shape kind names (a stroke-less tool: it makes `InkShape`s). */
export type InkActiveTool = InkToolId | "eraser" | "hand" | "shape";

/** Undo-stack ops. Erase ops carry before/after interval snapshots for the
 *  strokes a drag touched, so undo/redo is a constant-time map restore. */
export type InkOp =
  | { type: "add"; stroke: InkStroke }
  | { type: "addShape"; shape: InkShape }
  /** A stroke the pen held still on became `shape`; undo gives the stroke back. */
  | { type: "snap"; stroke: InkStroke; shape: InkShape }
  /** Strokes and shapes moved together (the board's selection). */
  | { type: "move"; strokeIds: string[]; shapeIds: string[]; dx: number; dy: number }
  | {
      type: "erase";
      before: ErasedIntervals;
      after: ErasedIntervals;
      /** Shapes the same drag removed whole. */
      shapes: InkShape[];
    };

/** Transform seam between host viewport (CSS px, relative to the canvas
 *  element) and document coordinates. T1's host uses a pure uniform scale
 *  (fit page width to container) + native scroll; future hosts (React Flow
 *  card, PDF overlay) inject pan/zoom here without engine changes. */
export interface InkTransform {
  /** CSS px (canvas-relative) -> document coordinates. */
  toDoc(cssX: number, cssY: number): [number, number];
  /** Uniform doc->CSS scale used to set up the canvas backing transform. */
  scale(): number;
  /** CSS px offset of the doc origin inside the surface (pan). Hosts with a
   *  scroll/zoom camera (React Flow canvas) supply this; the T1 page host
   *  omits it (origin = canvas origin). */
  offset?(): [number, number];
}

export function emptyInkDocument(pageWidth = INK_DEFAULT_PAGE_WIDTH): InkDocument {
  return { version: 1, strokes: [], erased: {}, page: { width: pageWidth } };
}
