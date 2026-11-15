// Site style → CSS variables. The owner chooses three things — a temperament
// (preset), an accent colour, a scheme — and everything else is a formula:
// the type scale, the spacing, the light and the dark colours.
import type { FontKind, SiteScheme, SiteStyle, StylePresetName } from "./design.js";
import { schemeColors, type SchemeColors, type SchemeMode } from "./palette.js";

export { contrastRatio, schemeColors, type SchemeColors, type SchemeMode } from "./palette.js";

export type StylePreset = {
  label: string;
  /** One plain sentence, shown on the choice card. */
  blurb: string;
  /** Body size in px at the widest viewport; the scale grows by `ratio` per step. */
  base: number;
  ratio: number;
  head: FontKind;
  body: FontKind;
  headWeight: number;
  /** Line height of body text, unitless. */
  leading: number;
  radius: number;
  /** Line length of reading text. */
  measure: string;
  /** How much of the accent's hue the page's greys carry (see palette.ts). */
  tint: number;
};

export const STYLE_PRESETS: Record<StylePresetName, StylePreset> = {
  quiet: { label: "安靜", blurb: "無襯線，留白多", base: 17, ratio: 1.25, head: "sans", body: "sans", headWeight: 700, leading: 1.85, radius: 8, measure: "36em", tint: 1 },
  paper: { label: "紙本", blurb: "襯線，像書頁", base: 17, ratio: 1.333, head: "serif", body: "serif", headWeight: 600, leading: 1.95, radius: 3, measure: "34em", tint: 2.2 },
  folio: { label: "書冊", blurb: "標題大，內文無襯線", base: 17, ratio: 1.414, head: "serif", body: "sans", headWeight: 700, leading: 1.85, radius: 4, measure: "36em", tint: 0.6 },
  hand: { label: "手寫", blurb: "楷書，圓角", base: 18, ratio: 1.2, head: "kai", body: "kai", headWeight: 700, leading: 1.9, radius: 14, measure: "34em", tint: 1.6 },
};
export const STYLE_PRESET_NAMES = Object.keys(STYLE_PRESETS) as StylePresetName[];

export const SCHEMES: readonly SiteScheme[] = ["system", "light", "dark"];
export const SCHEME_LABELS: Record<SiteScheme, string> = { system: "跟隨訪客系統", light: "淺色", dark: "深色" };

export const DEFAULT_ACCENT = "#3f7d6e";
/** The six swatches of the accent choice (the studio adds 「自訂」). */
export const ACCENT_SWATCHES = ["#3f7d6e", "#b23a2a", "#2a5bd7", "#b0489a", "#e8772e", "#f2c230"] as const;

// The same stacks as the app (frontend styles/tokens.css --ac-font-serif /
// --ac-font-sans), spelled out: a published page does not load tokens.css.
// 楷書 is the system's: a web 楷書 face is ~1 MB for one page of text, more
// than the page itself, so it is not shipped (the site's CSP allows only its own font files).
export const FONT_STACKS: Record<FontKind, string> = {
  serif: '"Noto Serif TC Variable", "Noto Serif TC", "Source Han Serif TC", "Noto Serif CJK TC", "Songti TC", "PMingLiU", Georgia, "Times New Roman", serif',
  sans: '"Noto Sans TC Variable", "Noto Sans TC", "PingFang TC", "Source Han Sans TC", "Noto Sans CJK TC", "Microsoft JhengHei", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  kai: '"Kaiti TC", "BiauKai", "DFKai-SB", serif',
};

// ── Type scale ───────────────────────────────────────────────────────────
// Step n is fluid between two viewport widths: at the narrow one the base is
// one px smaller and the ratio three quarters of the way to 1, at the wide one
// it is the preset's own.
export const SCALE_STEPS = [-1, 0, 1, 2, 3] as const;
export const SCALE_VIEWPORT = { min: 360, max: 1240 } as const;
const NARROW_RATIO_SHARE = 0.75;

const px = (n: number) => `${+n.toFixed(2)}px`;

/** The size of step `n` at the narrowest and the widest viewport. */
export function stepRange(preset: Pick<StylePreset, "base" | "ratio">, n: number): { min: number; max: number } {
  return {
    min: (preset.base - 1) * (1 + (preset.ratio - 1) * NARROW_RATIO_SHARE) ** n,
    max: preset.base * preset.ratio ** n,
  };
}

/** `clamp(min, intercept + slope vw, max)`: linear between the two viewport widths. */
function fluid({ min, max }: { min: number; max: number }): string {
  const slope = (max - min) / (SCALE_VIEWPORT.max - SCALE_VIEWPORT.min);
  const intercept = min - slope * SCALE_VIEWPORT.min;
  return `clamp(${px(min)}, ${px(intercept)} + ${+(slope * 100).toFixed(4)}vw, ${px(max)})`;
}

