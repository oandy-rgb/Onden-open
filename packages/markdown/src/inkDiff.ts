// Structural diff between two ink documents (one page). Shared by the app
// (lib/ink/diff.ts) and History (inkChange.ts, services/history/inkChanges.ts).
//
// Because the model is append-shaped by construction — strokes are immutable
// once committed and erasure only ADDS dead intervals — diffing two snapshots
// is exact set arithmetic, not heuristics. This is what lets ink ride the same
// review surfaces as text: inbox evidence ("drew 3 strokes, erased 1 span"),
// history summaries, and the node-level merge story (strokes = grow-set,
// erased intervals = interval union ⇒ ink merges commutatively).

import { mergeIntervals, subtractIntervals } from "./inkFormat.js";
import type { EraseInterval, ErasedIntervals, InkDocument, InkShape, InkStroke } from "./inkFormat.js";

export interface InkDiff {
  /** Strokes present in `next` but not `prev` (drawn, or redone). */
  addedStrokes: InkStroke[];
  /** Strokes present in `prev` but not `next` (undone in-session). */
  removedStrokes: InkStroke[];
  /** Per stroke: erase coverage in `next` that `prev` did not have. */
  newlyErased: ErasedIntervals;
  /** Per stroke: erase coverage in `prev` that `next` no longer has
   *  (an erase that was undone). */
  unerased: ErasedIntervals;
  /** Shapes added / removed — same grow-set semantics as strokes. */
  addedShapes: InkShape[];
  removedShapes: InkShape[];
}

export function isEmptyInkDiff(d: InkDiff): boolean {
  return (
    d.addedStrokes.length === 0 &&
    d.removedStrokes.length === 0 &&
    Object.keys(d.newlyErased).length === 0 &&
    Object.keys(d.unerased).length === 0 &&
    d.addedShapes.length === 0 &&
    d.removedShapes.length === 0
  );
}

function erasedDelta(next: ErasedIntervals, prev: ErasedIntervals): ErasedIntervals {
  const delta: ErasedIntervals = {};
  for (const [strokeId, intervals] of Object.entries(next)) {
    const gained = subtractIntervals(mergeIntervals([...intervals]), mergeIntervals([...(prev[strokeId] ?? [])]));
    if (gained.length > 0) delta[strokeId] = gained;
  }
  return delta;
}

export function diffInk(prev: InkDocument | null, next: InkDocument): InkDiff {
  const prevStrokes = new Map((prev?.strokes ?? []).map((s) => [s.id, s]));
  const nextStrokes = new Map(next.strokes.map((s) => [s.id, s]));
  const prevShapes = new Map((prev?.shapes ?? []).map((s) => [s.id, s]));
  const nextShapes = new Map((next.shapes ?? []).map((s) => [s.id, s]));
  return {
    addedStrokes: next.strokes.filter((s) => !prevStrokes.has(s.id)),
    removedStrokes: (prev?.strokes ?? []).filter((s) => !nextStrokes.has(s.id)),
    newlyErased: erasedDelta(next.erased, prev?.erased ?? {}),
    unerased: erasedDelta(prev?.erased ?? {}, next.erased),
    addedShapes: (next.shapes ?? []).filter((s) => !prevShapes.has(s.id)),
    removedShapes: (prev?.shapes ?? []).filter((s) => !nextShapes.has(s.id)),
  };
}
