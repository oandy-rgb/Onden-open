// The deck's theme as the style the slides are drawn in (docs/architecture/
// proposals/slides-2026-10-31.md §5.1a). 跟網站一樣 follows the website's own
// style as it is now (nothing of it is copied into the note); 深色 and 紙本
// fix the part the word names. The site's formulas turn the style into
// colours and sizes (@onden/site/look).

import { useMemo } from "react";
import { isHexColor, type SlidesTheme } from "@onden/markdown";
import { DEFAULT_ACCENT, STYLE_PRESET_NAMES, deckVars, type DeckStyle, type SchemeMode, type StylePresetName } from "@onden/site/look";
import { useAppSchemeMode } from "../../hooks/useAppSchemeMode";
import { useAppSelector } from "../../lib/appStore";

/** The website's style as the design stores it (chrome.style), or null when
 *  there is no design or its style is damaged. */
export type SiteLook = { preset: StylePresetName; accent: string; scheme: SchemeMode | "system" };

export function siteLookOf(chrome: Record<string, unknown> | null | undefined): SiteLook | null {
  const style = chrome?.style as { preset?: unknown; accent?: unknown; scheme?: unknown } | undefined;
  if (!style || typeof style !== "object") return null;
  const { preset, accent, scheme } = style;
  if (!STYLE_PRESET_NAMES.includes(preset as StylePresetName) || typeof accent !== "string" || !isHexColor(accent)) return null;
  return { preset: preset as StylePresetName, accent, scheme: scheme === "light" || scheme === "dark" ? scheme : "system" };
}

const QUIET: SiteLook = { preset: "quiet", accent: DEFAULT_ACCENT, scheme: "system" };

/** The style a theme draws the slides in. `appMode` is Onden's own light or dark,
 *  used where the website follows its visitor. */
export function themeStyle(theme: SlidesTheme, site: SiteLook | null, appMode: SchemeMode): DeckStyle {
  const look = site ?? QUIET;
  const own: SchemeMode = look.scheme === "system" ? appMode : look.scheme;
  if (theme === "dark") return { preset: look.preset, accent: look.accent, scheme: "dark" };
  if (theme === "paper") return { preset: "paper", accent: look.accent, scheme: "light" };
  return { preset: look.preset, accent: look.accent, scheme: own };
}

export const THEME_LABELS: Record<SlidesTheme, string> = { site: "Like my website", dark: "Dark", paper: "Paper style" };

/** The CSS variables a deck of this theme is drawn with, and the style behind them. */
export function useDeckLook(theme: SlidesTheme): { style: DeckStyle; vars: Record<string, string> } {
  const chrome = useAppSelector((s) => s.data.chrome);
  const appMode = useAppSchemeMode();
  return useMemo(() => {
    const style = themeStyle(theme, siteLookOf(chrome), appMode);
    return { style, vars: deckVars(style) };
  }, [theme, chrome, appMode]);
}
