import { beforeEach, describe, expect, it } from "vitest";
import { setLocalePref } from "../lib/i18n";
import { rollupDescription } from "../components/attributes/utils";

describe("rollupDescription (scan 06 S11)", () => {
  beforeEach(() => setLocalePref("zh-TW"));

  it("is written in the interface language, from the parts the server sends", () => {
    expect(rollupDescription({ op: "count", tag: "task", attr: null })).toBe("下層帶有 #task 的項目數");
    expect(rollupDescription({ op: "sum", tag: null, attr: "hours" })).toBe("下層項目的hours總和");
    expect(rollupDescription({ op: "count", tag: null, attr: null })).not.toMatch(/[a-z]{4,}/);
  });
});
