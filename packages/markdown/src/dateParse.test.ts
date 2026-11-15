import { describe, expect, it } from "vitest";
import { parseDateText } from "./dateParse.js";
import { buildMonthGrid, stepMonth, weekdayOf } from "./calendar.js";
import { dayNoteDate } from "./dayNote.js";
import { parseTaskInput } from "./taskParse.js";

// 2026-10-29 is a Thursday.
const today = "2026-10-29";
const day = (text: string, opts: { today?: string; locale?: string } = {}) => parseDateText(text, { today, locale: "zh-TW", ...opts })?.date ?? null;

describe("parseDateText", () => {
  it("reads written absolute dates without needing today", () => {
    expect(day("2026-11-03")).toBe("2026-11-03");
    expect(day("2026/11/3")).toBe("2026-11-03");
    expect(day("Oct 16, 2026")).toBe("2026-10-16");
    expect(day("10/16/2026", { today: "2031-01-01" })).toBe("2026-10-16");
  });

  it("reads Chinese words, month/day and weekdays against today", () => {
    expect(day("今天")).toBe("2026-10-29");
    expect(day("明天")).toBe("2026-10-30");
    expect(day("後天")).toBe("2026-10-31");
    expect(day("下週三")).toBe("2026-11-04");
    expect(day("週五")).toBe("2026-10-30");
    expect(day("11/3")).toBe("2026-11-03");
    expect(day("11月3日")).toBe("2026-11-03");
    expect(day("3天後")).toBe("2026-11-01");
    expect(day("下個月")).toBe("2026-11-01");
  });

  it("reads English words", () => {
    expect(day("tomorrow", { locale: "en" })).toBe("2026-10-30");
    expect(day("next friday", { locale: "en" })).toBe("2026-11-06");
    expect(day("in 2 weeks", { locale: "en" })).toBe("2026-11-12");
  });

  it("rolls a month/day that has passed into next year, and crosses month and year ends", () => {
    expect(day("1/5")).toBe("2027-01-05");
    expect(day("明天", { today: "2026-12-31" })).toBe("2027-01-01");
    expect(day("後天", { today: "2026-02-27" })).toBe("2026-03-01");
    expect(day("2/29", { today: "2027-03-01" })).toBe("2028-02-29");
  });

  it("follows the day it is handed, which is how a day start hour shifts 'tomorrow'", () => {
    // 01:30 on the 30th with a 4 o'clock day start is still the 29th: the caller passes the 29th.
    expect(day("明天", { today: "2026-10-29" })).toBe("2026-10-30");
    expect(day("明天", { today: "2026-10-30" })).toBe("2026-10-31");
  });

  it("returns the time and the repeat rule when the text has them", () => {
    expect(parseDateText("明天下午3點", { today })).toEqual({ date: "2026-10-30", time: "15:00", recur: null });
    expect(parseDateText("每週五", { today })).toEqual({ date: "2026-10-30", time: null, recur: "1w" });
  });

  it("is not a date when words are left over or nothing is named", () => {
    expect(day("明天 交報告")).toBeNull();
    expect(day("週末計畫")).toBeNull();
    expect(day("")).toBeNull();
    expect(day("   ")).toBeNull();
    expect(day("hello")).toBeNull();
    expect(day("3點")).toBeNull();
    expect(day("2026-02-30")).toBeNull();
  });

  it("agrees with the quick-add grammar on every phrase it reads (one core)", () => {
    for (const phrase of ["明天", "後天", "下週三", "週五", "11/3", "3天後", "下個月15日", "next monday", "in 3 days"]) {
      expect(day(phrase, { locale: "en" }), phrase).toBe(parseTaskInput(phrase, { today, locale: "en" }).when_date);
    }
  });
});

describe("buildMonthGrid", () => {
  it("is whole Monday-first weeks marking only the given today", () => {
    const cells = buildMonthGrid(2026, 5, "2026-06-13");
    expect(cells.length % 7).toBe(0);
    expect(weekdayOf(cells[0]!.key)).toBe(1);
    expect(cells.find((c) => c.isToday)?.day).toBe(13);
    expect(cells.filter((c) => c.inMonth)).toHaveLength(30);
  });

  it("covers February in a leap year and a month that starts on Sunday", () => {
    const feb = buildMonthGrid(2028, 1, "2028-02-29");
    expect(feb.filter((c) => c.inMonth)).toHaveLength(29);
    expect(feb.find((c) => c.isToday)?.key).toBe("2028-02-29");
    const nov = buildMonthGrid(2026, 10, today); // 1 Nov 2026 is a Sunday: six leading days
    expect(nov[0]!.key).toBe("2026-10-26");
    expect(nov.at(-1)!.key).toBe("2026-12-06");
  });

  it("has no today when today is outside the grid, whatever the device clock says", () => {
    expect(buildMonthGrid(2026, 0, "2030-01-01").some((c) => c.isToday)).toBe(false);
  });
});

describe("stepMonth", () => {
  it("rolls over year ends in both directions", () => {
    expect(stepMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(stepMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
    expect(stepMonth(2026, 5, 0)).toEqual({ year: 2026, month: 5 });
    expect(stepMonth(2026, 5, -17)).toEqual({ year: 2025, month: 0 });
  });
});

describe("dayNoteDate", () => {
  it("is the day a visible note's title or slug names", () => {
    expect(dayNoteDate({ title: "2026-10-29" })).toBe("2026-10-29");
    expect(dayNoteDate({ title: "Ideas", slug: "2026-10-29" })).toBe("2026-10-29");
    expect(dayNoteDate({ title: "2026-10-29", hidden: true })).toBeNull();
    expect(dayNoteDate({ title: "2026-02-30" })).toBeNull();
    expect(dayNoteDate({ title: "Ideas" })).toBeNull();
    expect(dayNoteDate(null)).toBeNull();
  });
});
