// Two nodes each made the same function reference (same holder, function and instance, different ids): the earlier-created
// one stays, and every config key of the other is merged into it, key by key, by the ordinary unit merge. (The proposal's
// suggestion, distributed-ready 4.5 "not done yet" and add-device-snapshot §5; the owner is asked to confirm in the PR.)
import { type Cell, type Stamp, type Unit, compareStamps, sameContent } from "../unit.js";

type FunctionRefRow = { id: string; holder: string; fn: string; instance: string; created: Stamp; config: Readonly<Record<string, Unit>> };
/** One config key of the kept reference as it should read: the value that wins, and the other values (different content) that stay visible as conflicts. */
type MergedKey = { winner: Cell; conflicts: Cell[] };
export type MergedRef = { keepId: string; dropIds: string[]; config: Record<string, MergedKey> };

const naturalKey = (r: FunctionRefRow) => JSON.stringify([r.holder, r.fn, r.instance]);

/**
 * One entry per natural key that has more than one row. Rows with a unique natural key are not listed.
 * The keys of different rows are different units: a write's `saw` only speaks about its own unit, so nothing in one row's
 * config can be called "seen" by a write of the other row. Every head of every row is therefore taken as concurrent with
 * every head of the others; the latest stamp wins and any other content stays a conflict. The answer is a view: the caller
 * writes it to the kept row as ordinary writes (which then do see what that row holds).
 */
export function mergeDuplicateRefs(rows: readonly FunctionRefRow[]): MergedRef[] {
  const groups = new Map<string, FunctionRefRow[]>();
  for (const r of rows) groups.set(naturalKey(r), [...(groups.get(naturalKey(r)) ?? []), r]);
  const out: MergedRef[] = [];
  for (const [, g] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (g.length < 2) continue;
    g.sort((a, b) => compareStamps(a.created, b.created) || (a.id < b.id ? -1 : 1));
    const keys = [...new Set(g.flatMap((r) => Object.keys(r.config)))].sort();
    const config: Record<string, MergedKey> = {};
    for (const key of keys) {
      const heads = g.flatMap((r) => r.config[key] ?? []).sort((a, b) => compareStamps(b.stamp, a.stamp));
      const winner = heads[0]!;
      config[key] = { winner, conflicts: heads.filter((h) => !sameContent(h, winner)) };
    }
    out.push({ keepId: g[0]!.id, dropIds: g.slice(1).map((r) => r.id), config });
  }
  return out;
}
