import { describe, expect, it } from "vitest";
import { firstImage } from "./firstImage.js";

describe("firstImage", () => {
  it("takes a Markdown image, with or without a title or angle brackets", () => {
    expect(firstImage("hi\n\n![a](/m/1.png)")).toBe("/m/1.png");
    expect(firstImage("![a](<https://x.test/a.png> \"t\")")).toBe("https://x.test/a.png");
  });
  it("takes an <img>, and the earlier of the two wins", () => {
    expect(firstImage('<img alt="" src="/m/2.png">')).toBe("/m/2.png");
    expect(firstImage('<img src="/m/2.png"> ![a](/m/1.png)')).toBe("/m/2.png");
  });
  it("skips fenced code", () => {
    expect(firstImage("```\n![a](/in-code.png)\n```\n![b](/real.png)")).toBe("/real.png");
    expect(firstImage("~~~\n![a](/in-code.png)\n~~~")).toBeUndefined();
  });
  it("returns undefined for none", () => {
    expect(firstImage("just words")).toBeUndefined();
  });
  it("moves on to the next image when `accept` refuses one", () => {
    expect(firstImage("![a](javascript:x) ![b](/ok.png)", (u) => u.startsWith("/"))).toBe("/ok.png");
  });
});
