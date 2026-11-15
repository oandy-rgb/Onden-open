import { describe, expect, it } from "vitest";
import type { SiteStyle } from "./design.js";
import { ACCENT_SWATCHES, FONT_STACKS, SPACE_LINES, STYLE_PRESETS, colorVars, stepRange, styleCss, styleVars } from "./style.js";

const quiet: SiteStyle = { preset: "quiet", accent: "#3f7d6e", scheme: "system" };

describe("style presets", () => {
  it("are the four temperaments", () => {
    expect(Object.keys(STYLE_PRESETS)).toEqual(["quiet", "paper", "folio", "hand"]);
    expect(Object.values(STYLE_PRESETS).map((p) => p.label)).toEqual(["安靜", "紙本", "書冊", "手寫"]);
    expect(STYLE_PRESETS.paper).toMatchObject({ base: 17, ratio: 1.333, head: "serif", body: "serif", headWeight: 600, leading: 1.95, radius: 3, measure: "34em", tint: 2.2 });
    expect(STYLE_PRESETS.folio).toMatchObject({ ratio: 1.414, head: "serif", body: "sans", tint: 0.6 });
    expect(STYLE_PRESETS.hand).toMatchObject({ base: 18, ratio: 1.2, head: "kai", body: "kai", radius: 14 });
  });
  it("offers six accent swatches", () => {
    expect(ACCENT_SWATCHES).toEqual(["#3f7d6e", "#b23a2a", "#2a5bd7", "#b0489a", "#e8772e", "#f2c230"]);
  });
});

