// A note's pin and colour, set from its ⋯ menu. They are reserved node
// attributes (backend services/systemAttributes.ts holds the same names).
import { isHexColor } from "@onden/markdown";
import type { ContentNode } from "./api";

export const PINNED_ATTR = "_pinned";
export const COLOR_ATTR = "_color";

export function isPinned(node: Pick<ContentNode, "attrs">): boolean {
  return node.attrs?.[PINNED_ATTR] === "true";
}

/** The note's colour (#rrggbb), or null. Anything else is ignored. */
export function noteColor(node: Pick<ContentNode, "attrs">): string | null {
  const value = node.attrs?.[COLOR_ATTR];
  return typeof value === "string" && isHexColor(value) ? value : null;
}
