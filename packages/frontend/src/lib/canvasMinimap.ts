// Colour logic for the canvas MiniMap (React Flow's <MiniMap>). One source of
// truth so the bird's-eye view stays consistent with the board: a card shows
// its own card colour ([[cardColors]] data.color) when set, sections render in
// a muted line tone, and an uncoloured card falls back to the same neutral
// CardNode uses for its status rail (#94a3b8). All Gallery-palette tokens; no
// new colours. Kept as a pure function so it's unit-testable without mounting
// React Flow (which needs a measured DOM the jsdom test env can't provide).

import type { Node } from "@xyflow/react";

// Matches CardNode's statusColor fallback so an uncoloured card reads the same
// neutral grey in the minimap as its on-board status rail.
export const MINIMAP_DEFAULT_CARD = "#94a3b8";
// Sections are containers, not content — render them as a faint structural
// tone (the Gallery --line token resolves to a near-paper hairline grey).
export const MINIMAP_SECTION = "var(--ac-line)";

/**
 * MiniMap node fill. `data.color` is the per-card swatch (CARD_COLORS); section
 * nodes (type === "section") get the structural tone; everything else falls
 * back to the neutral card grey.
 */
export function minimapNodeColor(node: Node): string {
  if (node.type === "section") return MINIMAP_SECTION;
  const color = (node.data as { color?: unknown } | undefined)?.color;
  return typeof color === "string" && color ? color : MINIMAP_DEFAULT_CARD;
}

/**
 * MiniMap node stroke. Selected nodes get the accent ring so the minimap
 * mirrors the board selection; otherwise no stroke (transparent).
 */
export function minimapNodeStroke(node: Node): string {
  return node.selected ? "var(--ac-accent)" : "transparent";
}
