import { describe, it, expect } from "vitest";
import { frozenQueryBlock, queryBlocksIn, type FrozenQueryBlock } from "./queryBlocks.js";

describe("query blocks (D113)", () => {
  it("finds onden-query and onden-base fences in order, each once, inside containers too", () => {
    const md = [
      "---", "title: x", "---",
      "```onden-query", "tags: a", "```",
      "> ```onden-base", "> views:", ">   - type: list", "> ```",
      "```onden-query", "tags: a", "```",
      "```js", "onden-query", "```",
      "Inline `onden-query` is not a block.",
    ].join("\n");
    expect(queryBlocksIn(md)).toEqual([
      { lang: "onden-query", source: "tags: a" },
      { lang: "onden-base", source: "views:\n  - type: list" },
    ]);
    expect(queryBlocksIn("no blocks here")).toEqual([]);
  });

  it("a renderer finds a block's result by its text, trailing newline or not", () => {
    const block: FrozenQueryBlock = { lang: "onden-query", source: "tags: a", columns: [], rows: [], more: 0 };
    expect(frozenQueryBlock([block], "onden-query", "tags: a\n")).toBe(block);
    expect(frozenQueryBlock([block], "onden-base", "tags: a")).toBeNull();
    expect(frozenQueryBlock(undefined, "onden-query", "tags: a")).toBeNull();
  });
});
