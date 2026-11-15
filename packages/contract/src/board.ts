// Board layout writes (PATCH /api/boards/:id). Pure types: the app imports them with `import type`.
// The per-request limits (BOARD_CARDS_PER_REQUEST_MAX, BOARD_SECTIONS_PER_REQUEST_MAX) are in @onden/markdown sharedContract.

/** One card of `cards.upsert`: only the fields that changed. An absent field is left as the server
 *  has it; `null` clears it (`folded` has no null: false). A card the server does not have yet is
 *  created only when `x` and `y` are both present. A whole card (every field present) is the same
 *  shape, so requests from before this format still apply. */
export type BoardCardPatch = {
  nodeId: string;
  x?: number;
  y?: number;
  width?: number | null;
  height?: number | null;
  color?: string | null;
  folded?: boolean;
  subCanvasId?: string | null;
};

/** One frame of `sections.upsert`: only the fields that changed, as for a card. An absent field is left
 *  as the server has it; `color: null` clears the colour. `x` and `y` travel together, so do `width` and
 *  `height`. A frame the server does not have is created only when all four of x, y, width, height are
 *  present; a rename or move of a frame another device already removed is ignored. A whole frame is the
 *  same shape, so requests from before this format still apply. */
export type BoardSectionPatch = {
  id: string;
  title?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string | null;
};
