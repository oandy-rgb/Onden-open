import { describe, expect, it } from "vitest";
import { formatLineTime, isClockTime, parseLineTime, withLineTime } from "./taskTime.js";
import { parseTaskInput } from "./taskParse.js";

describe("parseLineTime", () => {
  it("reads a start and an end, with any of the dashes", () => {
    expect(parseLineTime("15:00–16:00 跟組員討論")).toEqual({ time: "15:00", until: "16:00", rest: "跟組員討論" });
    expect(parseLineTime("15:00-16:00 跟組員討論")).toEqual({ time: "15:00", until: "16:00", rest: "跟組員討論" });
    expect(parseLineTime("9:05 — 10:00 讀書")).toEqual({ time: "09:05", until: "10:00", rest: "讀書" });
  });
  it("reads a start alone", () => {
    expect(parseLineTime("15:00 交報告")).toEqual({ time: "15:00", until: null, rest: "交報告" });
    expect(parseLineTime("15:00")).toEqual({ time: "15:00", until: null, rest: "" });
  });
  it("is not fooled by a time later in the text, a longer number, or a bad clock", () => {
    expect(parseLineTime("交報告 15:00").time).toBeNull();
    expect(parseLineTime("15:000 x").time).toBeNull();
    expect(parseLineTime("25:00 x").time).toBeNull();
    expect(parseLineTime("15:00x").time).toBeNull();
    expect(parseLineTime("沒有時間").rest).toBe("沒有時間");
  });
  it("keeps an end that is not later than the start in the text", () => {
    expect(parseLineTime("15:00–14:00 x")).toEqual({ time: "15:00", until: null, rest: "–14:00 x" });
    expect(parseLineTime("15:00–15:00 x").until).toBeNull();
  });
});

describe("withLineTime / formatLineTime", () => {
  it("writes, replaces and removes the leading time", () => {
    expect(formatLineTime("15:00", "16:00")).toBe("15:00–16:00");
    expect(withLineTime("交報告", "09:30", null)).toBe("09:30 交報告");
    expect(withLineTime("15:00–16:00 交報告", "10:00", "11:00")).toBe("10:00–11:00 交報告");
    expect(withLineTime("15:00 交報告", null, null)).toBe("交報告");
    expect(withLineTime("", "09:30", null)).toBe("09:30");
  });
  it("round-trips", () => {
    const text = withLineTime("討論", "08:00", "09:15");
    expect(parseLineTime(text)).toEqual({ time: "08:00", until: "09:15", rest: "討論" });
  });
});

describe("isClockTime", () => {
  it("takes zero-padded 24-hour times only", () => {
    expect(isClockTime("09:30")).toBe(true);
    expect(isClockTime("9:30")).toBe(false);
    expect(isClockTime("24:00")).toBe(false);
  });
});

describe("quick-add reads the same clock", () => {
  it("finds the time the line would carry", () => {
    expect(parseTaskInput("15:00 交報告", { today: "2026-10-30" }).time).toBe("15:00");
  });
});
