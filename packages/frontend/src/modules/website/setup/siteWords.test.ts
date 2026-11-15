import { afterEach, describe, expect, it } from "vitest";
import { BOX_SPECS, BUILTIN_WIDGETS, HOME_PRESETS } from "@onden/site";
import { setLocalePref } from "../../../lib/i18n";
import { KNOWN_SITE_WORDS, presetWord, siteWord } from "./siteWords";

afterEach(() => setLocalePref("system"));

describe("the words of the site's registries", () => {
  const siteWords = [
    ...Object.values(BOX_SPECS).map((b) => b.label),
    ...BUILTIN_WIDGETS.flatMap((w) => [w.label, w.blurb, ...(w.needs ? [w.needs] : []), ...w.variants.map((v) => v.label)]),
  ];
  const presetWords = Object.values(HOME_PRESETS).flatMap((p) => [p.label, p.blurb]);

  it("every box, widget, look and home page style has an English wording", () => {
    expect(siteWords.filter((w) => !KNOWN_SITE_WORDS.site.has(w))).toEqual([]);
    expect(presetWords.filter((w) => !KNOWN_SITE_WORDS.presets.has(w))).toEqual([]);
  });

  it("an English interface shows no Chinese for them", () => {
    setLocalePref("en");
    for (const w of siteWords) expect(siteWord(w)).not.toMatch(/[一-鿿]/);
    for (const w of presetWords) expect(presetWord(w)).not.toMatch(/[一-鿿]/);
  });

  it("the Chinese interface shows the original wording", () => {
    setLocalePref("zh-TW");
    for (const w of siteWords) expect(siteWord(w)).toBe(w);
    for (const w of presetWords) expect(presetWord(w)).toBe(w);
  });

  it("a word the registry does not know (a module's own widget) is shown as written", () => {
    setLocalePref("en");
    expect(siteWord("部落格卷")).toBe("部落格卷");
  });
});
