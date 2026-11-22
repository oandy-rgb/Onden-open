// The widths of the census: phone 390, tablet landscape 1280×800, tablet portrait 800×1280, desktop 1440 — each light and dark.
// Phone and tablets are touch screens (the page sees pointer: coarse); motion is allowed (transitions are measured).
// Device pixel ratio 1 everywhere: the numbers are CSS px and the sheet files stay small.
const BASE = { motion: "no-preference", touch: true };
export const SIZES = [
  { size: "390", label: "手機 390×844", width: 390, height: 844, ...BASE },
  { size: "1280x800", label: "平板橫放 1280×800", width: 1280, height: 800, ...BASE },
  { size: "800x1280", label: "平板直放 800×1280", width: 800, height: 1280, ...BASE },
  { size: "1440", label: "桌面 1440×900", width: 1440, height: 900, motion: "no-preference" },
];
export const THEMES = ["light", "dark"];
/** One viewport object per size × theme, in the shape layout-audit/env.mjs `contextOptions` takes. */
export const COMBOS = SIZES.flatMap((s) => THEMES.map((theme) => ({ ...s, id: `${s.size}__${theme}`, theme, dark: theme === "dark" })));
