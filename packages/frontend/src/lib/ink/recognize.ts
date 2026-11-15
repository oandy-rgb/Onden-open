// Shape recognition for "draw, then hold still": a finished-looking stroke is
// compared with each shape this tool can draw and, when one fits well, the
// shape that fits is returned (the engine swaps it in). Pure: points in, a
// shape out or null — null means "leave my stroke alone", which is also the
// answer for handwriting, scribbles and anything too small to be a shape.
//
// Closed shapes are matched as templates in the stroke's bounding box (where it
// was started and which way round it was drawn do not matter): the score is the
// average distance between the two outlines, as a fraction of the box diagonal.
// Axis-aligned only: a tilted rectangle or ellipse fits its box badly, so it is
// left as drawn instead of being turned into something it is not.

import { inkShapePolylines, type InkShape } from "@onden/markdown/ink";
import type { InkPoint } from "./types";

type Pt = [number, number];

/** What the recogniser can answer; a subset of the stored kinds (the button
 *  also offers rounded rectangle and star, which are never guessed). */
export type RecognizedKind = "line" | "arrow" | "rectangle" | "ellipse" | "triangle" | "diamond";

export interface RecognizedShape {
  kind: RecognizedKind;
  start: Pt;
  end: Pt;
}

/** Smaller than this (doc units, box diagonal) is a dot or a letter stroke. */
const MIN_DIAGONAL = 40;
const MIN_LENGTH = 50;
/** Straight enough: the farthest point from the chord, as a fraction of it. */
const LINE_DEVIATION = 0.07;
/** A closed outline fits a template when its average distance is under this. */
const CLOSED_FIT = 0.055;
/** Ends this close (fraction of the stroke's length) count as joined. */
const CLOSE_GAP = 0.22;
/** A line this close to horizontal or vertical (radians) is made so. */
const AXIS_SNAP = (6 * Math.PI) / 180;
/** Nearly square boxes make a circle. */
const CIRCLE_RATIO = 0.12;

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function pathLength(pts: Pt[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1]!, pts[i]!);
  return total;
}

/** `count` points spaced evenly along the path. */
function resample(pts: Pt[], count: number): Pt[] {
  const total = pathLength(pts);
  if (total === 0) return pts.slice(0, 1);
  const step = total / (count - 1);
  const out: Pt[] = [pts[0]!];
  let carried = 0;
  for (let i = 1; i < pts.length && out.length < count; i++) {
    let a = pts[i - 1]!;
    const b = pts[i]!;
    let seg = dist(a, b);
    while (carried + seg >= step && out.length < count) {
      const t = (step - carried) / seg;
      a = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      out.push(a);
      seg = dist(a, b);
      carried = 0;
    }
    carried += seg;
  }
  while (out.length < count) out.push(pts[pts.length - 1]!);
  return out;
}

function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function distanceToPolyline(p: Pt, line: Pt[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) best = Math.min(best, distanceToSegment(p, line[i - 1]!, line[i]!));
  return best;
}

const meanDistance = (from: Pt[], to: Pt[]) => from.reduce((sum, p) => sum + distanceToPolyline(p, to), 0) / from.length;

/** How far apart two outlines are, averaged both ways (so a stroke that covers
 *  only part of the template, or the template only part of the stroke, scores badly). */
function outlineGap(stroke: Pt[], template: Pt[]): number {
  return (meanDistance(stroke, template) + meanDistance(resample(template, stroke.length), stroke)) / 2;
}

function snapAxis(a: Pt, b: Pt): [Pt, Pt] {
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const near = (target: number) => Math.abs(Math.atan2(Math.sin(angle - target), Math.cos(angle - target))) < AXIS_SNAP;
  if (near(0) || near(Math.PI)) return [a, [b[0], a[1]]];
  if (near(Math.PI / 2) || near(-Math.PI / 2)) return [a, [a[0], b[1]]];
  return [a, b];
}

function asLine(pts: Pt[]): RecognizedShape | null {
  const first = pts[0]!, last = pts[pts.length - 1]!;
  const chord = dist(first, last);
  if (chord < MIN_LENGTH) return null;
  const deviation = Math.max(...pts.map((p) => distanceToSegment(p, first, last)));
  if (deviation > chord * LINE_DEVIATION) return null;
  const [start, end] = snapAxis(first, last);
  return { kind: "line", start, end };
}

/** A shaft with a head: out to the tip, then back and forth along two barbs.
 *  The tip is where the stroke first gets as far as it ever does from its start. */
