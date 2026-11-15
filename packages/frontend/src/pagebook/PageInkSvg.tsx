// A page's drawing as a picture: its strokes and shapes in page units, drawn with the geometry
// every static ink surface uses (the handwriting note, embedded cards, the published site —
// @onden/markdown/ink) into a viewBox the page's width is 1000 units of, so it scales with the
// page at any zoom. Shown while the page has no ink engine (not near the screen, or no ink
// tool); otherwise the engine's canvases hold the same drawing.

import { INK_PAGE_UNITS, INK_SHAPE_FILL_ALPHA, inkShapeIsFilled, inkShapePathD, type InkDocument } from "@onden/markdown/ink";
import { memo, useMemo } from "react";
import { HIGHLIGHTER_ALPHA, outlineToPath, strokeOutline, visibleRuns } from "../lib/ink";
import "./PageInk.css";

export const PageInkSvg = memo(function PageInkSvg({ doc, heightUnits }: { doc: InkDocument; /** The page's height in page units. */ heightUnits: number }) {
  const paths = useMemo(() => doc.strokes.flatMap((stroke) =>
    visibleRuns(stroke.points.length, doc.erased[stroke.id]).flatMap(([a, b]) => {
      const run = stroke.points.slice(a, b + 1);
      const d = run.length >= 2 ? outlineToPath(strokeOutline(run, stroke, true)) : "";
      return d ? [{ key: `${stroke.id}:${a}`, d, color: stroke.color, highlighter: stroke.toolId === "highlighter" }] : [];
    })), [doc]);
  const shapes = useMemo(() => (doc.shapes ?? []).flatMap((shape) => {
    const d = inkShapePathD(shape);
    return d ? [{ key: shape.id, d, color: shape.color, size: shape.size, filled: inkShapeIsFilled(shape) }] : [];
  }), [doc]);
  if (paths.length === 0 && shapes.length === 0) return null;
  return (
    <svg className="page-ink-svg" viewBox={`0 0 ${INK_PAGE_UNITS} ${heightUnits}`} preserveAspectRatio="none">
      {paths.map((p) => (
        <path key={p.key} d={p.d} fill={p.color} fillOpacity={p.highlighter ? HIGHLIGHTER_ALPHA : undefined} />
      ))}
      {shapes.map((s) => (
        <path key={s.key} d={s.d} stroke={s.color} strokeWidth={s.size} strokeLinecap="round" strokeLinejoin="round"
          {...(s.filled ? { fill: s.color, fillOpacity: INK_SHAPE_FILL_ALPHA } : { fill: "none" })} />
      ))}
    </svg>
  );
});
