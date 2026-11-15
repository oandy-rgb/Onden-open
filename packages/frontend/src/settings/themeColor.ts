import { storedColorBg } from "../lib/appColors";
import { setMeta } from "../lib/documentAccess";

/**
 * The browser / status-bar colour (`<meta name="theme-color">`) for each
 * resolved theme. One source: the boot script in pages/index.astro reads these
 * values (define:vars) to avoid a flash, and applyThemeMode (settings/registry)
 * writes them on every theme change after boot — including OS flips in
 * "system" mode. They match the page colour (`--ac-bg`, light and dark) in
 * styles/tokens.css; test/themeColorMeta.test.ts checks that they agree.
 * A user's own colours (lib/appColors) have their own page colour, which wins.
 */
export const THEME_COLORS = {
  light: "#f8f4ec",
  dark: "#1c1a17",
} as const;

/** Point `<meta name="theme-color">` at the colour of `theme`, creating the
 *  tag when the page has none (the Vite / Capacitor entry index.html ships
 *  without one). No-op outside the browser. */
export function setThemeColorMeta(theme: "light" | "dark"): void {
  setMeta("theme-color", storedColorBg(theme) ?? THEME_COLORS[theme]);
}
