// Property: sorting Chinese and Unicode titles. The comparators the app uses
// (`String#localeCompare` in the sidebar and tag lists, `Intl.Collator("zh-Hant")`
// on the site pages) are total orders on any text and treat NFC and NFD as equal.
// Where the app's lists and the server's `ORDER BY title` agree or not is the
// current behaviour pinned at the bottom (and in the backend's
// test/properties/titleOrder.integration.property.test.ts); the PR lists it for
// a decision. Generators: markdown/src/test/helpers/unicodeText.ts. Seed and run
// count from PROPS_SEED / PROPS_RUNS.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "../../../../markdown/src/test/helpers/propsConfig";
import { titleText } from "../../../../markdown/src/test/helpers/unicodeText";

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };
const zh = new Intl.Collator("zh-Hant");
const comparators: Array<[string, (a: string, b: string) => number]> = [
  ["localeCompare (browser locale en-US)", (a, b) => a.localeCompare(b, "en-US")],
  ["localeCompare (browser locale zh-TW)", (a, b) => a.localeCompare(b, "zh-TW")],
  ["Intl.Collator zh-Hant", zh.compare],
];

describe.each(comparators)("%s", (_name, compare) => {
  it("is a total order: antisymmetric, transitive, and 0 only for equal-looking text", () => {
    fc.assert(fc.property(titleText, titleText, titleText, (a, b, c) => {
      expect(Math.sign(compare(a, b))).toBe(-Math.sign(compare(b, a)));
      expect(compare(a, a)).toBe(0);
      if (compare(a, b) <= 0 && compare(b, c) <= 0) expect(compare(a, c)).toBeLessThanOrEqual(0);
    }), fcOpts);
  });

  it("sorting twice changes nothing, and a list sorted from any starting order is in order", () => {
    fc.assert(fc.property(fc.array(titleText, { maxLength: 20 }), (titles) => {
      const once = [...titles].sort(compare);
      expect([...once].sort(compare)).toEqual(once);
      const reversed = [...titles].reverse().sort(compare);
      // Titles that compare equal may swap places; the order itself is the same.
      for (let i = 1; i < once.length; i++) {
        expect(compare(once[i - 1]!, once[i]!)).toBeLessThanOrEqual(0);
        expect(compare(reversed[i - 1]!, reversed[i]!)).toBeLessThanOrEqual(0);
      }
    }), fcOpts);
  });

  it("NFC and NFD forms of a title sort together", () => {
    fc.assert(fc.property(titleText, (title) => {
      expect(compare(title.normalize("NFC"), title.normalize("NFD"))).toBe(0);
    }), fcOpts);
  });
});

describe("current behaviour: the same Chinese titles sort differently by locale", () => {
  const titles = ["蘋果", "香蕉", "筆記", "資料結構", "演算法", "作業", "專案", "會議", "日本語", "測試"];

  it("the sidebar sorts by the browser's locale: for en-US the Han characters follow the root (radical-stroke) order", () => {
    expect([...titles].sort((a, b) => a.localeCompare(b, "en-US"))).toEqual(["作業", "專案", "日本語", "會議", "測試", "演算法", "筆記", "蘋果", "資料結構", "香蕉"]);
  });

  it("the site pages sort with zh-Hant: stroke order, not the same list", () => {
    expect([...titles].sort(zh.compare)).toEqual(["日本語", "作業", "香蕉", "專案", "測試", "筆記", "會議", "資料結構", "演算法", "蘋果"]);
  });

  it("numbers inside titles are not compared as numbers by either (第10章 before 第2章)", () => {
    expect(["第2章", "第10章", "第1章"].sort(zh.compare)).toEqual(["第10章", "第1章", "第2章"]);
    expect(["第2章", "第10章", "第1章"].sort((a, b) => a.localeCompare(b, "en-US"))).toEqual(["第10章", "第1章", "第2章"]);
  });
});
