import { describe, expect, it } from "vitest";
import { parseGfmTree } from "./gfmTree.js";

describe("parseGfmTree", () => {
  it("reads GFM task items with source offsets", () => {
    const tree = parseGfmTree("- [x] done\n- [ ] open\n");
    const list = tree.children[0];
    expect(list?.type).toBe("list");
    if (list?.type !== "list") return;
    expect(list.children.map((item) => item.checked)).toEqual([true, false]);
    expect(list.children[1]?.position?.start.offset).toBe(11);
  });

  it("reads GFM tables and autolink literals", () => {
    const tree = parseGfmTree("| a |\n| - |\n| b |\n\nhttps://example.com");
    expect(tree.children.map((n) => n.type)).toEqual(["table", "paragraph"]);
  });
});
