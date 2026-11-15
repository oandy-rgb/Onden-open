// foldEmptyHours / foldLayout: which empty stretches of a day fold into one line, and where a minute is after that.
import { describe, expect, it } from "vitest";
import { foldEmptyHours, foldLayout, type BlockSpan } from "../modules/daily/day/foldEmptyHours";

const block = (from: string, to: string): BlockSpan => {
  const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
  return { startMinutes: minutes(from), endMinutes: minutes(to) };
};
const at = (nowHour: number | null, open?: ReadonlySet<number>) => ({ hours: 24, nowHour, open });

describe("foldEmptyHours", () => {
  it("an empty day is one fold, except around now", () => {
    expect(foldEmptyHours([], at(null))).toEqual([{ fromHour: 0, toHour: 24 }]);
    expect(foldEmptyHours([], at(12))).toEqual([{ fromHour: 0, toHour: 11 }, { fromHour: 21, toHour: 24 }]);
  });

  it("the morning before the first block folds; hours with a block do not", () => {
    expect(foldEmptyHours([block("07:30", "09:00")], at(null))).toEqual([{ fromHour: 0, toHour: 7 }, { fromHour: 9, toHour: 24 }]);
  });

  it("one empty hour does not fold, two do", () => {
    const blocks = [block("09:00", "10:00"), block("11:30", "12:00"), block("14:00", "15:00")];
    // 10:00–11:00 is one empty hour (kept); 12:00–14:00 is two.
    expect(foldEmptyHours(blocks, { hours: 16, nowHour: null }).filter((f) => f.fromHour >= 9)).toEqual([{ fromHour: 12, toHour: 14 }]);
  });

  it("now keeps its hour, the one before and the eight coming up open, even in the middle of a long gap", () => {
    expect(foldEmptyHours([block("08:00", "09:00"), block("20:00", "21:00")], at(14)))
      .toEqual([{ fromHour: 0, toHour: 8 }, { fromHour: 9, toHour: 13 }]);
    // Late in the day what is coming up runs to the end of it; the morning still folds.
    expect(foldEmptyHours([], at(20))).toEqual([{ fromHour: 0, toHour: 19 }]);
  });

  it("a block that crosses an hour keeps both hours; a zero-length one keeps its own", () => {
    expect(foldEmptyHours([block("10:45", "11:15")], at(null)).map((f) => f.toHour)).toEqual([10, 24]);
    expect(foldEmptyHours([{ startMinutes: 600, endMinutes: 600 }], at(null)).map((f) => f.toHour)).toEqual([10, 24]);
  });

  it("opened hours stay open", () => {
    expect(foldEmptyHours([], at(null, new Set([3, 4])))).toEqual([{ fromHour: 0, toHour: 3 }, { fromHour: 5, toHour: 24 }]);
  });

  it("a daylight-saving day has 23 or 25 hours", () => {
    expect(foldEmptyHours([], { hours: 25, nowHour: null })).toEqual([{ fromHour: 0, toHour: 25 }]);
  });
});

describe("foldLayout", () => {
  const layout = foldLayout([{ fromHour: 2, toHour: 6 }], 8 * 60, 60, 30);
  it("an open stretch keeps its scale; a fold is one row", () => {
    expect(layout.y(0)).toBe(0);
    expect(layout.y(120)).toBe(120); // the fold starts here
    expect(layout.y(360)).toBe(150); // 120 + 30
    expect(layout.y(480)).toBe(270);
    expect(layout.height).toBe(270);
  });
  it("inside a fold, minutes are spread evenly over its row", () => {
    expect(layout.y(240)).toBe(135);
  });
  it("minutesAt is the inverse", () => {
    for (const minutes of [0, 90, 120, 240, 360, 400, 480]) expect(layout.minutesAt(layout.y(minutes))).toBeCloseTo(minutes, 6);
  });
  it("no folds is the plain scale", () => {
    const plain = foldLayout([], 24 * 60, 56, 36);
    expect(plain.y(60)).toBe(56);
    expect(plain.minutesAt(28)).toBe(30);
    expect(plain.height).toBe(24 * 56);
  });
});
