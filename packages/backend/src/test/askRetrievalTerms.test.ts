import { describe, it, expect } from "vitest";
import { retrievalTerms } from "../services/harness/index.js";

describe("Ask lexical retrieval terms", () => {
  it("keeps long words and splits CJK runs into 2-character windows", () => {
    expect(retrievalTerms("deep module 深模組 是什麼")).toEqual(["module", "深模", "模組", "是什", "什麼"]);
  });

  it("caps the list at 10 and drops duplicates", () => {
    expect(retrievalTerms("筆記筆記筆記筆記筆記筆記筆記").length).toBeLessThanOrEqual(10);
    expect(new Set(retrievalTerms("筆記筆記")).size).toBe(retrievalTerms("筆記筆記").length);
  });
});
