import { describe, it, expect } from "vitest";
import type { Node } from "@xyflow/react";
import {
  minimapNodeColor,
  minimapNodeStroke,
  MINIMAP_DEFAULT_CARD,
  MINIMAP_SECTION,
} from "../lib/canvasMinimap";

function node(partial: Partial<Node>): Node {
  return { id: "n1", position: { x: 0, y: 0 }, data: {}, ...partial } as Node;
}

describe("minimapNodeColor", () => {
  it("uses the card's own swatch when data.color is set", () => {
    expect(minimapNodeColor(node({ type: "card", data: { color: "#ef4444" } }))).toBe("#ef4444");
  });

  it("falls back to the neutral card grey for an uncoloured card", () => {
    expect(minimapNodeColor(node({ type: "card", data: {} }))).toBe(MINIMAP_DEFAULT_CARD);
    expect(minimapNodeColor(node({ type: "card", data: { color: "" } }))).toBe(MINIMAP_DEFAULT_CARD);
    expect(minimapNodeColor(node({ type: "card", data: { color: 123 } }))).toBe(MINIMAP_DEFAULT_CARD);
  });

  it("renders sections in the structural line tone regardless of any colour", () => {
    expect(minimapNodeColor(node({ type: "section", data: {} }))).toBe(MINIMAP_SECTION);
    expect(minimapNodeColor(node({ type: "section", data: { color: "#ef4444" } }))).toBe(MINIMAP_SECTION);
  });
});

describe("minimapNodeStroke", () => {
  it("rings selected nodes with the accent token, transparent otherwise", () => {
    expect(minimapNodeStroke(node({ type: "card", selected: true }))).toBe("var(--ac-accent)");
    expect(minimapNodeStroke(node({ type: "card", selected: false }))).toBe("transparent");
    expect(minimapNodeStroke(node({ type: "card" }))).toBe("transparent");
  });
});
