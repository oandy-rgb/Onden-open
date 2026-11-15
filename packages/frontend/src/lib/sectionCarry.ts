// ⑦ 群組框: a section is a GROUP — dragging it carries the cards inside.
// Membership is geometric (Obsidian-style): a card belongs to the section if
// its CENTER sat inside the section's rect BEFORE the drag. Pure so the
// carry rule is unit-testable apart from the canvas plumbing.

import type { CanvasData, CanvasNodeEntry, CanvasSection, GraphPosition } from "./api";

import { DEFAULT_CARD_H, DEFAULT_CARD_W } from "./cardGeometry";
import { FOLDED_CARD_H, isCardFolded, type CardDisplaySettings } from "./cardDisplay";

const NO_DISPLAY: CardDisplaySettings = {};

export type CardPosition = { id: string; x: number; y: number };
/** A fixed set of original positions for one gesture. Section IDs are stored
 * IDs, without the React Flow "section-" prefix. No dimensions or content. */
export type CanvasPositions = { nodes: GraphPosition[]; sections: CardPosition[] };

/** Capture selected cards plus the stored members of selected groups. A card
 * shared by overlapping groups, or explicitly selected too, occurs only once.
 * Hidden cards remain members; later additions are not part of this gesture. */
export function captureCanvasPositions(data: CanvasData, cardIds: readonly string[], sectionIds: readonly string[], display: CardDisplaySettings = NO_DISPLAY): CanvasPositions {
  const ids = new Set(cardIds);
  const sections = (data.sections ?? []).filter(s => sectionIds.includes(s.id));
  for (const section of sections) for (const card of cardsInSection(section, data.nodes, display)) ids.add(card.nodeId);
  return {
    nodes: data.nodes.filter(n => ids.has(n.nodeId)).map(({ nodeId, x, y }) => ({ nodeId, x, y })),
    sections: sections.map(({ id, x, y }) => ({ id, x, y })),
  };
}
/** Complete rectangle in canvas coordinates, including the origin moved by
 * a top/left resize. Resizing a group does not move its contained cards. */
export type CanvasBounds = Pick<CanvasSection, "x" | "y" | "width" | "height">;

/** The size a card has on the board, shared by grouping, movement and visual membership. Whether it is
 * folded is the board's display settings (a card's own choice or the board default), not the old
 * `folded` flag alone; far-zoom rendering still must not change which cards a group carries. */
export function canvasCardSize(card: { nodeId?: string; width?: number; height?: number; folded?: boolean }, display: CardDisplaySettings = NO_DISPLAY) {
  const folded = isCardFolded(display, { nodeId: card.nodeId ?? "", folded: card.folded });
  return { w: card.width ?? DEFAULT_CARD_W, h: folded ? FOLDED_CARD_H : (card.height ?? DEFAULT_CARD_H) };
}

export function cardsInSection(section: CanvasSection, entries: CanvasNodeEntry[], display: CardDisplaySettings = NO_DISPLAY): CanvasNodeEntry[] {
  return entries.filter((cn) => {
    const { w, h } = canvasCardSize(cn, display);
    const cx = cn.x + w / 2;
    const cy = cn.y + h / 2;
    return cx >= section.x && cx <= section.x + section.width
        && cy >= section.y && cy <= section.y + section.height;
  });
}

/** Bounding rect (+padding) around a set of cards — the "group the
 *  selection" affordance. */
export function boundingSectionRect(
  cards: Array<{ nodeId?: string; x: number; y: number; width?: number; height?: number; folded?: boolean }>,
  display: CardDisplaySettings = NO_DISPLAY,
  padding = 40,
): { x: number; y: number; width: number; height: number } {
  const minX = Math.min(...cards.map((c) => c.x));
  const minY = Math.min(...cards.map((c) => c.y));
  const maxX = Math.max(...cards.map((c) => c.x + canvasCardSize(c, display).w));
  const maxY = Math.max(...cards.map((c) => c.y + canvasCardSize(c, display).h));
  return {
    x: Math.round(minX - padding),
    y: Math.round(minY - padding - 24), // room for the section title strip
    width: Math.round(maxX - minX + padding * 2),
    height: Math.round(maxY - minY + padding * 2 + 24),
  };
}
