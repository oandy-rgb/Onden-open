/** A viewport point; `above`: the surface's bottom edge sits at `y` (the bubble over a selection);
 *  `lineTop`: the top of the line being typed in, which the surface stays clear of (usePopover). */
export type PopoverPoint = { x: number; y: number; above?: boolean; lineTop?: number };
