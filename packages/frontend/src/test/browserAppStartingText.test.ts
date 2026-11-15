import { describe, expect, it } from "vitest";
import { startingText } from "../browserApp/startingText";

describe("the opening screen's words", () => {
  it("says it is opening when there is nothing to restore", () => {
    expect(startingText(null, "zh-TW")).toBe("正在開啟 Onden 試用版…");
    expect(startingText({ done: 0, total: 0 }, "en-US")).toBe("Opening Onden…");
  });
  it("says what it is doing and how far when it restores changes that were not saved in a copy", () => {
    expect(startingText({ done: 12, total: 85 }, "zh-TW")).toBe("正在恢復上次關閉前還沒存好的修改（12 / 85）…");
    expect(startingText({ done: 12, total: 85 }, "en")).toBe("Restoring changes you made before the last close (12 of 85)…");
  });
});
