import r1 from "./r1-covered.mjs";
import r2 from "./r2-overlap.mjs";
import r3 from "./r3-truncated.mjs";
import r4 from "./r4-scroll-end.mjs";
import r5 from "./r5-hover-shift.mjs";
import r6 from "./r6-hscroll.mjs";
import r7 from "./r7-tap-target.mjs";
import r8 from "./r8-align.mjs";
import r9 from "./r9-sticky-hover.mjs";
import r10 from "./r10-list-over-content.mjs";

/** Every rule: { id, name, severity (1 broken · 2 hard to use · 3 off by a pixel or two), when?(viewport), run(page, ctx) }. */
export const RULES = [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10];
