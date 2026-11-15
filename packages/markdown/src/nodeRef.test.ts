import { describe, expect, it } from "vitest";
import { embedMatches, nodeRefId, nodeRefTarget, wikilinkBodies, wikilinkTarget } from "./index.js";

const ID = "3f2b8c1e-5a4d-4e6f-9b0a-1c2d3e4f5a6b";

describe("node reference targets", () => {
  it("round-trips an id and ignores titles", () => {
    expect(nodeRefId(nodeRefTarget(ID.toUpperCase()))).toBe(ID);
    expect(nodeRefId("Buy milk")).toBeNull();
    expect(nodeRefId("onden://node/not-an-id")).toBeNull();
  });

  it("reads as an ordinary link target and embed target", () => {
    const text = `See [[${nodeRefTarget(ID)}|Buy milk]]\n\n![[${nodeRefTarget(ID)}]]`;
    const [link] = wikilinkBodies(text);
    expect(wikilinkTarget(link!)).toBe(nodeRefTarget(ID));
    expect(nodeRefId(wikilinkTarget(link!))).toBe(ID);
    const [embed] = embedMatches(text);
    expect(embed?.target).toBe(nodeRefTarget(ID));
    expect(embed?.blockId).toBeNull();
  });
});