function asArrow(pts: Pt[]): RecognizedShape | null {
  const first = pts[0]!;
  // The pen passes the tip again on its way back, so take the first point that
  // is (nearly) as far as any.
  const reachFromStart = Math.max(...pts.map((p) => dist(first, p)));
  let tipAt = pts.findIndex((p) => dist(first, p) >= reachFromStart * 0.97);
  // That point can sit a little short of the turn; walk on to where the first
  // pass stops getting farther, or a small head's barbs look like they point
  // past the tip.
  while (tipAt + 1 < pts.length && dist(first, pts[tipAt + 1]!) >= dist(first, pts[tipAt]!)) tipAt++;
  const tip = pts[tipAt]!;
  const shaft = dist(first, tip);
  if (shaft < MIN_LENGTH || tipAt >= pts.length - 3) return null;
  const toTip = pts.slice(0, tipAt + 1);
  if (Math.max(...toTip.map((p) => distanceToSegment(p, first, tip))) > shaft * LINE_DEVIATION) return null;
  const head = pts.slice(tipAt);
  const reach = Math.max(...head.map((p) => dist(p, tip)));
  // Barbs are shorter than the shaft, and the pen went out and came back at least twice.
  if (reach < shaft * 0.1 || reach > shaft * 0.5 || pathLength(head) < reach * 2.2) return null;
  // Both barbs lie on the shaft's side of the tip, within a cone around it.
  const shaftAngle = Math.atan2(first[1] - tip[1], first[0] - tip[0]);
  for (const p of head) {
    if (dist(p, tip) < reach * 0.3) continue;
    const off = Math.atan2(p[1] - tip[1], p[0] - tip[0]) - shaftAngle;
    if (Math.abs(Math.atan2(Math.sin(off), Math.cos(off))) > (60 * Math.PI) / 180) return null;
  }
  const [start, end] = snapAxis(first, tip);
  return { kind: "arrow", start, end };
}

const CLOSED_KINDS: Array<Exclude<RecognizedKind, "line" | "arrow">> = ["rectangle", "ellipse", "triangle", "diamond"];

function asClosed(pts: Pt[], box: { left: number; top: number; right: number; bottom: number }): RecognizedShape | null {
  const w = box.right - box.left, h = box.bottom - box.top;
  const diagonal = Math.hypot(w, h);
  // A needle is a line, not a closed shape.
  if (Math.min(w, h) < diagonal * 0.12) return null;
  let best: { kind: RecognizedKind; gap: number } | null = null;
  for (const kind of CLOSED_KINDS) {
    const template = inkShapePolylines({ kind, start: [box.left, box.top], end: [box.right, box.bottom], size: 1 } as Pick<InkShape, "kind" | "start" | "end" | "size">);
    if (!template) continue;
    const gap = outlineGap(pts, resample(template[0]!, 96)) / diagonal;
    if (!best || gap < best.gap) best = { kind, gap };
  }
  if (!best || best.gap > CLOSED_FIT) return null;
  let { left, top, right, bottom } = box;
  if (best.kind === "ellipse" && Math.abs(w - h) <= Math.max(w, h) * CIRCLE_RATIO) {
    const side = (w + h) / 2;
    left = (box.left + box.right) / 2 - side / 2; right = left + side;
    top = (box.top + box.bottom) / 2 - side / 2; bottom = top + side;
  }
  return { kind: best.kind, start: [left, top], end: [right, bottom] };
}

/** The shape this stroke was meant to be, or null to keep it as drawn. */
export function recognizeShape(points: ReadonlyArray<InkPoint>): RecognizedShape | null {
  if (points.length < 4) return null;
  const raw: Pt[] = points.map((p) => [p[0], p[1]]);
  if (raw.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return null;
  const length = pathLength(raw);
  const box = {
    left: Math.min(...raw.map((p) => p[0])), top: Math.min(...raw.map((p) => p[1])),
    right: Math.max(...raw.map((p) => p[0])), bottom: Math.max(...raw.map((p) => p[1])),
  };
  if (length < MIN_LENGTH || Math.hypot(box.right - box.left, box.bottom - box.top) < MIN_DIAGONAL) return null;
  const pts = resample(raw, 64);
  const joined = dist(raw[0]!, raw[raw.length - 1]!) <= length * CLOSE_GAP;
  return joined ? asClosed(pts, box) : asLine(pts) ?? asArrow(resample(raw, 160));
}
