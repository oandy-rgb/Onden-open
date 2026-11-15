import { Maximize2, Minimize2, Type } from "lucide-react";
import { getPref, setPref, settingPref } from "../lib/prefs";
import { applyFontVars } from "../lib/fontStacks";
import { motionFromLegacy, noteTextSizeFromLegacy, uiSizeFromLegacy, UI_SIZES, NOTE_TEXT_SIZES, MOTION_MODES, type MotionMode, type NoteTextSize, type UiSize } from "./legacyPrefs";
import { readValue } from "./useOption";
import type { SettingDef } from "../lib/settingsTypes";
import { setThemeColorMeta } from "./themeColor";
import { applyStoredColors, COLOR_CSS_VERSION, readStoredColors, saveColorSeed, type ColorSeed } from "../lib/appColors";
import { lazyWithReload } from "../lib/lazyWithReload";
import { mediaQueryList } from "../lib/mediaQuery";
import { isDarkTheme, setRootAttribute, setRootStyle } from "../lib/documentAccess";

// The settings whose side effect is a page-level DOM change (theme, font size,
// density, editor font, motion). They live apart from settings/registry.tsx
// because the page applies them at boot, before sign-in (bootApp.ts), and
// the registry pulls in the settings screens and the data layer. The registry
// lists them (APPEARANCE_SETTINGS) like any other setting; a test checks that
// no setting outside this list has an `apply`, so a boot replay cannot miss one.

// Live OS-preference listener, only attached while the mode is "system" so the
// app flips automatically as the OS theme changes; detached otherwise. SSR-safe
// (matchMedia is window-only — guarded for the Astro build).
let systemThemeMql: MediaQueryList | null = null;
let systemThemeListener: ((e: MediaQueryListEvent) => void) | null = null;

function setResolvedTheme(theme: "light" | "dark"): void {
  setRootAttribute("data-theme", theme);
  setThemeColorMeta(theme);
}

/** Apply a 3-way theme mode: resolve it to a concrete data-theme (and the
 *  matching `<meta name="theme-color">`), and (only
 *  in "system" mode) keep a matchMedia listener attached so it live-flips
 *  with the OS. Persisting the mode is the setting's (key "theme"). */
export function applyThemeMode(mode: "system" | "light" | "dark"): void {
  // Detach any previous system listener; only "system" mode keeps one.
  if (systemThemeMql && systemThemeListener) {
    systemThemeMql.removeEventListener("change", systemThemeListener);
    systemThemeMql = null;
    systemThemeListener = null;
  }

  if (mode === "system") {
    const mql = mediaQueryList("(prefers-color-scheme: dark)");
    setResolvedTheme(mql?.matches ? "dark" : "light");
    if (mql) {
      systemThemeMql = mql;
      systemThemeListener = (e) => setResolvedTheme(e.matches ? "dark" : "light");
      mql.addEventListener("change", systemThemeListener);
    }
    return;
  }

  setResolvedTheme(mode);
}

// ─── App-boot helper ────────────────────────────────────────────────────────

/** Replay every setting's side effect with its persisted value (read through
 *  the same codec as the settings screen). Call once at boot so DOM state
 *  (CSS vars, data attributes) reflects user prefs immediately on load — not
 *  just after they open SettingsModal. Nothing is written back. */
export function applyPersistedSettings(): void {
  for (const def of APPEARANCE_SETTINGS) {
    if (def.type === "custom") { def.apply?.(); continue; }
    if (def.type === "action" || !def.apply) continue;
    (def.apply as (v: unknown) => void)(readValue(def));
  }
}

/** Column width in em of the note font per "Note width" choice: 600 / 700 / 800px
 *  at today's prose size (17px), so a window that does not scale the text keeps
 *  today's column; "full" has none (it fills). */
const NOTE_MEASURE_EM = { narrow: 35.29, standard: 41.18, wide: 47.06 } as const;


/** Apply the colours chosen in Settings › Appearance › Colours, or the defaults
 *  of styles/tokens.css when none. The inline boot script has usually put them
 *  on the page already; this covers the entries without it and re-bakes a
 *  choice stored by an older formula (the formula loads only then). */
