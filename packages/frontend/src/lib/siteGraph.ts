// The note graph of a published site, as plain data and a layout of it. The data is
// `/site/graph.json` (siteGraph in components/siteFrame/siteModel.ts: published notes
// and the links between them, nothing else); the drawing is siteGraphView.ts. No DOM here.

/** One entry per published note, and a `[from, to]` pair of indexes into `notes` per link. */
export type SiteGraph = { notes: Array<{ id: string; title: string; slug: string }>; links: Array<[number, number]> };

/** `centre` and the notes it links to or that link to it, with the links among them (the graph of one page).
 *  Null when `centre` is not a note of the graph. */
export function neighbourhood(graph: SiteGraph, centreId: string): SiteGraph | null {
  const centre = graph.notes.findIndex((n) => n.id === centreId);
  if (centre < 0) return null;
  const keep = new Set<number>([centre]);
  for (const [from, to] of graph.links) {
    if (from === centre) keep.add(to);
    else if (to === centre) keep.add(from);
  }
  const order = [centre, ...[...keep].filter((i) => i !== centre)];
  const local = new Map(order.map((old, i) => [old, i]));
  return {
    notes: order.map((i) => graph.notes[i]!),
    links: graph.links.flatMap(([from, to]): Array<[number, number]> => {
      const a = local.get(from);
      const b = local.get(to);
      return a === undefined || b === undefined ? [] : [[a, b]];
    }),
  };
}

export type Point = { x: number; y: number };

const GRAVITY = 1.2;

/** Positions in a `width × height` box (a force layout: links pull, notes push apart; the same graph always lays out the same). */
export function layoutGraph(count: number, links: ReadonlyArray<readonly [number, number]>, width: number, height: number): Point[] {
  if (count === 0) return [];
  if (count === 1) return [{ x: width / 2, y: height / 2 }];
  const area = width * height;
  const k = Math.sqrt(area / count) * 0.8;
  // Start on a spiral from the middle, so the first note (the centre of a page's graph) stays in the middle.
  const pos = Array.from({ length: count }, (_, i) => {
    const angle = i * 2.399963;
    const radius = (k * 0.6 * Math.sqrt(i));
    return { x: width / 2 + Math.cos(angle) * radius, y: height / 2 + Math.sin(angle) * radius };
  });
  let temperature = Math.min(width, height) / 6;
  const steps = count > 400 ? 60 : 200;
  for (let step = 0; step < steps; step++) {
    const move = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        let dx = pos[i]!.x - pos[j]!.x;
        let dy = pos[i]!.y - pos[j]!.y;
        let d = Math.hypot(dx, dy);
        if (d < 0.01) { dx = 0.01 * (i - j); dy = 0.01; d = Math.hypot(dx, dy); }
        const push = (k * k) / d / d;
        move[i]!.x += dx * push; move[i]!.y += dy * push;
        move[j]!.x -= dx * push; move[j]!.y -= dy * push;
      }
    }
    for (const [a, b] of links) {
      const dx = pos[a]!.x - pos[b]!.x;
      const dy = pos[a]!.y - pos[b]!.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const pull = d / k;
      move[a]!.x -= dx * pull; move[a]!.y -= dy * pull;
      move[b]!.x += dx * pull; move[b]!.y += dy * pull;
    }
    for (let i = 0; i < count; i++) {
      // A pull to the middle (as strong as the push of a crowd of notes at the same distance) keeps notes
      // with no links near the rest instead of far out, which would shrink the connected part when fitted below.
      move[i]!.x += (width / 2 - pos[i]!.x) * GRAVITY;
      move[i]!.y += (height / 2 - pos[i]!.y) * GRAVITY;
      const len = Math.hypot(move[i]!.x, move[i]!.y) || 1;
      const cap = Math.min(len, temperature);
      pos[i]!.x += (move[i]!.x / len) * cap;
      pos[i]!.y += (move[i]!.y / len) * cap;
    }
    temperature *= 0.97;
  }
  // Fit into the box with a margin.
  const margin = 28;
  const xs = pos.map((p) => p.x), ys = pos.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min((width - margin * 2) / (maxX - minX || 1), (height - margin * 2) / (maxY - minY || 1));
  const s = Math.min(scale, 1.6);
  const offX = width / 2 - ((minX + maxX) / 2) * s;
  const offY = height / 2 - ((minY + maxY) / 2) * s;
  return pos.map((p) => ({ x: p.x * s + offX, y: p.y * s + offY }));
}

/** A label cut to `max` characters (one CJK character counts one, like a Latin one). */
export function shortLabel(title: string, max: number): string {
  const chars = [...title.trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}
