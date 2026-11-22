// The space a note is in follows its tree (spine/stampedMerge/rules/space.ts), over the parents after the 4.10 cut of loops. Pure: no database.
// Review of PR #1907, round 1, point 2: the cut must report every former parent it needs and does not hold, in any round, so the loader can load it and ask again;
// and the answer must not depend on which other notes happen to be loaded.
import { describe, expect, it } from "vitest";
import { cutParents, spacesOfTree, type SpaceTreeRow } from "../spine/stampedMerge/rules/space.js";
import type { ParentLink } from "../spine/stampedMerge/rules/moveCycle.js";
import type { Stamp } from "../spine/stampedMerge/unit.js";

const st = (seq: number, origin = "n1"): Stamp => ({ origin, seq, wall: 1_000 + seq, counter: 0, author: "u1", device: null });
const row = (parent: string | null, written: string | null = "S1"): SpaceTreeRow => ({ parent, written, tag: false });
/** links: note → (stamp of its winning parent write, the parent it was moved from; undefined: made there) */
const linksOf = (l: Record<string, [number, (string | null)?]>) => (id: string): ParentLink => {
  const x = l[id];
  if (!x) return { note: id, parent: null, stamp: st(0, "genesis") };
  return { note: id, parent: null, stamp: st(x[0]), ...(x.length > 1 ? { from: x[1] ?? null } : {}) };
};

describe("the cut a note's space follows (rules/space.ts cutParents)", () => {
  it("a loop whose undone move goes back under a note that is not loaded: that note is reported missing, and the walk does not guess", () => {
    // X under Y, Y under X; Y's move (seq 5) is the later one, from W, which the caller has not loaded
    const rows = new Map([["X", row("Y")], ["Y", row("X")]]);
    const r = cutParents(rows, linksOf({ X: [3, null], Y: [5, "W"] }));
    expect(r.missing).toEqual(["W"]);
    // with W (and its ancestors) loaded, nothing is missing and Y is under W
    const more = new Map([...rows, ["W", row(null, "S2")]]);
    const again = cutParents(more, linksOf({ X: [3, null], Y: [5, "W"] }));
    expect(again.missing).toEqual([]);
    expect(again.parents.get("Y")).toBe("W");
    expect(spacesOfTree(more, again.parents, null)).toEqual(new Map([["W", "S2"], ["X", "S2"], ["Y", "S2"]]));
  });

  it("a cut that closes a second loop: it is cut too, no move is undone twice, and no loop is left", () => {
    // A→B→A; the later move (A, seq 9) goes back under C; C is under A: C→A→C, a second loop. The next latest undoable move is cut there.
    const rows = new Map([["A", row("B")], ["B", row("A")], ["C", row("A")]]);
    const links = linksOf({ A: [9, "C"], B: [4, null], C: [7, "D"] });
    const r = cutParents(rows, links);
    // A goes back under C, then C (seq 7) goes back under D, which is not loaded
    expect(r.parents.get("A")).toBe("C");
    expect(r.missing).toEqual(["D"]);
    const withD = new Map([...rows, ["D", row(null, "S3")]]);
    const final = cutParents(withD, links);
    expect(final.missing).toEqual([]);
    expect(final.parents).toEqual(new Map([["A", "C"], ["B", "A"], ["C", "D"], ["D", null]]));
    expect([...spacesOfTree(withD, final.parents, null).values()]).toEqual(["S3", "S3", "S3", "S3"]);
  });

  it("the answer for a loop does not depend on which other notes are loaded", () => {
    const loop = new Map([["X", row("Y")], ["Y", row("Z")], ["Z", row("X")], ["W", row(null, "S2")]]);
    const links = linksOf({ X: [3, "W"], Y: [5, null], Z: [8, "W"] });
    const alone = cutParents(loop, links);
    const crowded = cutParents(new Map([...loop, ["Q", row(null, "S9")], ["R", row("Q")], ["T", row("R")]]), links);
    for (const id of loop.keys()) expect(crowded.parents.get(id), id).toBe(alone.parents.get(id));
    expect(alone.parents.get("Z")).toBe("W"); // the latest undoable move
  });
});