describe("type scale", () => {
  it("runs from (base-1) × (1 + (ratio-1) × 0.75)^n at 360px to base × ratio^n at 1240px", () => {
    const { min, max } = stepRange(STYLE_PRESETS.quiet, 2);
    expect(min).toBeCloseTo(16 * (1 + 0.25 * 0.75) ** 2, 6);
    expect(max).toBeCloseTo(17 * 1.25 ** 2, 6);
    expect(stepRange(STYLE_PRESETS.quiet, 0)).toEqual({ min: 16, max: 17 });
  });
  it("emits clamp() for steps -1 to 3, linear between the two widths", () => {
    const v = styleVars(quiet);
    for (const name of ["--s-step-1", "--s-base", "--s-step1", "--s-step2", "--s-step3"]) expect(v[name]).toMatch(/^clamp\(/);
    // base: 16px at 360, 17px at 1240 → slope 1/880 px per px = 0.1136vw, intercept 16 - 360/880
    expect(v["--s-base"]).toBe("clamp(16px, 15.59px + 0.1136vw, 17px)");
  });
  it("evaluates to the two ends at the end widths", () => {
    const [min, intercept, vw, max] = /^clamp\(([\d.]+)px, ([\d.]+)px \+ ([\d.]+)vw, ([\d.]+)px\)$/.exec(styleVars(quiet)["--s-step3"]!)!.slice(1).map(Number) as [number, number, number, number];
    const at = (width: number) => Math.min(max, Math.max(min, intercept + (vw / 100) * width));
    const range = stepRange(STYLE_PRESETS.quiet, 3);
    expect(at(360)).toBeCloseTo(range.min, 1);
    expect(at(1240)).toBeCloseTo(range.max, 1);
    expect(at(800)).toBeCloseTo((range.min + range.max) / 2, 1);
    expect(at(200)).toBeCloseTo(range.min, 1);
    expect(at(2000)).toBeCloseTo(range.max, 1);
  });
  it("draws plain px at a given viewport (the studio's phone preview)", () => {
    expect(styleVars(quiet, { viewport: 360 })["--s-base"]).toBe("16px");
    expect(styleVars(quiet, { viewport: 1240 })["--s-base"]).toBe("17px");
    expect(styleVars(quiet, { viewport: 3000 })["--s-base"]).toBe("17px");
  });
});

describe("styleVars", () => {
  it("spaces by lines of text: ¼, ½, 1, 1.5, 2, 3 of body size × line height", () => {
    const v = styleVars(quiet);
    expect(SPACE_LINES).toEqual([0.25, 0.5, 1, 1.5, 2, 3]);
    expect(v["--s-space-1"]).toBe("calc(var(--s-base) * 0.4625)");
    expect(v["--s-space-3"]).toBe("calc(var(--s-base) * 1.85)");
    expect(v["--s-space-6"]).toBe("calc(var(--s-base) * 5.55)");
    expect(v["--s-space"]).toBe("var(--s-space-3)");
  });
  it("picks fonts, radius and line length from the preset", () => {
    const v = styleVars({ ...quiet, preset: "hand" });
    expect(v["--s-font-h"]).toBe(FONT_STACKS.kai);
    expect(v["--s-font-b"]).toBe(FONT_STACKS.kai);
    expect(v["--s-radius"]).toBe("14px");
    expect(v["--s-measure"]).toBe("34em");
    expect(FONT_STACKS.kai).toBe('"Kaiti TC", "BiauKai", "DFKai-SB", serif');
    expect(styleVars({ ...quiet, preset: "folio" })["--s-font-h"]).toBe(FONT_STACKS.serif);
    expect(styleVars({ ...quiet, preset: "folio" })["--s-font-b"]).toBe(FONT_STACKS.sans);
  });
  it("carries one scheme's colours; a dark site and the dark mode get the dark ones", () => {
    const light = colorVars(quiet, "light");
    const dark = colorVars(quiet, "dark");
    expect(Object.keys(light).sort()).toEqual(["--s-accent", "--s-bg", "--s-border", "--s-button", "--s-button-text", "--s-chip-bg", "--s-chip-text", "--s-link", "--s-muted", "--s-soft", "--s-surface", "--s-text"]);
    expect(light["--s-bg"]).not.toBe(dark["--s-bg"]);
    expect(styleVars(quiet)["--s-bg"]).toBe(light["--s-bg"]);
    expect(styleVars({ ...quiet, scheme: "dark" })["--s-bg"]).toBe(dark["--s-bg"]);
    expect(styleVars(quiet, { mode: "dark" })["--s-bg"]).toBe(dark["--s-bg"]);
    expect(styleVars({ ...quiet, scheme: "dark" }, { mode: "light" })["--s-bg"]).toBe(light["--s-bg"]);
  });
});

describe("styleCss", () => {
  it("system: light by default, dark under prefers-color-scheme", () => {
    const css = styleCss(quiet, ".site-scope");
    expect(css).toContain(`.site-scope{`);
    expect(css).toContain("color-scheme:light dark");
    expect(css).toContain('@media (prefers-color-scheme: dark){html:not([data-theme="light"]) .site-scope{--s-bg:' + colorVars(quiet, "dark")["--s-bg"]);
    expect(css.indexOf("--s-bg:" + colorVars(quiet, "light")["--s-bg"])).toBeGreaterThan(-1);
  });
  it("system: the reader's own choice (data-theme on <html>) beats the system's, in both directions", () => {
    const css = styleCss(quiet, "html.onden-site, .site-scope");
    expect(css).toContain('html.onden-site:not([data-theme="light"]), html:not([data-theme="light"]) .site-scope{');
    expect(css).toContain('html.onden-site[data-theme="dark"], html[data-theme="dark"] .site-scope{');
    expect(css).toContain('html.onden-site[data-theme="light"], html[data-theme="light"] .site-scope{');
  });
  it("light or dark: only that scheme, with color-scheme set", () => {
    const light = styleCss({ ...quiet, scheme: "light" }, ".site-scope");
    expect(light).not.toContain("@media");
    expect(light).toContain("color-scheme:light");
    expect(light).toContain(colorVars(quiet, "light")["--s-bg"]);
    const dark = styleCss({ ...quiet, scheme: "dark" }, ".site-scope");
    expect(dark).not.toContain("@media");
    expect(dark).toContain("color-scheme:dark");
    expect(dark).toContain(colorVars(quiet, "dark")["--s-bg"]);
    expect(dark).not.toContain(colorVars(quiet, "light")["--s-bg"]);
  });
});
