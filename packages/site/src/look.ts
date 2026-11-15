// The site's look, for anything that is not a website page (the slides view).
// A narrow door into style.ts and palette.ts: the formulas stay where the
// published site already reads them, so nothing here can change what a site
// looks like (look.golden.test.ts keeps styleCss's output byte for byte).
// No React, no Puck, no registry and no validation here: the slides code may
// import this entry and nothing else of @onden/site (look.guard.test.ts).
import type { SiteStyle } from "./design.js";
import { STYLE_PRESETS, SCALE_STEPS, styleVars, schemeColors, type SchemeMode } from "./style.js";

export {
  ACCENT_SWATCHES, DEFAULT_ACCENT, FONT_STACKS, SPACE_LINES, STYLE_PRESETS, STYLE_PRESET_NAMES,
  colorVars, contrastRatio, schemeColors, stepRange, styleVars,
  type SchemeColors, type SchemeMode, type StylePreset,
} from "./style.js";
export type { FontKind, SiteStyle, StylePresetName } from "./design.js";

/** A style with the choices a projector has: light or dark, never "follow the visitor". */
export type DeckStyle = Omit<SiteStyle, "scheme"> & { scheme: SchemeMode };

/** The slide canvas in logical px. One logical px is half a point in a PPTX
 *  (13.333in = 960pt = 1920px). */
export const DECK_CANVAS = { width: 1920, height: 1080 } as const;

/** Body text on a slide is the site's base size times this (17px → 43px, about 21pt: readable from the back of a room). */
const DECK_BASE_SCALE = 2.5;
/** Body text never goes below 14pt (28px) and titles (step 2) never below 48px. */
export const DECK_MIN_BODY_PX = 28;
export const DECK_MIN_TITLE_PX = 48;

const px = (n: number) => `${+n.toFixed(2)}px`;

/** The slide's own type scale: the same `--s-*` names and formula as the site
 *  (`styleVars`), at fixed px for the 1920×1080 canvas instead of fluid with
 *  the viewport. Everything else (fonts, spacing in lines, radius, colours) is
 *  `styleVars` itself, so a slide and a page of the same style are one family.
 *  Step −1 is the one level a crowded slide may shrink to, so it keeps the
 *  body floor; step 0 is the body and step 2 the title. */
export function deckVars(style: DeckStyle): Record<string, string> {
  const preset = STYLE_PRESETS[style.preset];
  const base = Math.round(preset.base * DECK_BASE_SCALE);
  const vars = styleVars(style, { mode: style.scheme });
  for (const n of SCALE_STEPS) {
    const size = base * preset.ratio ** n;
    vars[n === 0 ? "--s-base" : `--s-step${n}`] = px(n < 0 ? Math.max(DECK_MIN_BODY_PX, size) : size);
  }
  Object.assign(vars, coverVars(style));
  return vars;
}

/** What the cover, the section slides and the text over a full picture are painted with. On light it is the accent
 *  with its own label colour, as the site's button. On dark the bright accent with dark ink looked like a light slide
 *  in a dark deck, so it is the accent's deep step (the palette's `soft`) with the scheme's own text colour on it.
 *  The text on it is held to the same contrast as the body text (look.test.ts). */
function coverVars(style: DeckStyle): Record<string, string> {
  const c = schemeColors(style.accent, style.scheme, STYLE_PRESETS[style.preset].tint);
  return style.scheme === "dark"
    ? { "--s-cover": c.soft, "--s-cover-text": c.text }
    : { "--s-cover": c.button, "--s-cover-text": c.buttonText };
}
