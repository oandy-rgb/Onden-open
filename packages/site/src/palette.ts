// One accent colour → the colours of a light page and of a dark page, by a
// formula (OKLCH, a 12-step ramp like Radix Themes' scales). Pure numbers, no
// DOM: the published site's CSS, the studio canvas and the tests all call it.
//
// The contrast promises, checked by palette.test.ts for the six swatches and
// random accents, in both schemes: text on the page ≥ 7, a link ≥ 4.5, the
// button's label on the button ≥ 4.5.

export type SchemeMode = "light" | "dark";
type Oklch = { L: number; C: number; H: number };
/** Linear-light sRGB, 0..1 per channel (values slightly outside mean "out of gamut"). */
type Rgb = readonly [number, number, number];

/** The colours of one scheme, as `#rrggbb`. */
export type SchemeColors = {
  bg: string; surface: string; border: string; text: string; muted: string; link: string;
  chipBg: string; chipText: string; button: string; buttonText: string; soft: string;
};

const GAMUT_SLACK = 0.0001;
const WHITE: Rgb = [1, 1, 1];

function toLinear({ L, C, H }: Oklch): Rgb {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -GAMUT_SLACK && v <= 1 + GAMUT_SLACK);

/** The colour at (L, C, H), with the chroma lowered until it fits sRGB. */
function fit(L: number, C: number, H: number): Rgb {
  const exact = toLinear({ L, C, H });
  if (inGamut(exact)) return exact;
  let lo = 0;
  let hi = C;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(toLinear({ L, C: mid, H }))) lo = mid; else hi = mid;
  }
  return toLinear({ L, C: lo, H });
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const luminance = (rgb: Rgb) => {
  const [r, g, b] = rgb.map(clamp01) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrastLinear = (x: Rgb, y: Rgb) => {
  const a = luminance(x);
  const b = luminance(y);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

const encode = (v: number) => {
  const c = clamp01(v);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
};
const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** tokens.css `--ac-<state>-soft`: `color-mix(in srgb, <state> 16%, var(--ac-bg))`. */
const softOf = (state: Rgb, bg: Rgb): Rgb =>
  state.map((v, i) => decode(0.16 * encode(v) + 0.84 * encode(bg[i]!))) as unknown as Rgb;

function toHex(rgb: Rgb): string {
  return `#${rgb.map((v) => Math.round(encode(v) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function linearOfHex(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [decode(((n >> 16) & 255) / 255), decode(((n >> 8) & 255) / 255), decode((n & 255) / 255)];
}

/** `#rrggbb` → OKLCH (the standard OKLab matrices). */
export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = linearOfHex(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), H: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}

/** WCAG contrast ratio of two `#rrggbb` colours (what the tests hold the palette to). */
export function contrastRatio(a: string, b: string): number {
  return contrastLinear(linearOfHex(a), linearOfHex(b));
}

/** Moves the lightness from `from` in direction `dir` until `chroma`'s colour reaches `target` contrast on `bg`. */
function solveLightness(from: number, chroma: number, H: number, bg: Rgb, target: number, dir: 1 | -1, stride = 0.005): number {
  let x = from;
  for (let i = 0; i < 1000; i++) {
    if (contrastLinear(fit(x, chroma, H), bg) >= target) break;
    x += dir * stride;
    if (x <= 0.02 || x >= 0.99) break;
  }
  return x;
}

// Lightness and chroma (as a share of the accent's chroma) of the 12 steps.
// Steps 1–2 backgrounds, 3–5 interactive fills, 6–8 borders, 9–10 solid,
// 11 low-contrast text, 12 high-contrast text (Radix's naming).
const LIGHT_L = [0.99, 0.972, 0.945, 0.92, 0.89, 0.86, 0.81, 0.735] as const;
const LIGHT_L_TEXT = [0.5, 0.27] as const;
const DARK_L = [0.19, 0.215, 0.245, 0.275, 0.305, 0.345, 0.4, 0.48] as const;
const DARK_L_TEXT = [0.8, 0.94] as const;
const LIGHT_CHROMA = [0.06, 0.1, 0.22, 0.32, 0.42, 0.5, 0.6, 0.75, 1, 1, 0.85, 0.4] as const;
const DARK_CHROMA = [0.12, 0.15, 0.3, 0.4, 0.5, 0.55, 0.62, 0.75, 0.9, 0.9, 0.7, 0.25] as const;

const LINK_CONTRAST = 4.8; // a margin over the promised 4.5, for the rounding to 8 bits
const MUTED_CONTRAST = 5.5;
const TEXT_CONTRAST = 13;
const STRONG_CONTRAST = 10;
const FINE_STRIDE = 0.001; // the app's text colours land close to their target instead of a step past it
const LABEL_CONTRAST = 4.7; // the button's label on the button (promise 4.5, a margin for 8-bit rounding)
const BUTTON_TEXT_INK: Oklch = { L: 0.2, C: 0.02, H: 0 };

/** The colours of `accent` in one scheme. `tint` (0..~2.5) scales how much of the
 *  accent's hue the page's greys carry (a paper-like warmth for 紙本). */
export function schemeColors(accent: string, mode: SchemeMode, tint: number): SchemeColors {
  const { L, C, H } = hexToOklch(accent);
  const dark = mode === "dark";
  const solidL = dark ? Math.min(0.76, Math.max(0.62, L + 0.06)) : Math.min(0.66, Math.max(0.5, L));
  const solidSecondL = dark ? solidL + 0.04 : solidL - 0.04;
  const Ls = [...(dark ? DARK_L : LIGHT_L), solidL, solidSecondL, ...(dark ? DARK_L_TEXT : LIGHT_L_TEXT)];
  const Cf = dark ? DARK_CHROMA : LIGHT_CHROMA;
  const dir = dark ? 1 : -1;

  const greyChroma = Math.min(0.016, C * 0.12) * tint;
  const bg = fit(Ls[0]!, greyChroma * (dark ? 1 : 1.4), H);

  // Text steps move away from the page until they pass; the accent ramp's
  // steps 11–12 and the grey ramp's both do.
  const linkL = solveLightness(Ls[10]!, C * Cf[10]!, H, bg, LINK_CONTRAST, dir);
  const strongL = solveLightness(Ls[11]!, C * Cf[11]!, H, bg, STRONG_CONTRAST, dir);
  const steps = Ls.map((l, i) => fit(i === 10 ? linkL : i === 11 ? strongL : l, C * Cf[i]!, H));
  const textL = solveLightness(Ls[11]!, greyChroma, H, bg, TEXT_CONTRAST, dir);
  const mutedL = solveLightness(Ls[10]!, greyChroma, H, bg, MUTED_CONTRAST, dir);
  const greys = Ls.map((l, i) => fit(i === 11 ? textL : i === 10 ? mutedL : l, greyChroma, H));

  const button = steps[8]!;
  const ink = fit(BUTTON_TEXT_INK.L, BUTTON_TEXT_INK.C, H);
  const buttonText = contrastLinear(button, WHITE) >= contrastLinear(button, ink) ? WHITE : ink;
  return {
    bg: toHex(bg), surface: toHex(greys[1]!), border: toHex(greys[4]!), text: toHex(greys[11]!), muted: toHex(greys[10]!),
    link: toHex(steps[10]!), chipBg: toHex(steps[2]!), chipText: toHex(steps[10]!),
    button: toHex(button), buttonText: toHex(buttonText), soft: toHex(steps[dark ? 4 : 3]!),
  };
}

// ── The app's colours: two seeds (accent + paper) → every `--ac-*` colour ──
//
// schemeColors above tints the greys with the accent's hue, which suits a
// published page but turns a wine-red accent into a pink paper. The app keeps
// the two apart: `paper` is the light page colour and sets the hue and warmth
// of every grey; `accent` sets the buttons, links and selection. The dark
// scheme is derived from the same two seeds (a darker paper of the same hue, a
// lighter and softer accent).
//
// Each text colour starts at a typical lightness and moves away from the page
// until it reaches its contrast target, so the promises hold for any seed:
// text on page ≥ 13, secondary ≥ 9, muted ≥ 5.5, faint ≥ 4 (12.5px and up
// only), link ≥ 4.5, the button's label on the button ≥ 4.5, and a status
// colour on the page ≥ 4.5 (palette.test.ts checks them for the presets and
// random seeds).

export type AppSeed = { accent: string; paper: string };

/** The app's own look (「赭紅墨」). styles/tokens.css holds this seed's colours;
 *  frontend's appColors.test.ts checks the two agree. */
export const DEFAULT_APP_SEED: AppSeed = { accent: "#9c3a48", paper: "#f8f4ec" };

/** The presets Settings › Appearance › Colours offers, in order. */
export const APP_COLOR_PRESETS: ReadonlyArray<{ id: string } & AppSeed> = [
  { id: "ochre", ...DEFAULT_APP_SEED },
  { id: "green", accent: "#2f6b4f", paper: "#f3f2ea" },
  { id: "indigo", accent: "#36589a", paper: "#f3f3f0" },
  { id: "amber", accent: "#9a5212", paper: "#faf4e8" },
  { id: "wisteria", accent: "#6a4c93", paper: "#f5f2f4" },
  { id: "graphite", accent: "#45474b", paper: "#f4f4f2" },
];

/** The app colour names `appTokens` returns (each is `--ac-<name>` in CSS). */
export const APP_TOKEN_NAMES = [
  "bg", "surface", "elevated", "raised", "hover", "selected", "line",
  "ink", "ink-2", "muted", "faint",
  "accent", "accent-ink", "accent-soft", "focus", "link", "selection",
  "danger", "danger-soft", "warning", "success", "info", "code-bg",
  "hl-yellow", "hl-red", "hl-green", "hl-blue", "hl-purple", "hl-orange",
] as const;
export type AppTokenName = (typeof APP_TOKEN_NAMES)[number];

// Status colours keep their hue whatever the seeds are: [hue, chroma, light start].
// Blue starts a little darker: its 16% tint (the "soft" fill behind it) is the
// one a status label must also read on, and blue's tint is the darkest.
const STATUS: Record<"danger" | "warning" | "success" | "info", readonly [number, number, number]> = {
  danger: [35, 0.15, 0.5], warning: [80, 0.13, 0.5], success: [135, 0.12, 0.5], info: [245, 0.1, 0.49],
};
// Highlighter marks keep their hue too: [hue, light chroma, dark chroma, lift].
// Only the lightness follows the scheme (a pale wash on light paper, a deep one
// on dark); yellow reads brighter than the others at equal lightness, hence the lift.
const HIGHLIGHTS: Record<string, readonly [number, number, number, number]> = {
  yellow: [94, 0.086, 0.05, 0.028], red: [22, 0.05, 0.052, 0], green: [130, 0.05, 0.043, 0],
  blue: [247, 0.03, 0.043, 0], purple: [304, 0.036, 0.049, 0], orange: [62, 0.05, 0.045, 0],
};

/** All the app's colours (`#rrggbb`, keyed by APP_TOKEN_NAMES) for one scheme of
 *  the seeds `accent` and `paper`. */
export function appTokens(accent: string, paper: string, mode: SchemeMode): Record<AppTokenName, string> {
  const a = hexToOklch(accent);
  const p = hexToOklch(paper);
  const dark = mode === "dark";
  const dir = dark ? 1 : -1;
  // Greys carry the paper's hue and at most a little of its chroma.
  const paperChroma = Math.min(p.C, 0.03);
  const grey = (L: number, k = 1) => fit(L, paperChroma * k, p.H);
  const bgL = dark ? 0.22 : p.L;
  const bg = dark ? grey(bgL, 0.6) : linearOfHex(paper);
  // A fill a step away from the page: darker on light, lighter on dark.
  const step = (d: number, k = 1) => grey(bgL + (dark ? d : -d), k);
  // A colour of this chroma and hue that reaches `target` contrast on the page.
  const reach = (start: number, C: number, H: number, target: number) =>
    fit(solveLightness(start, C, H, bg, target, dir, FINE_STRIDE), C, H);

  const accentL = dark ? Math.min(0.8, Math.max(0.68, a.L + 0.25)) : Math.min(0.55, Math.max(0.42, a.L));
  const accentC = dark ? a.C * 0.62 : a.C;
  // The button label is near-white if that reads, else a dark ink (a grey accent has
  // no hue worth carrying into the ink, so it takes the paper's). A fill that reads
  // with neither moves along its lightness until its label does.
  const inkHue = a.C < 0.04 ? p.H : a.H;
  const lightInk = fit(0.985, paperChroma * 0.6, p.H);
  const darkInk = fit(0.2, 0.03, inkHue);
  let fill = fit(accentL, accentC, a.H);
  const labelOn = (f: Rgb) => (contrastLinear(f, WHITE) >= LABEL_CONTRAST ? lightInk : darkInk);
  let fillInk = labelOn(fill);
  if (contrastLinear(fill, fillInk) < LABEL_CONTRAST) {
    const toward = fillInk === lightInk ? -1 : 1;
    fill = fit(solveLightness(accentL, accentC, a.H, fillInk, LABEL_CONTRAST, toward, FINE_STRIDE), accentC, a.H);
  }
  const tint = (L: number, k: number, H = a.H, C = a.C) => fit(L, C * k, H);
  const status = (name: keyof typeof STATUS) => {
    const [H, C, lightStart] = STATUS[name];
    if (dark) return reach(0.76, C * 0.7, H, 7);
    // On light paper a label also sits on its own soft fill, a shade darker than
    // the page: it darkens until it reads there too (danger has its own soft token).
    let target = 4.8;
    let colour = reach(lightStart, C, H, target);
    while (name !== "danger" && contrastLinear(colour, softOf(colour, bg)) < LABEL_CONTRAST) colour = reach(lightStart, C, H, (target += 0.05));
    return colour;
  };
  const raised = step(dark ? 0.025 : 0.03);

  const colors = {
    bg, surface: step(dark ? 0.012 : 0.025),
    elevated: dark ? step(0.04) : fit(Math.min(0.995, bgL + 0.025), paperChroma * 0.5, p.H),
    raised, "code-bg": raised, hover: step(dark ? 0.03 : 0.035), line: step(dark ? 0.085 : 0.06, dark ? 1.5 : 1.8),
    selected: tint(dark ? 0.3 : 0.92, dark ? 0.2 : 0.16),
    ink: reach(dark ? 0.9 : 0.3, paperChroma * 1.2, p.H, 13.5),
    "ink-2": reach(dark ? 0.82 : 0.4, paperChroma * 1.4, p.H, 9.1),
    muted: reach(dark ? 0.7 : 0.5, paperChroma * 1.6, p.H, 5.55),
    faint: reach(dark ? 0.6 : 0.58, paperChroma * 1.4, p.H, 4.05),
    accent: fill, "accent-ink": fillInk,
    "accent-soft": tint(dark ? 0.31 : 0.925, dark ? 0.22 : 0.18),
    focus: tint(dark ? accentL + 0.05 : accentL + 0.08, dark ? 0.55 : 0.85),
    link: reach(accentL + (dark ? 0.03 : 0), accentC, a.H, dark ? 7 : 4.8),
    selection: tint(dark ? 0.36 : 0.88, dark ? 0.3 : 0.25),
    danger: status("danger"), "danger-soft": tint(dark ? 0.3 : 0.93, dark ? 0.35 : 0.3, STATUS.danger[0], STATUS.danger[1]),
    warning: status("warning"), success: status("success"), info: status("info"),
    ...Object.fromEntries(Object.entries(HIGHLIGHTS).map(([name, [H, lightC, darkC, lift]]) =>
      [`hl-${name}`, fit((dark ? 0.34 : 0.905) + lift, dark ? darkC : lightC, H)])),
  } as Record<AppTokenName, Rgb>;
  return Object.fromEntries(Object.entries(colors).map(([k, v]) => [k, toHex(v)])) as Record<AppTokenName, string>;
}
