import { describe, it, expect } from "vitest";
import {
  toJsonCanvas, fromJsonCanvas, normalizeJsonCanvasColor,
  type ExportCard, type ExportSection,
} from "../lib/jsonCanvas";

// JSON Canvas (jsoncanvas.org) interop — the colour round-trip. Before this,
// export wrote a card's hex colour but import silently dropped it, so a board
// lost its colour semantics on re-import (and on any Obsidian → Onden import).
describe("jsonCanvas colour round-trip", () => {
  it("normalizeJsonCanvasColor: a short hex becomes #rrggbb in lower case, and an alpha form is dropped (the server stores #rrggbb only)", () => {
    expect(normalizeJsonCanvasColor("#FFF")).toBe("#ffffff");
    expect(normalizeJsonCanvasColor("#EF4444")).toBe("#ef4444");
    expect(normalizeJsonCanvasColor("#ef444480")).toBeUndefined();
    expect(normalizeJsonCanvasColor("#fff8")).toBeUndefined();
    expect(normalizeJsonCanvasColor("#ggg")).toBeUndefined();
  });

  it("normalizeJsonCanvasColor: hex passes through, presets map to Onden swatches, junk drops", () => {
    expect(normalizeJsonCanvasColor("#ef4444")).toBe("#ef4444");
    expect(normalizeJsonCanvasColor("1")).toBe("#ef4444"); // red preset
    expect(normalizeJsonCanvasColor("4")).toBe("#22c55e"); // green preset
    expect(normalizeJsonCanvasColor("6")).toBe("#a855f7"); // purple preset
    expect(normalizeJsonCanvasColor(undefined)).toBeUndefined();
    expect(normalizeJsonCanvasColor("")).toBeUndefined();
    expect(normalizeJsonCanvasColor("99")).toBeUndefined(); // unknown preset
  });

  it("export writes hex colour for cards and sections; omits it when unset", () => {
    const cards: ExportCard[] = [
      { id: "c1", x: 0, y: 0, title: "A", markdown: "a", color: "#3b82f6" },
      { id: "c2", x: 10, y: 10, title: "B", markdown: "b" }, // no colour
    ];
    const sections: ExportSection[] = [
      { id: "s1", x: 0, y: 0, width: 400, height: 300, title: "Grp", color: "#22c55e" },
    ];
    const jc = toJsonCanvas(cards, sections, []);
    const c1 = jc.nodes.find((n) => n.id === "c1")!;
    const c2 = jc.nodes.find((n) => n.id === "c2")!;
    const s1 = jc.nodes.find((n) => n.id === "group-s1")!;
    expect(c1.color).toBe("#3b82f6");
    expect("color" in c2).toBe(false);    // unset → field omitted (clean file)
    expect(s1.color).toBe("#22c55e");
  });

  it("import reads colour back onto cards and sections", () => {
    const parsed = fromJsonCanvas({
      nodes: [
        { id: "t1", type: "text", x: 0, y: 0, width: 240, height: 120, text: "# Hi\n\nbody", color: "#ef4444" },
        { id: "t2", type: "text", x: 5, y: 5, width: 240, height: 120, text: "plain" }, // no colour
        { id: "g1", type: "group", x: 0, y: 0, width: 400, height: 300, label: "G", color: "3" },
      ],
      edges: [],
    });
    expect(parsed.cards.find((c) => c.key === "t1")?.color).toBe("#ef4444");
    expect(parsed.cards.find((c) => c.key === "t2")?.color).toBeUndefined();
    expect(parsed.sections[0]?.color).toBe("#eab308"); // preset "3" → yellow
  });

  it("full round-trip preserves a card's colour (the bug this fixes)", () => {
    const cards: ExportCard[] = [{ id: "n1", x: 0, y: 0, title: "Idea", markdown: "x", color: "#a855f7" }];
    const jc = toJsonCanvas(cards, [], []);
    const back = fromJsonCanvas(jc);
    expect(back.cards[0]?.color).toBe("#a855f7");
  });
});