function replayColors(): void {
  const stored = readStoredColors();
  if (stored && stored.v !== COLOR_CSS_VERSION) {
    chooseColors({ accent: stored.accent, paper: stored.paper }).catch(() => applyStoredColors());
    return;
  }
  applyStoredColors();
}

/** Choose the app's colours (null = the defaults): store them, put them on the
 *  page and point the browser's theme colour at the new page colour. */
export async function chooseColors(seed: ColorSeed | null): Promise<boolean> {
  const kept = await saveColorSeed(seed);
  applyStoredColors();
  setThemeColorMeta(isDarkTheme() ? "dark" : "light");
  return kept;
}

/** A value setting kept under `key` that falls back to one derived from the older settings it
 *  replaces (settings/legacyPrefs.ts): reading never rewrites the old keys, so nothing is lost. */
function migrated<T extends string>(key: string, allowed: readonly T[], fromLegacy: () => T) {
  return {
    get: (): string => {
      const raw = getPref(settingPref(key));
      return (allowed as readonly string[]).includes(raw ?? "") ? raw! : fromLegacy();
    },
    set: (v: string) => { setPref(settingPref(key), v); },
  };
}
const legacyNumber = (key: string): number | null => {
  const raw = getPref(settingPref(key));
  const n = raw === null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
};
const legacyText = (key: string) => getPref(settingPref(key));

