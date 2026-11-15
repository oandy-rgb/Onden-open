import { afterEach, describe, expect, it } from "vitest";
import type { NodeChange } from "@xyflow/react";
import { heldMoves, holdCardsAt, releaseCards } from "../lib/cardLift";

// A held card swells from the point under the finger (CardNode.css reads --lift-x/--lift-y).

function board(zoom: number) {
  document.body.innerHTML = `<div id="board">
    <div class="react-flow__node react-flow__node-card" data-id="a"><div class="card-node"></div></div>
    <div class="react-flow__node react-flow__node-card" data-id="b"><div class="card-node"></div></div>
  </div>`;
  const place = (id: string, left: number, top: number) => {
    const card = document.querySelector<HTMLElement>(`[data-id="${id}"] .card-node`)!;
    Object.defineProperty(card, "offsetWidth", { value: 200 });
    card.getBoundingClientRect = () => ({ left, top, width: 200 * zoom, height: 100 * zoom, right: left + 200 * zoom, bottom: top + 100 * zoom, x: left, y: top, toJSON() {} }) as DOMRect;
    return card;
  };
  return { board: document.getElementById("board")!, a: place("a", 100, 300), b: place("b", 400, 300) };
}

describe("holdCardsAt", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("records the pressed point in the card's own pixels, whatever the zoom", () => {
    const { board: root, a } = board(0.5);
    holdCardsAt(root, { clientX: 140, clientY: 320 } as MouseEvent, ["a"]);
    expect(a.style.getPropertyValue("--lift-x")).toBe("80px"); // 40 screen px at half zoom
    expect(a.style.getPropertyValue("--lift-y")).toBe("40px");
  });

  it("reads a touch press, and marks every dragged card but only those", () => {
    const { board: root, a, b } = board(1);
    holdCardsAt(root, { touches: [{ clientX: 150, clientY: 330 }], changedTouches: [] } as unknown as TouchEvent, ["a"]);
    expect(a.style.getPropertyValue("--lift-x")).toBe("50px");
    expect(b.style.getPropertyValue("--lift-x")).toBe("");
  });

  it("releaseCards puts the origin back", () => {
    const { board: root, a } = board(1);
    holdCardsAt(root, { clientX: 150, clientY: 330 } as MouseEvent, ["a"]);
    releaseCards(root);
    expect(a.style.getPropertyValue("--lift-x")).toBe("");
    expect(a.style.getPropertyValue("--lift-y")).toBe("");
  });
});

describe("heldMoves", () => {
  it("keeps the moves of a card being dragged and drops an arrow-key nudge, selection and size changes", () => {
    const changes: NodeChange[] = [
      { id: "a", type: "position", position: { x: 1, y: 2 }, dragging: true },
      { id: "b", type: "position", position: { x: 5, y: 0 }, dragging: false }, // keyboard nudge, or the end of a drag
      { id: "c", type: "position", dragging: true }, // no position
      { id: "d", type: "select", selected: true },
    ];
    expect(heldMoves(changes).map((c) => c.id)).toEqual(["a"]);
  });
});
