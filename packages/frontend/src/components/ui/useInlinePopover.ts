import { usePopover, type PopoverOptions, type PopoverState } from "./usePopover";

import type { PopoverPoint } from "../../lib/popoverPoint";

export type { PopoverPoint };

type InlineOptions = Omit<PopoverOptions, "keepFocus" | "at"> & { at?: PopoverPoint };

/** A popover beside what is being typed in (a menu at the caret, a list under a combobox input, the
 *  bubble over a selection): focus stays in the text, which keeps its own keys, so Esc is heard
 *  window-wide (usePopover's useDismiss) instead of on the surface. Placement and outside press are usePopover's. */
export function useInlinePopover<A extends HTMLElement = HTMLDivElement>({ at, placement, ...options }: InlineOptions): PopoverState<A> {
  const popover = usePopover<A>({ ...options, at, placement: at?.above ? "top-start" : placement, keepFocus: true });
  return popover;
}
