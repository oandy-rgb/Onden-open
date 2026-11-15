import { describe, it, expect } from "vitest";
import { capGraphNodes, GRAPH_NODE_CAP } from "./graphCap";

const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i}` }));

describe("capGraphNodes", () => {
  it("returns everything untouched when under the cap", () => {
    const nodes = mk(10);
    const r = capGraphNodes(nodes, 50);
    expect(r.capped).toBe(false);
    expect(r.total).toBe(10);
    expect(r.shown).toBe(nodes); // same reference — no copy when under cap
  });

  it("returns everything untouched at exactly the cap", () => {
    const r = capGraphNodes(mk(5), 5);
    expect(r.capped).toBe(false);
    expect(r.shown).toHaveLength(5);
  });

  it("truncates to the cap and reports the original total", () => {
    const r = capGraphNodes(mk(500), 400);
    expect(r.capped).toBe(true);
    expect(r.total).toBe(500);
    expect(r.shown).toHaveLength(400);
    // Stable slice — keeps the head, preserving layout across renders.
    expect(r.shown[0].id).toBe("n0");
    expect(r.shown[399].id).toBe("n399");
  });

  it("always keeps the selected node even when it sits past the cap", () => {
    const r = capGraphNodes(mk(500), 400, "n450");
    expect(r.shown).toHaveLength(400);
    expect(r.shown.some((n) => n.id === "n450")).toBe(true);
  });

  it("does not duplicate the selected node when already in the slice", () => {
    const r = capGraphNodes(mk(500), 400, "n10");
    expect(r.shown.filter((n) => n.id === "n10")).toHaveLength(1);
    expect(r.shown).toHaveLength(400);
  });

  it("tolerates a selected id that does not exist", () => {
    const r = capGraphNodes(mk(500), 400, "ghost");
    expect(r.shown).toHaveLength(400);
  });

  it("defaults to GRAPH_NODE_CAP", () => {
    const r = capGraphNodes(mk(GRAPH_NODE_CAP + 50));
    expect(r.shown).toHaveLength(GRAPH_NODE_CAP);
    expect(r.capped).toBe(true);
  });
});
