import { describe, expect, it } from "vitest";
import { ACCENT_SWATCHES } from "./style.js";
import { APP_COLOR_PRESETS, DEFAULT_APP_SEED, appTokens, contrastRatio, hexToOklch, schemeColors, type AppSeed, type SchemeMode } from "./palette.js";

// A fixed pseudo-random sequence, so a failing accent can be named in the report.
function randomAccents(count: number): string[] {
  let seed = 20261025;
  const next = () => { seed = (seed * 1664525 + 1013904223) % 2 ** 32; return seed / 2 ** 32; };
  return Array.from({ length: count }, () => `#${[next(), next(), next()].map((v) => Math.floor(v * 256).toString(16).padStart(2, "0")).join("")}`);
}
const ACCENTS = [...ACCENT_SWATCHES, ...randomAccents(10)];
const TINTS = [0.6, 1, 1.6, 2.2];
const MODES: SchemeMode[] = ["light", "dark"];

describe("schemeColors: contrast promises", () => {
  for (const accent of ACCENTS) {
    for (const mode of MODES) {
      it(`${accent} ${mode}: text ≥ 7, link ≥ 4.5, button label ≥ 4.5 (all tints)`, () => {
        for (const tint of TINTS) {
          const c = schemeColors(accent, mode, tint);
          expect(contrastRatio(c.text, c.bg), `text ${tint}`).toBeGreaterThanOrEqual(7);
          expect(contrastRatio(c.muted, c.bg), `muted ${tint}`).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(c.link, c.bg), `link ${tint}`).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(c.chipText, c.chipBg), `chip ${tint}`).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(c.buttonText, c.button), `button ${tint}`).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  }
  it("is light on a light page and dark on a dark one", () => {
    const light = schemeColors("#2a5bd7", "light", 1);
    const dark = schemeColors("#2a5bd7", "dark", 1);
    expect(hexToOklch(light.bg).L).toBeGreaterThan(0.95);
    expect(hexToOklch(dark.bg).L).toBeLessThan(0.25);
    expect(hexToOklch(light.text).L).toBeLessThan(hexToOklch(light.bg).L);
    expect(hexToOklch(dark.text).L).toBeGreaterThan(hexToOklch(dark.bg).L);
  });
  it("keeps the accent's hue in the button", () => {
    const { H } = hexToOklch("#2a5bd7");
    const button = hexToOklch(schemeColors("#2a5bd7", "light", 1).button);
    expect(Math.abs(button.H - H)).toBeLessThan(8);
  });
  it("hexToOklch round-trips the lightness of known colours", () => {
    expect(hexToOklch("#ffffff").L).toBeCloseTo(1, 2);
    expect(hexToOklch("#000000").L).toBeCloseTo(0, 2);
    expect(hexToOklch("#ff0000").L).toBeCloseTo(0.628, 2);
  });
  it("contrastRatio matches the WCAG extremes", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
  });
});

// ── appTokens: the app's two-seed palette ──

function randomSeeds(count: number): AppSeed[] {
  let seed = 20261030;
  const next = () => { seed = (seed * 1664525 + 1013904223) % 2 ** 32; return seed / 2 ** 32; };
  const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  return Array.from({ length: count }, () => ({
    accent: hex(next() * 255, next() * 255, next() * 255),
    // A paper is a light colour: 215..255 per channel, mostly near-neutral.
    paper: hex(215 + next() * 40, 215 + next() * 40, 215 + next() * 40),
  }));
}
const APP_SEEDS: AppSeed[] = [...APP_COLOR_PRESETS, ...randomSeeds(60)];

describe("appTokens: contrast promises", () => {
  for (const seed of APP_SEEDS) {
    for (const mode of MODES) {
      it(`${seed.accent} on ${seed.paper} ${mode}`, () => {
        const c = appTokens(seed.accent, seed.paper, mode);
        const on = (fg: string, bg: string) => contrastRatio(fg, bg);
        expect(on(c.ink, c.bg), "ink").toBeGreaterThanOrEqual(13);
        expect(on(c["ink-2"], c.bg), "ink-2").toBeGreaterThanOrEqual(9);
        expect(on(c.muted, c.bg), "muted").toBeGreaterThanOrEqual(5.5);
        expect(on(c.faint, c.bg), "faint").toBeGreaterThanOrEqual(4);
        expect(on(c.link, c.bg), "link").toBeGreaterThanOrEqual(4.5);
        expect(on(c["accent-ink"], c.accent), "accent-ink").toBeGreaterThanOrEqual(4.5);
        for (const s of ["danger", "warning", "success", "info"] as const) {
          expect(on(c[s], c.bg), s).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  }
  it("the light page is the paper itself; dark is darker than any ink", () => {
    expect(appTokens(DEFAULT_APP_SEED.accent, DEFAULT_APP_SEED.paper, "light").bg).toBe(DEFAULT_APP_SEED.paper);
    const dark = appTokens(DEFAULT_APP_SEED.accent, DEFAULT_APP_SEED.paper, "dark");
    expect(hexToOklch(dark.bg).L).toBeLessThan(0.25);
    expect(hexToOklch(dark.ink).L).toBeGreaterThan(0.85);
  });
  it("keeps the paper's hue in the greys: a wine accent does not pink the paper", () => {
    const paperHue = hexToOklch(DEFAULT_APP_SEED.paper).H;
    const c = appTokens("#8a1c3c", DEFAULT_APP_SEED.paper, "light");
    for (const k of ["surface", "raised", "line", "muted"] as const) {
      expect(Math.abs(hexToOklch(c[k]).H - paperHue), k).toBeLessThan(12);
    }
  });
  it("a grey accent's dark-mode label takes the paper's hue, not a blue cast", () => {
    const seed = APP_COLOR_PRESETS.find((p) => p.id === "graphite")!;
    const c = appTokens(seed.accent, seed.paper, "dark");
    const ink = hexToOklch(c["accent-ink"]);
    expect(Math.abs(ink.H - hexToOklch(seed.paper).H)).toBeLessThan(15);
  });
});
