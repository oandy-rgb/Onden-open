import { describe, expect, it } from "vitest";
import { DEFAULT_ACCENT } from "@onden/site/look";
import { siteLookOf, themeStyle } from "./theme";

const site = { preset: "folio", accent: "#2a5bd7", scheme: "light" } as const;

describe("the deck's theme as a style", () => {
  it("跟網站一樣 follows the website's own choices", () => {
    expect(themeStyle("site", site, "dark")).toEqual({ preset: "folio", accent: "#2a5bd7", scheme: "light" });
  });
  it("…and Onden's own light or dark where the website follows its visitor", () => {
    expect(themeStyle("site", { ...site, scheme: "system" }, "dark").scheme).toBe("dark");
    expect(themeStyle("site", { ...site, scheme: "system" }, "light").scheme).toBe("light");
  });
  it("深色 keeps the website's look but is always dark; 紙本 is the paper style, always light, in the website's colour", () => {
    expect(themeStyle("dark", site, "light")).toEqual({ preset: "folio", accent: "#2a5bd7", scheme: "dark" });
    expect(themeStyle("paper", { ...site, scheme: "dark" }, "dark")).toEqual({ preset: "paper", accent: "#2a5bd7", scheme: "light" });
  });
  it("a deck still has a look without a website design", () => {
    expect(themeStyle("site", null, "light")).toEqual({ preset: "quiet", accent: DEFAULT_ACCENT, scheme: "light" });
  });
  it("reads the website's style from its stored design and ignores damage", () => {
    expect(siteLookOf({ style: { preset: "hand", accent: "#b23a2a", scheme: "dark" } })).toEqual({ preset: "hand", accent: "#b23a2a", scheme: "dark" });
    expect(siteLookOf({ style: { preset: "hand", accent: "#b23a2a", scheme: "system" } })?.scheme).toBe("system");
    for (const bad of [null, undefined, {}, { style: null }, { style: { preset: "neon", accent: "#b23a2a" } }, { style: { preset: "quiet", accent: "red" } }]) {
      expect(siteLookOf(bad as never)).toBeNull();
    }
  });
});
