import { expect, it } from "vitest";
import { diffBoard } from "../lib/boardLayout";

// Scan 08 #3: taking a group frame off the board is a layout change that names that frame only,
// so the cards inside (and frames added elsewhere meanwhile) are not touched.
it("a layout without one frame removes that frame and nothing else", () => {
  const frame = (id: string) => ({ id, x: 0, y: 0, width: 400, height: 300, title: id });
  const before = { nodes: [{ nodeId: "a", x: 10, y: 10 }], sections: [frame("keep"), frame("gone")] };
  const after = { nodes: before.nodes, sections: [frame("keep")] };
  expect(diffBoard(before, after)).toEqual({ sections: { remove: ["gone"] } });
});
