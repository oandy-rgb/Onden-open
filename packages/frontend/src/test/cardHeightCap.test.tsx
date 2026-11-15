// GAP-175: a long note made its card ~4,500px tall. Cards without a saved
// height show at most BODY_MAX_H of the note and fade out (CardNode.css); media
// and embed cards keep their own size.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
vi.mock("@xyflow/react", () => ({
  useUpdateNodeInternals: () => () => {},
  useStore: (sel: (s: { transform: [number, number, number] }) => unknown) => sel({ transform: [0, 0, 1] }),
  Handle: () => null,
  NodeResizer: () => null,
  Position: { Top: "top", Right: "right", Bottom: "bottom", Left: "left" },
}));
import { CardNode } from "../components/CardNode";
import { BODY_MAX_H } from "../lib/cardDisplay";

function renderCard(content: string) {
  const props = { id: "n1", type: "card", selected: false, data: { label: "Card", content } } as unknown as Parameters<typeof CardNode>[0];
  return render(<CardNode {...props} />).container.querySelector(".card-node")!;
}

describe("card height cap", () => {
  it("the body limit in CSS is the one lib/cardDisplay names", () => {
    const css = readFileSync(resolve(__dirname, "../components/CardNode.css"), "utf8");
    expect(css).toMatch(new RegExp(`\\.card-node-body--limited\\s*\\{\\s*max-height:\\s*${BODY_MAX_H}px`));
  });

  it("a long note is a plain card; an image or a bare URL is a media card", () => {
    expect(renderCard(Array.from({ length: 200 }, (_, i) => `Paragraph ${i}`).join("\n\n")).classList.contains("card-node--media")).toBe(false);
    expect(renderCard("![photo](https://example.com/a.png)").classList.contains("card-node--media")).toBe(true);
    expect(renderCard("https://example.com/page").classList.contains("card-node--media")).toBe(true);
  });
});
