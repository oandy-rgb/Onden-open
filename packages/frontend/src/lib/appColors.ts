import { isHexColor } from "@onden/markdown";
import { getPrefJson, removePref, setPrefJson, settingPref } from "./prefs";

// The user's colour choice (Settings › Appearance › Colours): two seeds, accent
// and paper, from which @onden/site's `appTokens` computes every `--ac-*`
// colour. styles/tokens.css already holds the default seeds' colours, so a
// default user stores nothing. A chosen seed stores the computed CSS text next
// to it, and both the inline boot script (pages/index.astro) and the replay at
// boot (settings/appearance.ts) apply that text as it is — the formula itself
// loads only when a colour is picked, never on the way to first paint.

export type ColorSeed = { accent: string; paper: string };

/** The stored choice. `bg` is the page colour of each theme, for
 *  `<meta name="theme-color">` (settings/themeColor.ts). */
export type StoredColors = ColorSeed & { v: number; css: string; bg: { light: string; dark: string } };

/** Bump when the formula or the set of colours changes: a stored choice of an
 *  older version is recomputed at the next boot (replayColors). */
export const COLOR_CSS_VERSION = 1;

/** The `localStorage` key the boot script in pages/index.astro reads too. */
export const COLORS_KEY = "theme.colors";
const COLORS_PREF = settingPref(COLORS_KEY);
const STYLE_ID = "onden-colors";

// Only what the generator writes: selectors, `--ac-name:#hex` pairs, braces.
const CSS_SHAPE = /^[a-z0-9:#;{}[\]=",\s.-]+$/i;

const isHex = (v: unknown): v is string => typeof v === "string" && isHexColor(v);

/** The stored choice, or null when there is none or it is unreadable. */
export function readStoredColors(): StoredColors | null {
  const raw = getPrefJson(COLORS_PREF) as Partial<StoredColors> | null;
  if (!raw || typeof raw !== "object") return null;
  const { v, accent, paper, css, bg } = raw;
  if (typeof v !== "number" || !isHex(accent) || !isHex(paper)) return null;
  if (typeof css !== "string" || !CSS_SHAPE.test(css) || !bg || !isHex(bg.light) || !isHex(bg.dark)) return null;
  return { v, accent, paper, css, bg };
}

/** The page colour the stored choice gives `theme`, or null for the defaults. */
export function storedColorBg(theme: "light" | "dark"): string | null {
  return readStoredColors()?.bg[theme] ?? null;
}

/** Put the stored colours on the page, or take them off when there are none. */
export function applyStoredColors(): void {
  if (typeof document === "undefined") return;
  const stored = readStoredColors();
  let style = document.getElementById(STYLE_ID);
  if (!stored) { style?.remove(); return; }
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== stored.css) style.textContent = stored.css;
}

const block = (colors: Record<string, string>) =>
  Object.entries(colors).map(([name, hex]) => `--ac-${name}:${hex}`).join(";");

/** Compute and store the colours of `seed` (loads the formula). `null`, or the
 *  default seed, forgets the choice. Returns false when storage refused the write. */
export async function saveColorSeed(seed: ColorSeed | null): Promise<boolean> {
  const { appTokens, DEFAULT_APP_SEED } = await import("@onden/site/palette");
  if (!seed || (seed.accent === DEFAULT_APP_SEED.accent && seed.paper === DEFAULT_APP_SEED.paper)) {
    return removePref(COLORS_PREF);
  }
  const light = appTokens(seed.accent, seed.paper, "light");
  const dark = appTokens(seed.accent, seed.paper, "dark");
  const stored: StoredColors = {
    v: COLOR_CSS_VERSION, ...seed,
    // `html:root` outranks tokens.css's `:root` whichever sheet comes later.
    css: `html:root{${block(light)}}html[data-theme="dark"]{${block(dark)}}`,
    bg: { light: light.bg, dark: dark.bg },
  };
  return setPrefJson(COLORS_PREF, stored);
}