/** The size at a given viewport width (the studio's phone preview is 390px wide inside a wider window). */
function sizeAt({ min, max }: { min: number; max: number }, viewport: number): string {
  const t = Math.min(1, Math.max(0, (viewport - SCALE_VIEWPORT.min) / (SCALE_VIEWPORT.max - SCALE_VIEWPORT.min)));
  return px(min + (max - min) * t);
}

/** Spacing steps, in lines of body text (a "line" is body size × line height). */
export const SPACE_LINES = [0.25, 0.5, 1, 1.5, 2, 3] as const;

const stepName = (n: number) => (n === 0 ? "--s-base" : `--s-step${n}`);

export type StyleVarOptions = {
  /** Which scheme's colours. Default: dark for a dark site, light otherwise. */
  mode?: SchemeMode;
  /** Draw the type at this viewport width in plain px instead of `clamp()` (the studio's phone preview). */
  viewport?: number;
};

/** The colour variables of one scheme (`--s-bg` …). */
export function colorVars(style: SiteStyle, mode: SchemeMode): Record<string, string> {
  const c: SchemeColors = schemeColors(style.accent, mode, STYLE_PRESETS[style.preset].tint);
  return {
    "--s-bg": c.bg, "--s-surface": c.surface, "--s-border": c.border, "--s-text": c.text, "--s-muted": c.muted,
    "--s-link": c.link, "--s-chip-bg": c.chipBg, "--s-chip-text": c.chipText,
    "--s-button": c.button, "--s-button-text": c.buttonText, "--s-soft": c.soft,
    "--s-accent": c.button,
  };
}

/** The CSS variables a style produces (`--s-*`): the type scale, spacing, fonts,
 *  radius and line length, and the colours of one scheme. */
export function styleVars(style: SiteStyle, { mode, viewport }: StyleVarOptions = {}): Record<string, string> {
  const preset = STYLE_PRESETS[style.preset];
  const vars: Record<string, string> = {};
  for (const n of SCALE_STEPS) {
    const range = stepRange(preset, n);
    vars[stepName(n)] = viewport === undefined ? fluid(range) : sizeAt(range, viewport);
  }
  SPACE_LINES.forEach((lines, i) => {
    vars[`--s-space-${i + 1}`] = `calc(var(--s-base) * ${+(preset.leading * lines).toFixed(4)})`;
  });
  vars["--s-space"] = "var(--s-space-3)";
  vars["--s-font-h"] = FONT_STACKS[preset.head];
  vars["--s-font-b"] = FONT_STACKS[preset.body];
  vars["--s-weight-h"] = String(preset.headWeight);
  vars["--s-leading"] = String(preset.leading);
  vars["--s-radius"] = px(preset.radius);
  vars["--s-measure"] = preset.measure;
  return { ...vars, ...colorVars(style, mode ?? (style.scheme === "dark" ? "dark" : "light")) };
}

const declarations = (vars: Record<string, string>) => Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";");

/** `selector` (a comma list such as "html.onden-site, .site-scope") narrowed by the reader's own choice,
 *  which the toggle writes as `data-theme` on <html>: `forced` is that theme, `unless` the one it must not be. */
function themed(selector: string, test: { is: SchemeMode } | { not: SchemeMode }): string {
  const attr = "is" in test ? `[data-theme="${test.is}"]` : `:not([data-theme="${test.not}"])`;
  return selector.split(",").map((part) => {
    const one = part.trim();
    return one.startsWith("html") ? one.replace(/^html(\.[\w-]+)*/, (head) => `${head}${attr}`) : `html${attr} ${one}`;
  }).join(", ");
}

/** The style as CSS rules for a published page, on `selector`. A site that
 *  follows the visitor gets the light colours and, under `prefers-color-scheme:
 *  dark`, the dark ones; a light or dark site gets only its own. A visitor who
 *  used the page's light/dark button (`data-theme` on <html>) gets the one they
 *  chose, whatever their system says. */
export function styleCss(style: SiteStyle, selector: string): string {
  const scheme = `color-scheme:${style.scheme === "system" ? "light dark" : style.scheme}`;
  const base = `${selector}{${declarations(styleVars(style))};${scheme}}`;
  if (style.scheme !== "system") return base;
  const dark = declarations(colorVars(style, "dark"));
  return `${base}@media (prefers-color-scheme: dark){${themed(selector, { not: "light" })}{${dark}}}`
    + `${themed(selector, { is: "dark" })}{${dark};color-scheme:dark}${themed(selector, { is: "light" })}{${declarations(colorVars(style, "light"))};color-scheme:light}`;
}
