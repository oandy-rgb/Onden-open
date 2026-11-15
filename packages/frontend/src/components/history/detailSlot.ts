/** Where a history list shows the detail of its selected row. `wide` is the two-column layout;
 *  `host` is the right column once it is on screen. Narrow, there is no right column and a row
 *  opens its detail in a dialog instead. */
export type DetailSlot = { wide: boolean; host: HTMLElement | null };

/** Width of the history page from which it is two columns. */
export const TWO_COLUMN_MIN_WIDTH = 1100;

export const NARROW: DetailSlot = { wide: false, host: null };
