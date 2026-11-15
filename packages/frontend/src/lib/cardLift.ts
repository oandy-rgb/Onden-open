import type { NodeChange } from "@xyflow/react";

// A card picked up on the whiteboard rises under the finger (CardNode.css, `.react-flow__node.dragging`):
// a deeper shadow and a slight scale. The scale grows from the point that is held, so the card does not
// slide away from under the finger. CSS cannot know where that is; this tells it, in the card's own pixels.

/** Remember, for each dragged card, where on it the press landed (`--lift-x/--lift-y`). */
export function holdCardsAt(board: ParentNode | null, press: MouseEvent | TouchEvent, cardIds: readonly string[]): void {
  const point = "touches" in press ? (press.touches[0] ?? press.changedTouches[0]) : press;
  if (!board || !point) return;
  for (const id of cardIds) {
    const card = [...board.querySelectorAll<HTMLElement>(".react-flow__node-card")].find((node) => node.dataset.id === id)
      ?.querySelector<HTMLElement>(".card-node");
    if (!card || !card.offsetWidth) continue;
    const box = card.getBoundingClientRect();
    const scale = box.width / card.offsetWidth; // the board's zoom
    card.style.setProperty("--lift-x", `${(point.clientX - box.left) / scale}px`);
    card.style.setProperty("--lift-y", `${(point.clientY - box.top) / scale}px`);
  }
}

/** Put the cards down: their origin goes back to the centre. */
export function releaseCards(board: ParentNode | null): void {
  for (const card of board?.querySelectorAll<HTMLElement>(".card-node") ?? []) {
    card.style.removeProperty("--lift-x");
    card.style.removeProperty("--lift-y");
  }
}

/** The position changes that are a card being held (`dragging: true`). React Flow also reports a card nudged
 *  with the arrow keys (`dragging: false`); that is not a drag, nothing here saves it, so it must not be drawn. */
export function heldMoves(changes: readonly NodeChange[]): Array<Extract<NodeChange, { type: "position" }>> {
  return changes.filter((change): change is Extract<NodeChange, { type: "position" }> => change.type === "position" && change.dragging === true && !!change.position);
}
