type Frame = { id: string; x: number; y: number; width: number };
export type SectionHeading = { left: number; top: number; width: number; scale: number };
const HEIGHT = 44;
const GAP = 6;

/** Display-only headings above their frames. Positions use canvas coordinates;
 * width stays in screen pixels via scale. Stable ordering keeps labels from
 * changing lanes when selection or the input array order changes. */
export function layoutSectionHeadings(frames: readonly Frame[], zoom: number): Map<string, SectionHeading> {
  const scale = 1 / Math.max(0.1, zoom);
  const placed: Array<{ x: number; y: number; width: number }> = [];
  const result = new Map<string, SectionHeading>();
  // Lower frames keep their near-border slot first; overlapping frames above
  // them lift their headings, preserving the reading order of nested groups.
  for (const frame of [...frames].sort((a, b) => b.y - a.y || a.x - b.x || a.id.localeCompare(b.id))) {
    const x = frame.x / scale + 8;
    const width = Math.min(240, Math.max(220, frame.width / scale - 16));
    let y = frame.y / scale - HEIGHT - GAP;
    // Move only the label, never its frame or members. Each collision moves
    // upward past one existing heading, so the search always terminates.
    let collision;
    while ((collision = placed.find(p => x < p.x + p.width + GAP && x + width + GAP > p.x
      && y < p.y + HEIGHT + GAP && y + HEIGHT + GAP > p.y))) {
      y = Math.floor(collision.y) - HEIGHT - GAP;
    }
    placed.push({ x, y, width });
    result.set(frame.id, { left: 8 * scale, top: (y - frame.y / scale) * scale, width, scale });
  }
  return result;
}