export const APPEARANCE_SETTINGS: SettingDef[] = [
  // ── 外觀: the app itself (theme, colours, size, motion). Notes' own look is the 筆記 page. ──
  {
    // 3-way theme: "system" follows the OS via matchMedia and live-flips while
    // selected; "light"/"dark" pin the value and detach the OS listener. The
    // persisted "theme" key stores the MODE ('system'|'light'|'dark'); the
    // resolved attribute (`data-theme`) is always 'light' or 'dark'.
    id: "theme.mode",
    tab: "appearance",
    label: "Theme",
    control: { swatches: true },
    type: "enum",
    default: "system",
    options: [
      { value: "system", label: "System" },
      { value: "light",  label: "Light" },
      { value: "dark",   label: "Dark" },
    ],
    storageKey: "theme",
    apply: (v) => applyThemeMode(v as "system" | "light" | "dark"),
  },
  {
    // Two seeds (accent, paper) compute every colour of both themes
    // (@onden/site palette.ts). Stored on this device like the theme mode.
    id: "theme.colors",
    tab: "appearance",
    label: "Colours",
    keywords: ["color", "palette", "accent", "paper", "配色", "顏色", "主色", "紙色", "色彩"],
    type: "custom",
    component: lazyWithReload(() => import("./AppColorsSetting")),
    apply: replayColors,
  },
  {
    // One choice for the interface's size: the text size and how roomy the rows are
    // (the older 「基準字級」 and 「介面密度」 together).
    id: "theme.ui_size",
    tab: "appearance",
    label: "UI size",
    keywords: ["font size", "density", "compact", "spacious", "zoom", "大小", "字級", "基準字級", "密度", "介面密度", "放大", "縮小", "字體大小"],
    control: { segmented: true },
    type: "enum",
    default: "normal" satisfies UiSize,
    options: [
      { value: "small",  label: "Small" },
      { value: "normal", label: "Standard" },
      { value: "large",  label: "Large" },
    ],
    ...migrated<UiSize>("theme.ui_size", UI_SIZES, () => uiSizeFromLegacy(legacyNumber("theme.font_size"), legacyText("theme.density"))),
    apply: (v) => {
      const size = UI_SIZES.includes(v as UiSize) ? v as UiSize : "normal";
      setRootStyle("--onden-ui-font-size-base", `${UI_SIZE_PX[size]}px`);
      setRootAttribute("data-density", UI_SIZE_DENSITY[size]);
    },
  },
  {
    // "system" follows prefers-reduced-motion; the other two pin it.
    id: "theme.motion",
    tab: "appearance",
    label: "Reduce motion",
    keywords: ["animation", "transition", "動畫", "動態", "減少"],
    control: { segmented: true },
    type: "enum",
    default: "system" satisfies MotionMode,
    options: [
      { value: "system", label: "Same as the system" },
      { value: "reduce", label: "Reduce" },
      { value: "full",   label: "Don't reduce" },
    ],
    ...migrated<MotionMode>("theme.motion", MOTION_MODES, () => motionFromLegacy(legacyText("theme.reduce_motion"))),
    apply: (v) => {
      const reduce = v === "reduce" || (v !== "full" && mediaQueryList("(prefers-reduced-motion: reduce)")?.matches === true);
      setRootAttribute("data-reduce-motion", reduce ? "true" : null);
    },
  },

  // ── 筆記: how note text looks. Also reachable from a note's 「文字樣式」. ──
  {
    // 黑體 / 明體 / 楷體 / 等寬, each drawn in its own face, plus a font from this computer when
    // one is picked under 「更多」. The built-in choice is `note.font`; a computer font is the
    // account's (lib/fontPrefs); choosing a card clears the other, so only one is ever in force.
    id: "note.font",
    tab: "notes",
    label: "Font",
    keywords: ["font", "typeface", "serif", "sans", "kai", "mono", "字型", "字體", "黑體", "明體", "楷體", "等寬", "襯線"],
    type: "custom",
    component: lazyWithReload(() => import("./NoteFontSetting")),
    apply: () => applyFontVars(),
  },
  {
    // The note font = clamp(...) × this ratio (styles/theme-tokens.css); titles scale with it.
    id: "note.text_size",
    tab: "notes",
    label: "Text size",
    keywords: ["font size", "scale", "bigger", "smaller", "title", "文字大小", "字級", "內文大小", "標題", "放大", "縮小"],
    control: { slider: [Type, Type] },
    type: "enum",
    default: "m" satisfies NoteTextSize,
    options: [
      { value: "xs", label: "Very small" },
      { value: "s",  label: "Small" },
      { value: "m",  label: "Standard" },
      { value: "l",  label: "Large" },
      { value: "xl", label: "Very large" },
    ],
    ...migrated<NoteTextSize>("note.text_size", NOTE_TEXT_SIZES, () => noteTextSizeFromLegacy(legacyNumber("note.text_scale"))),
    apply: (v) => {
      setRootStyle("--onden-note-text-scale", String(NOTE_TEXT_SCALE[v as NoteTextSize] ?? 1));
    },
  },
  {
    // One measure for the note column, its title, the relations under it and
    // the welcome banner (OverviewEditor.css reads --onden-note-measure).
    // "full" fills the column; the gutter then grows to 48px so text keeps air.
    id: "note.measure",
    tab: "notes",
    label: "Width",
    keywords: ["wide", "narrow", "column", "寬度", "內文寬度", "欄寬"],
    control: { slider: [Minimize2, Maximize2] },
    type: "enum",
    default: "standard",
    options: [
      { value: "narrow",   label: "Narrow" },
      { value: "standard", label: "Standard" },
      { value: "wide",     label: "Wide" },
      { value: "full",     label: "Edge to edge" },
    ],
    apply: (v) => {
      const em = NOTE_MEASURE_EM[v as keyof typeof NOTE_MEASURE_EM];
      setRootStyle("--onden-note-measure", em ? `${em}em` : "100vw");
      setRootStyle("--onden-note-gutter", em ? "32px" : "48px");
    },
  },
  {
    // The note font (styles/theme-tokens.css) = clamp(today's size, window width ×
    // 0.9375%, 28px) × this ratio; the toggle pins it to today's size.
    id: "note.fluid_text",
    tab: "notes",
    section: "More",
    label: "Grow with the window",
    keywords: ["window", "scale", "fluid", "視窗", "跟著", "縮放"],
    advanced: true,
    type: "boolean",
    default: true,
    apply: (v) => {
      setRootStyle("--onden-note-fluid", v ? "1" : "0");
    },
    hint: "Note text grows with the window so the page looks the same on every screen.",
  },
];

const UI_SIZE_PX: Record<UiSize, number> = { small: 13, normal: 14, large: 16 };
const UI_SIZE_DENSITY: Record<UiSize, string> = { small: "compact", normal: "normal", large: "spacious" };
/** The note text ratio per 「文字大小」 step (the page's note font is multiplied by it). */
export const NOTE_TEXT_SCALE: Record<NoteTextSize, number> = { xs: 0.8, s: 0.9, m: 1, l: 1.15, xl: 1.3 };
