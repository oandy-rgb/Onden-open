// groupNodes replaces the sidebar's quadratic "which notes have children"
// scan; it must pick exactly the same notes, in list order.
import { describe, expect, it } from "vitest";
import { groupNodes } from "../lib/utils";

const node = (id: string, parent_id: string | null = null) => ({ id, parent_id });
const quadratic = (nodes: Array<{ id: string; parent_id: string | null }>) =>
  nodes.filter((n) => nodes.some((c) => c.parent_id === n.id));

/** The notes, with every id / parent_id read counted. Past `budget` reads it
 *  throws, so a quadratic regression fails at once instead of running ~N². */
function counted(plain: Array<{ id: string; parent_id: string | null }>, budget: number) {
  let count = 0;
  const read = <T,>(value: T) => {
    if (++count > budget) throw new Error(`more than ${budget} id / parent_id reads`);
    return value;
  };
  const nodes = plain.map(({ id, parent_id }) => ({
    get id() { return read(id); },
    get parent_id() { return read(parent_id); },
  }));
  return { nodes, reads: () => count };
}

describe("groupNodes", () => {
  it("matches the old scan: parents present in the list, in list order", () => {
    const nodes = [node("a"), node("b", "a"), node("c"), node("d", "c"), node("e", "missing"), node("f", "d"), node("g")];
    expect(groupNodes(nodes).map((n) => n.id)).toEqual(["a", "c", "d"]);
    expect(groupNodes(nodes)).toEqual(quadratic(nodes));
  });

  it("ignores children whose parent is not in the list", () => {
    expect(groupNodes([node("x", "y")])).toEqual([]);
  });

  // Counts property reads instead of timing: a wall-clock budget failed on a
  // busy machine, while the count is the same on any machine. The linear
  // grouping reads each note's id and parent_id about once; any per-note scan
  // of the list (the old quadratic one read ~N² ids) is thousands of times over.
  it("reads each note a constant number of times at 20,000 notes", () => {
    const N = 20_000;
    const notes = Array.from({ length: N }, (_, i) => node(`n${i}`, i % 5 ? `n${i - (i % 5)}` : null));
    const { nodes, reads } = counted(notes, 3 * N);
    expect(groupNodes(nodes)).toHaveLength(4_000);
    expect(reads()).toBeGreaterThan(0);
  });
});
