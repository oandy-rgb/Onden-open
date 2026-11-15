// A board card's size and the grids cards are laid out in — one definition
// for every place that places or measures a card (W23). A card without a
// stored width or height is drawn at the defaults; the grids space cards by
// that size plus their gaps.

export const DEFAULT_CARD_W = 260;
export const DEFAULT_CARD_H = 200;
// A folded card's height and an expanded card's cap: lib/cardDisplay.ts.

/** Tidy-up: three columns, generous gaps so edges between cards stay legible. */
const ARRANGE_GRID = { cols: 3, gapX: 100, gapY: 80, margin: 80 } as const;

/** Where the i-th card of an arranged set goes. */
export function arrangedSlot(i: number): { x: number; y: number } {
  const { cols, gapX, gapY, margin } = ARRANGE_GRID;
  return {
    x: (i % cols) * (DEFAULT_CARD_W + gapX) + margin,
    y: Math.floor(i / cols) * (DEFAULT_CARD_H + gapY) + margin,
  };
}

/** A tag board's members never placed yet, lined up under the placed cards. */
export const APPEND_GRID = { cols: 4, gapX: 60, gapY: 40 } as const;

/** Space between a new card and the rightmost card when it is added beside. */
export const SPAWN_GAP_X = 60;
