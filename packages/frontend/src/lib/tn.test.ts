import { afterEach, describe, expect, it } from "vitest";
import { registerDictionary, setLocalePref, tn } from "./i18n";

describe("tn", () => {
  afterEach(() => setLocalePref("en"));

  it("picks the singular for 1 and the plural otherwise, filling {n} and {count}", () => {
    expect(tn("1 note", "{n} notes", 1)).toBe("1 note");
    expect(tn("1 note", "{n} notes", 3)).toBe("3 notes");
    expect(tn("1 note", "{count} notes", 0)).toBe("0 notes");
  });

  it("lets vars add to the count or override it", () => {
    expect(tn("Moved to {space}", "Moved {n} notes to {space}", 2, { n: 1, space: "Work" })).toBe("Moved 1 notes to Work");
  });

  it("looks each form up in the dictionary", () => {
    registerDictionary("zh-TW", { "1 note": "1 篇筆記", "{n} notes": "{n} 篇筆記" });
    setLocalePref("zh-TW");
    expect(tn("1 note", "{n} notes", 1)).toBe("1 篇筆記");
    expect(tn("1 note", "{n} notes", 5)).toBe("5 篇筆記");
  });
});
