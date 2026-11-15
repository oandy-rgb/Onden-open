// The website's output must not change because slides share its formulas
// (docs/architecture/proposals/slides-2026-10-31.md §5.1). styleCss for every
// preset × swatch × scheme is kept as a snapshot made BEFORE the slides look
// existed: a change of one character in any site's CSS turns this red. If the
// site's look is meant to change, update the snapshot in that change and say so.
import { describe, expect, it } from "vitest";
import type { SiteScheme } from "./design.js";
import { ACCENT_SWATCHES, STYLE_PRESET_NAMES, styleCss } from "./style.js";

const SCHEME_CHOICES: SiteScheme[] = ["system", "light", "dark"];

describe("styleCss golden", () => {
  const out: Record<string, string> = {};
  for (const preset of STYLE_PRESET_NAMES) for (const accent of ACCENT_SWATCHES) for (const scheme of SCHEME_CHOICES) {
    out[`${preset} ${accent} ${scheme}`] = styleCss({ preset, accent, scheme }, ".site-scope");
  }
  it("covers 4 presets × 6 swatches × 3 schemes", () => {
    expect(Object.keys(out)).toHaveLength(72);
  });
  it("is byte for byte what the published site has always got", () => {
    expect(out).toMatchSnapshot();
  });
});
