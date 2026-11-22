// A note's space follows its tree (docs/architecture/proposals/merge-cross-field-invariants-2026-11-19.md, as built in PR "fix/merge-space-follows-parent").
//
// The space a person WRITES is a unit (`space`, the column content_nodes.written_space_id). It only means something for a note at the top of its tree: a note under
// another note is in that note's space, whatever was written for it. So the space a note IS in (content_nodes.space_id, what every read and the deferred check
// content_nodes_check_space read) is DERIVED: the written space of its top ancestor. It is never a unit, never stamped, never sent as the value of a stamp.
//
// The parents used are the merged parents with the 4.10 cut applied (rules/moveCycle.ts): parent_id keeps the parent as merged, a loop included, and the cut is a view
// used here only. A merge never writes the cut back (that would be a write nobody made, which replicas would then fight over; Wallace, "CRDT: Mutable Tree Hierarchy").
// Every member of a loop reaches the top through the cut note, so they all get one space and the deferred check (which reads parent_id) holds.
//
// The same rule holds locally without this function: a local write keeps a child in its parent's space (services/nodeTree.ts, services/spaces.ts move the whole
// subtree; content_nodes_check_space checks it at COMMIT) and a note at the top keeps space_id = written_space_id (content_nodes_derive_space, migration 218).
// A merge computes the one assignment that satisfies both from the replicated state, so two nodes holding the same rows and stamps hold the same space_id.
//
//   const { parents } = cutParents(rows, linkOf);      // effective parents (null: top); `missing` must be empty first. The simulator (mergeCrossFieldSim.test.ts) calls the same two
//   const spaces = spacesOfTree(rows, parents, fallback);
import { type ParentLink, resolveMoveCycles } from "./moveCycle.js";

/** A note as the tree sees it: its parent as merged (null: none here), the space written for it, and whether it is a tag (a tag has no space). */
export type SpaceTreeRow = { parent: string | null; written: string | null; tag: boolean };

/**
 * The parents a note's space follows: the merged parent, with every loop cut by the 4.10 rule (the latest move that can be undone goes back where it was). A parent
 * that is not among `rows` ends the walk there (a parent this node does not hold is no parent: the note is at the top). `linkOf` gives the winning parent write of
 * a note (its stamp and `meta.from`); it is asked for every note once there is a loop. `missing`: the former parents a cut, in ANY round, put a note back under and that
 * `rows` does not hold. The answer is a function of the rows only once `missing` is empty: the caller loads those notes (and their ancestors) and asks again
 * (dbRows.ts NoteTree; review of PR #1907, round 1, point 2: only the first round's former parents were loaded, and the rest were taken for the top).
 */
export function cutParents(rows: ReadonlyMap<string, SpaceTreeRow>, linkOf: (id: string) => ParentLink): { parents: Map<string, string | null>; missing: string[] } {
  const parents = new Map<string, string | null>();
  for (const [id, r] of rows) parents.set(id, r.parent !== null && rows.has(r.parent) ? r.parent : null);
  if (loopMembers(parents).size === 0) return { parents, missing: [] };
  // ONE call over every note's parent write: a note put back under its former parent can close another loop through notes that were in none, and the call cuts
  // that one too without undoing the same move twice (a second call, as the first version made, could undo it again and leave the loop). Linked as the space
  // follows them; a loop is a property of the parents, the same on every node that holds them.
  const cut = resolveMoveCycles([...rows.keys()].sort().map((id) => ({ ...linkOf(id), note: id, parent: parents.get(id) ?? null })));
  const missing = new Set<string>();
  for (const [id, p] of cut.parents) {
    if (!rows.has(id)) continue;
    if (p !== null && !rows.has(p)) missing.add(p);
    parents.set(id, p !== null && rows.has(p) ? p : null);
  }
  return { parents, missing: [...missing].sort() };
}

/** The notes of `rows` that are on a loop of their merged parents (the notes whose parent write `cutParents` asks `linkOf` for). */
export function notesOnLoops(rows: ReadonlyMap<string, SpaceTreeRow>): string[] {
  const parents = new Map<string, string | null>();
  for (const [id, r] of rows) parents.set(id, r.parent !== null && rows.has(r.parent) ? r.parent : null);
  return [...loopMembers(parents)].sort();
}

/** The notes that are on a loop of `parents`. */
function loopMembers(parents: ReadonlyMap<string, string | null>): Set<string> {
  const out = new Set<string>(), done = new Set<string>();
  for (const start of [...parents.keys()].sort()) {
    if (done.has(start)) continue;
    const path: string[] = [], at = new Map<string, number>();
    let n: string | null | undefined = start;
    while (n !== null && n !== undefined && !done.has(n) && !at.has(n)) { at.set(n, path.length); path.push(n); n = parents.get(n); }
    if (n !== null && n !== undefined && at.has(n)) for (const m of path.slice(at.get(n))) out.add(m);
    for (const m of path) done.add(m);
  }
  return out;
}

/**
 * The space each note is in: a tag none; a note the written space of its top ancestor under `parents` (which has no loop: `cutParents`), and `fallback` (the
 * workspace's default space) when nothing was written for that top note. A parent that is a tag ends the walk (a note under a tag is a note at the top).
 */
export function spacesOfTree(rows: ReadonlyMap<string, SpaceTreeRow>, parents: ReadonlyMap<string, string | null>, fallback: string | null): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const of = (id: string): string | null => {
    const hit = out.get(id);
    if (hit !== undefined || out.has(id)) return hit ?? null;
    const path: string[] = [];
    let n: string = id;
    for (;;) {
      if (out.has(n)) break;
      path.push(n);
      const p = parents.get(n) ?? null;
      if (p === null || rows.get(p)?.tag || path.length > rows.size) break;
      n = p;
    }
    // the top of the path (or the first note already known) decides for every note on it
    const last = path[path.length - 1]!;
    const top = out.has(n) && n !== last ? out.get(n)! : (rows.get(last)!.written ?? fallback);
    for (const m of path) out.set(m, rows.get(m)!.tag ? null : top);
    return out.get(id)!;
  };
  for (const id of [...rows.keys()].sort()) of(id);
  return out;
}
