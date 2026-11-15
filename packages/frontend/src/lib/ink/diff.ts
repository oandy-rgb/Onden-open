// The structural diff itself is @onden/markdown/ink (inkDiff.ts); this adds the English one-liner.
import { diffInk, isEmptyInkDiff, type InkDiff } from "@onden/markdown/ink";

export { diffInk, isEmptyInkDiff, type InkDiff };

/** One-line human summary for evidence/history surfaces. Counts, never ids —
 *  the reader cares about the gesture ("drew 3 strokes"), not the schema. */
export function describeInkDiff(d: InkDiff): string {
  const parts: string[] = [];
  if (d.addedStrokes.length) parts.push(`drew ${d.addedStrokes.length} stroke${d.addedStrokes.length > 1 ? "s" : ""}`);
  if (d.removedStrokes.length) parts.push(`undid ${d.removedStrokes.length} stroke${d.removedStrokes.length > 1 ? "s" : ""}`);
  const erasedCount = Object.values(d.newlyErased).reduce((n, iv) => n + iv.length, 0);
  if (erasedCount) parts.push(`erased ${erasedCount} span${erasedCount > 1 ? "s" : ""}`);
  const unerasedCount = Object.values(d.unerased).reduce((n, iv) => n + iv.length, 0);
  if (unerasedCount) parts.push(`restored ${unerasedCount} erased span${unerasedCount > 1 ? "s" : ""}`);
  if (d.addedShapes.length) parts.push(`added ${d.addedShapes.length} shape${d.addedShapes.length > 1 ? "s" : ""}`);
  if (d.removedShapes.length) parts.push(`removed ${d.removedShapes.length} shape${d.removedShapes.length > 1 ? "s" : ""}`);
  return parts.length ? parts.join(", ") : "no ink change";
}
