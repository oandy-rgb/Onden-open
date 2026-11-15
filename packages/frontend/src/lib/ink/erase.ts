// Scribble-eraser geometry (Excalidraw model): the eraser drag builds a
// trail of points; any stroke point inside trail-radius of an eraser point
// becomes part of a dead interval. Strokes are never mutated — we only
// compute index intervals over the original polyline.

import { mergeIntervals, visibleRuns } from "@onden/markdown/ink";
import type { EraseInterval, InkPoint, InkStroke } from "./types";

// Merging a set of erase intervals is the stored-format rule, shared with the
// server's ink merge.
export { mergeIntervals };

/** Squared distance from point p to segment [a, b]. */
function distSqToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ddx = px - cx;
  const ddy = py - cy;
  return ddx * ddx + ddy * ddy;
}

/**
 * Compute the NEW erase intervals an eraser trail inflicts on one stroke.
 * A stroke point dies when it falls within `radius + stroke.size / 2` of any
 * trail segment (segments, not just trail points, so a fast eraser drag
 * can't tunnel between samples). Returns intervals over point indices,
 * merged with `existing`; returns null when the trail hit nothing new.
 */
export function eraseStrokeWithTrail(
  stroke: InkStroke,
  existing: EraseInterval[] | undefined,
  trail: ReadonlyArray<readonly [number, number]>,
  radius: number,
): EraseInterval[] | null {
  if (trail.length === 0 || stroke.points.length === 0) return null;
  const reach = radius + stroke.size / 2;
  const reachSq = reach * reach;

  const hits: EraseInterval[] = [];
  let runStart = -1;
  for (let i = 0; i < stroke.points.length; i++) {
    const p: InkPoint = stroke.points[i];
    let hit = false;
    if (trail.length === 1) {
      const dx = p[0] - trail[0][0];
      const dy = p[1] - trail[0][1];
      hit = dx * dx + dy * dy <= reachSq;
    } else {
      for (let s = 0; s < trail.length - 1 && !hit; s++) {
        hit = distSqToSegment(p[0], p[1], trail[s][0], trail[s][1], trail[s + 1][0], trail[s + 1][1]) <= reachSq;
      }
    }
    if (hit) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      hits.push([runStart, i - 1]);
      runStart = -1;
    }
  }
  if (runStart >= 0) hits.push([runStart, stroke.points.length - 1]);
  if (hits.length === 0) return null;

  const merged = mergeIntervals([...(existing ?? []), ...hits]);
  // No-op guard: if merging produced the same coverage, report no change.
  if (existing && merged.length === existing.length
      && merged.every((iv, i) => iv[0] === existing[i][0] && iv[1] === existing[i][1])) {
    return null;
  }
  return merged;
}

// The complement of the erased intervals — maximal runs of surviving point
// indices — is shared with the static renderer (@onden/markdown inkSvg.ts).
export { visibleRuns } from "@onden/markdown/ink";

/** True when the intervals cover every point of the stroke (fully erased). */
export function isFullyErased(pointCount: number, intervals: EraseInterval[] | undefined): boolean {
  return visibleRuns(pointCount, intervals).length === 0;
}
