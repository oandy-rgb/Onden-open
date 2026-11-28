// Colour contrast, from the tokens instead of from a rendered page (jsdom has
// no layout or cascade, so axe's color-contrast rule cannot run there).
//   1. the documented text/background pairs of tokens.css meet WCAG AA in the
//      light and the dark theme (4.5:1 text, 3:1 large text and UI borders);
//   2. component CSS does not hard-code a colour for text or background:
//      it uses a token, or is on the allowlist below with its reason.
import { describe, expect, it } from "vitest";
import { CONTRAST_BASELINE, guardAgainstNewViolations, HARDCODED_COLOUR_BASELINE } from "./baseline";
import { allColourLiterals, colourLiterals, type ColourLiteral } from "./colourScan";
import { contrastRatio, mix, parseHex, readPalette, type Palette, type Rgb, type Theme } from "./contrast";

const TEXT = 4.5;
const LARGE_OR_UI = 3;

/** Text colours and the surfaces they sit on, as the --ac-* comments of tokens.css document them. */
const SURFACES = ["bg", "surface", "elevated", "raised"] as const;
const SOFT_STATES = ["danger", "warning", "success", "info"] as const;

interface Pair { id: string; foreground: Rgb; background: Rgb; minimum: number }

function pairs(p: Palette): Pair[] {
  const out: Pair[] = [];
  const add = (id: string, foreground: Rgb, background: Rgb, minimum = TEXT) => out.push({ id, foreground, background, minimum });
  for (const surface of SURFACES) {
    for (const ink of ["ink", "ink-2", "muted", "link", "accent"] as const) add(`${ink} on ${surface}`, p[ink], p[surface]);
    for (const state of SOFT_STATES) add(`${state} on ${surface}`, p[state], p[surface]);
    // --ac-faint is for ≥12.5px labels and --onden-border-strong: the 3:1 line.
    add(`faint on ${surface} (large text and borders)`, p.faint, p[surface], LARGE_OR_UI);
    add(`focus ring on ${surface}`, p.focus, p[surface], LARGE_OR_UI);
  }
  for (const state of SOFT_STATES) {
    const soft = state === "danger" ? p["danger-soft"] : mix(p[state], 16, p.bg);
    add(`${state} on ${state}-soft`, p[state], soft);
  }
  add("ink on hover", p.ink, p.hover);
  add("ink on selected", p.ink, p.selected);
  add("ink on selection", p.ink, p.selection);
  add("link on accent-soft (tag chip)", p.link, p["accent-soft"]);
  add("accent on accent-soft (icon toggle that is on)", p.accent, p["accent-soft"]);
  add("accent-ink on accent (filled button)", p["accent-ink"], p.accent);
  add("accent-ink on accent-hover (filled button, hovered)", p["accent-ink"], mix(p.accent, 85, p.ink));
  for (const colour of ["yellow", "red", "green", "blue", "purple", "orange"]) add(`ink on highlight ${colour}`, p.ink, p[`hl-${colour}`]);
  return out;
}

function failingPairs(): string[] {
  return (["light", "dark"] as Theme[]).flatMap((theme) => {
    const palette = readPalette(theme);
    return pairs(palette)
      .filter((pair) => contrastRatio(pair.foreground, pair.background) < pair.minimum)
      .map((pair) => `${theme}: ${pair.id}`);
  });
}

describe("colour tokens", () => {
  it("reads every token the pairs need from both themes", () => {
    for (const theme of ["light", "dark"] as Theme[]) {
      const palette = readPalette(theme);
      for (const key of ["bg", "surface", "elevated", "raised", "ink", "ink-2", "muted", "faint", "link", "accent", "accent-ink", "accent-soft",
        "focus", "danger", "danger-soft", "warning", "success", "info", "hover", "selected", "selection", "hl-yellow"]) {
        expect(palette[key], `${theme} --ac-${key}`).toBeDefined();
      }
    }
  });

  it("agrees with the ratios tokens.css documents for ink on bg", () => {
    expect(contrastRatio(readPalette("light").ink, readPalette("light").bg)).toBeCloseTo(13.54, 1);
    expect(contrastRatio(readPalette("dark").ink, readPalette("dark").bg)).toBeCloseTo(13.59, 1);
  });

  it("measures contrast like WCAG", () => {
    expect(contrastRatio(parseHex("#000"), parseHex("#fff"))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseHex("#777"), parseHex("#fff"))).toBeCloseTo(4.48, 1);
  });
});

