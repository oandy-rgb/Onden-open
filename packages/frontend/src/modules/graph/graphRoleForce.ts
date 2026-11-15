import type { GraphRole } from "../../lib/noteNeighborhood";
import { TAG_LINK_KIND } from "../../lib/edgeKinds";

// The 「完整關係」 layout: the centre note is pinned at the origin and its
// parent right above it; notes that link to it are pulled left, notes it
// links to right, sub-notes down, and its tags (the layer above notes) a row
// beyond the parent. Everything else is the ordinary force
// simulation (repulsion and links), so crowded groups still spread out.

/** Distance, in graph units, between the centre and the pinned or pulled groups. */
export const ROLE_DISTANCE = 130;
const ROLE_STRENGTH = 0.25;

// Tag lines are association, not structure: longer and weaker than the others,
// so notes of one tag gather near it without the tag hauling them into a ball.
const TAG_LINK_DISTANCE = 60;
const TAG_LINK_STRENGTH = 0.08;

type Pos = { x?: number; y?: number; vx?: number; vy?: number; fx?: number | null; fy?: number | null };
type IdNode = Pos & { id?: string | number };

type LinkLike = { type?: string; source?: unknown; target?: unknown };
const endId = (end: unknown) => String(typeof end === "object" && end !== null ? (end as { id?: unknown }).id : end);

/** Distance and strength for d3's link force. `base` is the length of an
 *  ordinary line (30 is d3's default). Ordinary lines keep d3's own strength,
 *  1 / the busier end's line count; tag lines get the weak, longer setting. */
export function linkTuning(links: readonly LinkLike[], base = 30) {
  const degree = new Map<string, number>();
  for (const l of links) for (const end of [endId(l.source), endId(l.target)]) degree.set(end, (degree.get(end) ?? 0) + 1);
  return {
    distance: (l: LinkLike) => l.type === TAG_LINK_KIND ? Math.max(TAG_LINK_DISTANCE, base) : base,
    strength: (l: LinkLike) => l.type === TAG_LINK_KIND
      ? TAG_LINK_STRENGTH
      : 1 / Math.max(1, Math.min(degree.get(endId(l.source)) ?? 1, degree.get(endId(l.target)) ?? 1)),
  };
}

/** Where a role pulls to; `undefined` on an axis means no pull on it. */
export const ROLE_TARGET: Record<GraphRole, { x?: number; y?: number }> = {
  parent: { x: 0, y: -ROLE_DISTANCE },
  in: { x: -ROLE_DISTANCE, y: 0 },
  out: { x: ROLE_DISTANCE, y: 0 },
  child: { x: 0, y: ROLE_DISTANCE },
  tag: { y: -ROLE_DISTANCE * 2 },
};

/** Pin the centre at the origin and the parent straight above it. */
export function pinFocusNodes<T extends IdNode>(node: T, centerId: string, roles: Record<string, GraphRole>): T {
  if (node.id === centerId) return { ...node, fx: 0, fy: 0 };
  if (node.id !== undefined && roles[String(node.id)] === "parent") return { ...node, fx: 0, fy: -ROLE_DISTANCE };
  return node;
}

/** A d3 force (usable with `d3Force(name, force)`) that nudges each node's velocity toward its role's side. */
export function roleForce(roles: Record<string, GraphRole>) {
  let nodes: IdNode[] = [];
  const force = (alpha: number) => {
    for (const n of nodes) {
      const target = n.id !== undefined ? ROLE_TARGET[roles[String(n.id)]] : undefined;
      if (!target) continue;
      if (target.x !== undefined) n.vx = (n.vx ?? 0) + (target.x - (n.x ?? 0)) * ROLE_STRENGTH * alpha;
      if (target.y !== undefined) n.vy = (n.vy ?? 0) + (target.y - (n.y ?? 0)) * ROLE_STRENGTH * alpha;
    }
  };
  force.initialize = (next: IdNode[]) => { nodes = next; };
  return force;
}
