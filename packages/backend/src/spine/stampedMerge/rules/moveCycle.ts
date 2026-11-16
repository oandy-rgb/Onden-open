// Two moves that together make a loop (4.10): the later one does not take effect, the note stays where it was, and the
// person who made that move is told. A view over the merged parent links, not a write.
import { type Stamp, compareStamps } from "../unit.js";

/** A note's parent as it stands, and (for a move) where the note was before it: `from` is undefined for a note that was made there and never moved. */
export type ParentLink = { note: string; parent: string | null; from?: string | null; stamp: Stamp };
export type CycleFix = { note: string; parent: string | null; notify: string | null };
export type CycleResolution = { fixes: CycleFix[]; parents: Map<string, string | null>; needsDecision: string[] };

function findCycle(parents: Map<string, string | null>): string[] | null {
  for (const start of [...parents.keys()].sort()) {
    const path: string[] = [];
    const at = new Map<string, number>();
    for (let n: string | null | undefined = start; n !== null && n !== undefined; n = parents.get(n)) {
      if (at.has(n)) return path.slice(at.get(n)!);
      at.set(n, path.length);
      path.push(n);
    }
  }
  return null;
}

export function resolveMoveCycles(links: readonly ParentLink[]): CycleResolution {
  const by = new Map(links.map((l) => [l.note, l]));
  const parents = new Map(links.map((l) => [l.note, l.parent]));
  const fixes: CycleFix[] = [], needsDecision: string[] = [];
  const reverted = new Set<string>();
  for (let guard = 0; guard <= links.length; guard++) {
    const cycle = findCycle(parents);
    if (!cycle) break;
    const edges = cycle.map((n) => by.get(n)!).sort((a, b) => compareStamps(b.stamp, a.stamp));
    // The latest move that can be undone: never one made where the note was created, and never the same one twice.
    const undo = edges.find((e) => e.from !== undefined && !reverted.has(e.note));
    const cut = undo ?? edges[0]!;
    reverted.add(cut.note);
    if (!undo) needsDecision.push(cut.note); // every edge of the loop is a creation: there is no earlier place to put it back
    const to = undo ? undo.from! : null;
    parents.set(cut.note, to);
    fixes.push({ note: cut.note, parent: to, notify: cut.stamp.author });
  }
  return { fixes, parents, needsDecision: needsDecision.sort() };
}