guardAgainstNewViolations("documented text/background token pairs meet WCAG AA", failingPairs, CONTRAST_BASELINE);

// A hard-coded colour does not follow the theme, so it is right in one theme at best.
// Allowed here only when it is meant to be the same in both themes; say why.
const HARD_CODED_ALLOWED: Record<string, string> = {
  "styles/print-export.css size: A4; margin: 20mm 18mm 22mm; @bottom-center { color }": "paper for the print window: white page, dark text, same in both themes; the app theme never reaches it",
  "styles/print-export.css html, body { background }": "paper for the print window: white page, dark text, same in both themes; the app theme never reaches it",
  "styles/print-export.css body.site-root { color }": "paper for the print window: white page, dark text, same in both themes; the app theme never reaches it",
  "components/InkToolbar.css .ink-picker-square { background }":
    "the colour picker's own colours (white to the hue, then to black): the picture of every colour, not a themed surface",
  "components/InkToolbar.css .ink-picker-hue-track { background }":
    "the colour picker's hue bar: the rainbow itself, not a themed surface",
  "components/PdfNodeView.css .pdf-hl-text { background }":
    "a PDF page is white paper in both themes; the marks are drawn on it, not on the page background",
  "components/PdfNodeView.css .pdf-hl-area { background }":
    "a PDF page is white paper in both themes; the marks are drawn on it, not on the page background",
  "components/PdfNodeView.css .pdf-area-preview { background }":
    "a PDF page is white paper in both themes; the marks are drawn on it, not on the page background",
  "modules/capture/QuickCapture.css .quick-capture-image-remove { background }":
    "a chip over a photo: contrast is against the photo, not the theme",
  "modules/capture/QuickCapture.css .quick-capture-image-remove { color }":
    "a chip over a photo: contrast is against the photo, not the theme",
  "modules/tasks/TasksMode.css .agenda-quick-add-btn:not(:disabled):hover { background }":
    "a token darkened toward black on hover; still follows the theme token",
  "modules/tasks/TasksMode.css .tasks-list .task-editor-scrim { background }":
    "a neutral black scrim, the same in both themes",
  "components/ui/ui.css .ui-btn--danger:hover:not(:disabled) { background }":
    "a token darkened toward black on hover; still follows the theme token",
};

const literalId = (l: ColourLiteral): string => `${l.file} ${l.selector} { ${l.property} }`;

function hardCodedColours(): string[] {
  const seen = new Map<string, number>();
  return allColourLiterals().map((l) => {
    const base = literalId(l);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} #${n}`;
  }).filter((id) => !(id in HARD_CODED_ALLOWED));
}

guardAgainstNewViolations("component CSS takes text and background colours from tokens", hardCodedColours, HARDCODED_COLOUR_BASELINE);

describe("the colour scan itself", () => {
  it("flags a literal in color/background, ignores tokens, var() fallbacks and borders", () => {
    const css = `/* color: #111; */
      .a { color: #123456; background: var(--ac-bg); border-color: #fff; }
      .b { background: var(--x, #fff); color: rgb(1 2 3); }
      @media (pointer: coarse) { .c:hover { background-color: color-mix(in srgb, #a78bfa 18%, transparent); } }`;
    expect(colourLiterals("x.css", css).map((l) => `${l.selector} ${l.property}`)).toEqual([
      ".a color", ".b color", ".c:hover background-color",
    ]);
  });
});
