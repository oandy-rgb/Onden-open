// How the graph reads and answers a touch: how big a point is, which names are
// written at a zoom level (and not on top of each other), and the two-step tap
// (first tap lights a note and its neighbours, a second tap on it opens it — the
// same on a phone, where there is no hover to preview).

/** Radius in graph units: grows with the square root of the line count so a hub is clearly larger, not huge. */
export function nodeRadius(lines: number): number {
  return Math.min(4 + 1.5 * Math.sqrt(lines), 13);
}

/**
 * How many names the screen has room for at `scale` (screen px per graph unit):
 * far out only the best-linked points are named, up close all of them.
 */
export function labelBudget(scale: number): number {
  return Math.max(5, Math.round(8 * scale * scale));
}

type Rect = { x: number; y: number; w: number; h: number };

/** One frame's name placement: a name is written only if it does not cover one already placed. */
export function createLabelPlacer() {
  const placed: Rect[] = [];
  return {
    /** Claim the rectangle (centre x, top y); false when it overlaps an earlier name. */
    tryPlace(rect: Rect): boolean {
      const left = rect.x - rect.w / 2;
      for (const p of placed) {
        if (left < p.x + p.w / 2 && left + rect.w > p.x - p.w / 2 && rect.y < p.y + p.h && rect.y + rect.h > p.y) return false;
      }
      placed.push(rect);
      return true;
    },
    reset() { placed.length = 0; },
  };
}

/** Whether a point's name is written: the lit ones always, the rest by rank (0 = most lines) within the budget. */
export function showsLabel(rank: number, scale: number, lit: boolean): boolean {
  return lit || rank < labelBudget(scale);
}

/** The ids lit when `id` is tapped: itself and the other end of each of its lines. */
export function neighbourhoodOf(id: string, lines: readonly { source: unknown; target: unknown }[]): Set<string> {
  const idOf = (end: unknown) => typeof end === "object" && end !== null ? (end as { id?: unknown }).id : end;
  const lit = new Set<string>([id]);
  for (const l of lines) {
    const a = idOf(l.source);
    const b = idOf(l.target);
    if (a === id && typeof b === "string") lit.add(b);
    if (b === id && typeof a === "string") lit.add(a);
  }
  return lit;
}

/** A tap on a point: the first lights it, a tap on the lit one opens it. */
export function tapStep(lit: string | null, tapped: string): { lit: string | null; open: string | null } {
  return lit === tapped ? { lit: null, open: tapped } : { lit: tapped, open: null };
}
