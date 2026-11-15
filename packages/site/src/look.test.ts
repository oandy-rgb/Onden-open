import { describe, expect, it } from "vitest";
import { ACCENT_SWATCHES, STYLE_PRESET_NAMES, contrastRatio, deckVars, DECK_CANVAS, DECK_MIN_BODY_PX, DECK_MIN_TITLE_PX, type DeckStyle } from "./look.js";

const px = (value: string | undefined) => Number.parseFloat(value ?? "");

describe("deckVars", () => {
  it("uses the site's variable names at fixed px for the 1920×1080 canvas", () => {
    const v = deckVars({ preset: "quiet", accent: "#3f7d6e", scheme: "light" });
    expect(DECK_CANVAS).toEqual({ width: 1920, height: 1080 });
    expect(v["--s-base"]).toBe("43px"); // round(17 × 2.5)
    expect(v["--s-step2"]).toBe("67.19px"); // 43 × 1.25²
    for (const name of ["--s-step-1", "--s-base", "--s-step1", "--s-step2", "--s-step3"]) expect(v[name]).toMatch(/^[\d.]+px$/);
    expect(v["--s-font-b"]).toContain("Noto Sans TC");
    expect(v["--s-bg"]).toMatch(/^#[0-9a-f]{6}$/);
  });

  for (const preset of STYLE_PRESET_NAMES) {
    for (const accent of ACCENT_SWATCHES) {
      for (const scheme of ["light", "dark"] as const) {
        const style: DeckStyle = { preset, accent, scheme };
        it(`keeps the type floors and the contrast promises: ${preset} ${accent} ${scheme}`, () => {
          const v = deckVars(style);
          // Body and the one shrink level stay readable from the back of a room.
          expect(px(v["--s-base"])).toBeGreaterThanOrEqual(DECK_MIN_BODY_PX);
          expect(px(v["--s-step-1"])).toBeGreaterThanOrEqual(DECK_MIN_BODY_PX);
          expect(px(v["--s-step2"])).toBeGreaterThanOrEqual(DECK_MIN_TITLE_PX);
          // Steps grow.
          expect(px(v["--s-step3"])).toBeGreaterThan(px(v["--s-step2"]));
          expect(px(v["--s-step2"])).toBeGreaterThan(px(v["--s-step1"]));
          // The palette's promises hold on a slide: text ≥ 7, the button's label ≥ 4.5.
          expect(contrastRatio(v["--s-text"], v["--s-bg"])).toBeGreaterThanOrEqual(7);
          expect(contrastRatio(v["--s-button-text"], v["--s-button"])).toBeGreaterThanOrEqual(4.5);
          // The cover, section and full-picture text: dark decks get a deep colour with light text, and at least body-text contrast.
          expect(contrastRatio(v["--s-cover-text"], v["--s-cover"])).toBeGreaterThanOrEqual(scheme === "dark" ? 7 : 4.5);
          if (scheme === "dark") expect(contrastRatio(v["--s-cover"], v["--s-bg"])).toBeLessThan(3);
        });
      }
    }
  }
});
