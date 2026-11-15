import { afterEach, describe, expect, it } from "vitest";
import { setLocalePref, t } from "../../lib/i18n";
import { INFO_AI_ZH_TW } from "../../components/infoAi/strings.zh-TW";
import { SLIDES_ZH_TW } from "./i18n.zh-TW";

// The parts that load their own wording with their screen (the slides tab, the info panel's AI tab) each add to one
// dictionary through registerDictionary; opening one must never take another's words back to English.
describe("wording loaded with a screen", () => {
  afterEach(() => setLocalePref("en"));

  it("stays when another screen's wording is registered after it, in either order", async () => {
    const slidesKey = "Slide {n}";
    const aiKey = Object.keys(INFO_AI_ZH_TW)[0]!;
    setLocalePref("zh-TW");
    await import("./i18n");
    expect(t(slidesKey, { n: 2 })).toBe(SLIDES_ZH_TW[slidesKey]!.replace("{n}", "2"));
    await import("../../components/infoAi");
    expect(t(aiKey)).toBe(INFO_AI_ZH_TW[aiKey]);
    expect(t(slidesKey, { n: 2 })).toBe(SLIDES_ZH_TW[slidesKey]!.replace("{n}", "2"));
  });
});
