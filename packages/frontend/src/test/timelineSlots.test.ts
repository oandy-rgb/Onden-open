// Where a tap, a drop or a drawn stretch lands on the day, and the press that draws it.

import { afterEach, describe, expect, it } from "vitest";
import { dayWindow } from "../lib/dayWindow";
import { setWorkspaceTimeZoneSource } from "../lib/localDate";
import { DEFAULT_SLOT_MINUTES, slotAt, slotDrawn } from "../modules/daily/day/timelineSlots";
import { HOLD_SLOP as SLOP_PX } from "../lib/touchHold";
import { pressStep, type PressState } from "../modules/daily/day/longPressDraw";

afterEach(() => setWorkspaceTimeZoneSource(() => undefined));

describe("position to time", () => {
  const zone = (name: string) => setWorkspaceTimeZoneSource(() => name);

  it("a tap starts on the nearest 15 minutes and lasts 30", () => {
    zone("Asia/Taipei");
    const day = dayWindow("2026-10-30", "Asia/Taipei", 0);
    expect(slotAt(day, 14 * 60 + 6)).toMatchObject({ time: "14:00", until: "14:30" });
    expect(slotAt(day, 14 * 60 + 8)).toMatchObject({ time: "14:15", until: "14:45" });
    expect(DEFAULT_SLOT_MINUTES).toBe(30);
  });

  it("reads the clock from the day's own start: a day starting at 04:00", () => {
    zone("Asia/Taipei");
    const day = dayWindow("2026-10-30", "Asia/Taipei", 4);
    expect(slotAt(day, 0)).toMatchObject({ time: "04:00", until: "04:30" });
    expect(slotAt(day, 22 * 60)).toMatchObject({ time: "02:00", until: "02:30" }); // 02:00 of the next calendar day
  });

  it("stays inside the day: the last slot ends where the day does", () => {
    zone("Asia/Taipei");
    const day = dayWindow("2026-10-30", "Asia/Taipei", 0);
    expect(slotAt(day, -50)).toMatchObject({ time: "00:00" });
    // the day ends at midnight: 23:45 has no end time, a line's times cannot say 24:00
    expect(slotAt(day, 24 * 60)).toMatchObject({ time: "23:45", until: null });
    expect(slotAt(day, 23 * 60 + 20)).toMatchObject({ time: "23:15", until: "23:45" });
  });

  it("drops an end that would wrap past midnight on a late-starting day", () => {
    zone("Asia/Taipei");
    const day = dayWindow("2026-10-30", "Asia/Taipei", 4);
    // 23:45 → 00:15 next calendar day: "00:15" is not later than "23:45" on the clock
    expect(slotAt(day, 19 * 60 + 45)).toMatchObject({ time: "23:45", until: null });
  });

  it("follows the wall clock over a daylight-saving change (25-hour day)", () => {
    zone("America/New_York");
    const day = dayWindow("2026-11-01", "America/New_York", 0);
    // 02:00 EDT → 01:00 EST: 3 hours after 00:00 the wall clock reads 02:00
    expect(slotAt(day, 3 * 60)).toMatchObject({ time: "02:00" });
    expect(slotAt(day, 2 * 60)).toMatchObject({ time: "01:00" });
  });

  it("a drawn stretch is the grid cells it covers, either way round; barely drawn is a tap", () => {
    zone("Asia/Taipei");
    const day = dayWindow("2026-10-30", "Asia/Taipei", 0);
    expect(slotDrawn(day, 9 * 60 + 2, 10 * 60 + 20)).toMatchObject({ time: "09:00", until: "10:30" });
    expect(slotDrawn(day, 10 * 60 + 20, 9 * 60 + 2)).toMatchObject({ time: "09:00", until: "10:30" });
    expect(slotDrawn(day, 9 * 60, 9 * 60 + 5)).toMatchObject({ time: "09:00", until: "09:30" });
  });
});

describe("the press that draws a slot", () => {
  const run = (events: Parameters<typeof pressStep>[1][]) => events.reduce<{ state: PressState; done?: { startY: number; endY: number } }>(
    (acc, event) => pressStep(acc.state, event), { state: { phase: "idle" } });

  it("a short press is a tap, not a drawing", () => {
    expect(run([{ type: "down", y: 100 }, { type: "up" }])).toEqual({ state: { phase: "idle" } });
  });

  it("moving before the hold is up is a scroll: the hold that follows draws nothing", () => {
    const scrolled = run([{ type: "down", y: 100 }, { type: "move", y: 100 + SLOP_PX + 1 }, { type: "hold" }, { type: "up" }]);
    expect(scrolled).toEqual({ state: { phase: "idle" } });
    expect(run([{ type: "down", y: 100 }, { type: "move", y: 100 + SLOP_PX }, { type: "hold" }]).state.phase).toBe("drawing");
  });

  it("a long press then a drag draws from where it went down to where it is lifted", () => {
    const result = run([{ type: "down", y: 100 }, { type: "hold" }, { type: "move", y: 140 }, { type: "move", y: 180 }, { type: "up" }]);
    expect(result).toEqual({ state: { phase: "idle" }, done: { startY: 100, endY: 180 } });
  });

  it("a cancelled press (the browser took it for a scroll) draws nothing", () => {
    expect(run([{ type: "down", y: 100 }, { type: "hold" }, { type: "cancel" }])).toEqual({ state: { phase: "idle" } });
  });
});
