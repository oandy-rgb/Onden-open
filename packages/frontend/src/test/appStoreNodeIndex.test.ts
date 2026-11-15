// getNode / useNode read the store's nodes through an id index that must always agree with the array.
import { beforeEach, describe, expect, it } from "vitest";
import { getAppState, getNode, resetAppState, setData } from "../lib/appStore";
import type { ContentNode } from "../lib/api";

const note = (id: string, title = id): ContentNode => ({ id, title, node_type: "content" } as ContentNode);
const agrees = () => {
  const { nodes } = getAppState().data;
  for (const n of nodes) expect(getNode(n.id)).toBe(nodes.find((x) => x.id === n.id));
  expect(getNode("missing")).toBeUndefined();
};

beforeEach(() => resetAppState());

describe("getNode", () => {
  it("follows add, update, delete and wholesale replacement", () => {
    setData((d) => ({ ...d, nodes: [note("a"), note("b")] }));
    agrees();
    setData((d) => ({ ...d, nodes: [...d.nodes, note("c")] }));
    expect(getNode("c")?.title).toBe("c");
    setData((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === "a" ? { ...n, title: "A2" } : n)) }));
    expect(getNode("a")?.title).toBe("A2");
    agrees();
    setData((d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== "b") }));
    expect(getNode("b")).toBeUndefined();
    setData((d) => ({ ...d, nodes: [note("z")] }));
    expect(getNode("a")).toBeUndefined();
    agrees();
  });
  it("follows an optimistic update and its rollback", () => {
    setData((d) => ({ ...d, nodes: [note("a", "old")] }));
    const before = getAppState().data;
    setData((d) => ({ ...d, nodes: d.nodes.map((n) => ({ ...n, title: "optimistic" })) }));
    expect(getNode("a")?.title).toBe("optimistic");
    setData(before);
    expect(getNode("a")?.title).toBe("old");
    agrees();
  });
  it("returns the first row for a duplicate id, like find, and undefined for no id", () => {
    setData((d) => ({ ...d, nodes: [note("a", "first"), note("a", "second")] }));
    expect(getNode("a")?.title).toBe("first");
    expect(getNode(null)).toBeUndefined();
  });
});
