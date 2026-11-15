// A reminder when its task is moved (taskReminder.ts reminderAfterMove; scan 10 #11, decided 2026-11-15).
// DB-free; seed and run count from PROPS_SEED / PROPS_RUNS.
//
//  M1  a reminder set to an exact moment (an instant) never moves, nor does a missing one;
//  M2  a wall-clock reminder moves by exactly the days the task's day moved, its clock time kept
//      (when the start time is not also changed);
//  M3  a wall-clock reminder at or before the start on the start's day keeps its distance to the start when the
//      start time changes (except the 9:00 morning preset, which stays at 9:00), however far it moves;
//  M4  moving a task to where it already is changes nothing;
//  M6  with a day that starts at hour H (0–6), a wall-clock reminder at the start's own moment (a quick-add reminder) follows
//      the start to any new day and time, the start of an early-morning time (before H, on the next calendar day) included;
//  M5  the result is always a well-formed reminder of the same kind.
// Reference: plain epoch-minute arithmetic, written here (not the helper's own steps).

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig.js";
import { reminderAfterMove } from "../../sharedContract.js";

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };
const pad = (n: number) => String(n).padStart(2, "0");
const dayArb = fc.integer({ min: 0, max: 800 }).map((n) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10));
const timeArb = fc.integer({ min: 0, max: 1439 }).map((m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
const epochMin = (day: string, time: string) => Date.parse(`${day}T${time}:00Z`) / 60_000;
const spell = (min: number) => new Date(min * 60_000).toISOString().slice(0, 16);
const day = (offset: number, base: string) => new Date(Date.parse(`${base}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

describe("reminderAfterMove (property)", () => {
  it("M1 an instant or no reminder stays", () => {
    fc.assert(fc.property(dayArb, timeArb, dayArb, fc.option(timeArb), fc.constantFrom("Z", "+08:00", "-05:00"), (d, t, d2, t2, zone) => {
      const instant = `${d}T${t}:00${zone}`;
      expect(reminderAfterMove(instant, { when: d, time: t }, { when: d2, time: t2 })).toBe(instant);
      expect(reminderAfterMove(null, { when: d, time: t }, { when: d2, time: t2 })).toBeNull();
    }), fcOpts);
  });

  it("M2 a wall-clock reminder moves with the day, its clock time kept", () => {
    fc.assert(fc.property(dayArb, fc.option(timeArb), timeArb, fc.integer({ min: -400, max: 400 }), fc.integer({ min: -3, max: 3 }), (when, time, clock, by, dayOffset) => {
      const remind = `${day(dayOffset, when)}T${clock}`;
      const moved = reminderAfterMove(remind, { when, time }, { when: day(by, when), time });
      expect(moved).toBe(`${day(dayOffset + by, when)}T${clock}`);
    }), fcOpts);
  });

  it("M3 a reminder before the start keeps its distance when the start time changes", () => {
    fc.assert(fc.property(dayArb, timeArb, timeArb, fc.integer({ min: 0, max: 1439 }), fc.integer({ min: -3, max: 3 }), (when, oldTime, newTime, back, days) => {
      const remindMin = Math.max(epochMin(when, "00:00"), epochMin(when, oldTime) - back);
      const remind = spell(remindMin);
      fc.pre(remind.slice(11) !== "09:00" && remind.slice(0, 10) === when);
      const newWhen = day(days, when);
      const moved = reminderAfterMove(remind, { when, time: oldTime }, { when: newWhen, time: newTime });
      expect(epochMin(newWhen, newTime) - epochMin(moved!.slice(0, 10), moved!.slice(11, 16))).toBe(epochMin(when, oldTime) - remindMin);
    }), fcOpts);
  });

  it("M4/M5 no move changes nothing, and the result is always a wall-clock reminder", () => {
    fc.assert(fc.property(dayArb, timeArb, dayArb, timeArb, dayArb, timeArb, (when, time, d2, t2, rd, rt) => {
      const remind = `${rd}T${rt}`;
      expect(reminderAfterMove(remind, { when, time }, { when, time })).toBe(remind);
      expect(reminderAfterMove(remind, { when, time }, { when: d2, time: t2 })).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    }), fcOpts);
  });

  it("M6 a reminder at the start moment follows the start whatever hour the day starts at", () => {
    const startMoment = (d: string, t: string, h: number) => (Number(t.slice(0, 2)) < h ? `${day(1, d)}T${t}` : `${d}T${t}`);
    fc.assert(fc.property(dayArb, timeArb, dayArb, timeArb, fc.integer({ min: 0, max: 6 }), (when, time, newWhen, newTime, h) => {
      fc.pre(time !== "09:00");
      const moved = reminderAfterMove(startMoment(when, time, h), { when, time }, { when: newWhen, time: newTime }, h);
      expect(moved).toBe(startMoment(newWhen, newTime, h));
    }), fcOpts);
  });

  it("named: 01:30 of a day starting at 04:00 (early the next morning) follows the start to 17:00; with no day start it would not be the start", () => {
    expect(reminderAfterMove("2026-11-17T01:30", { when: "2026-11-16", time: "01:30" }, { when: "2026-11-16", time: "17:00" }, 4)).toBe("2026-11-16T17:00");
    expect(reminderAfterMove("2026-11-17T01:30", { when: "2026-11-16", time: "01:30" }, { when: "2026-11-16", time: "17:00" })).toBe("2026-11-17T01:30");
  });

  it("named: 'that morning 9:00' goes to the new day at 9:00; '15 minutes before' follows the new time; an exact moment stays", () => {
    expect(reminderAfterMove("2026-11-16T09:00", { when: "2026-11-16", time: null }, { when: "2026-11-18", time: null })).toBe("2026-11-18T09:00");
    expect(reminderAfterMove("2026-11-16T09:00", { when: "2026-11-16", time: "15:00" }, { when: "2026-11-16", time: "17:00" })).toBe("2026-11-16T09:00");
    expect(reminderAfterMove("2026-11-16T14:45", { when: "2026-11-16", time: "15:00" }, { when: "2026-11-16", time: "17:00" })).toBe("2026-11-16T16:45");
    expect(reminderAfterMove("2026-11-16T14:45", { when: "2026-11-16", time: "15:00" }, { when: "2026-11-17", time: "09:00" })).toBe("2026-11-17T08:45");
    expect(reminderAfterMove("2026-11-16T07:00:00.000Z", { when: "2026-11-16", time: "15:00" }, { when: "2026-11-19", time: "17:00" })).toBe("2026-11-16T07:00:00.000Z");
    // Past midnight: a start moved to 00:10 the day after takes its 15-minute reminder to 23:55 of the day before it.
    expect(reminderAfterMove("2026-11-16T14:45", { when: "2026-11-16", time: "15:00" }, { when: "2026-11-16", time: "00:10" })).toBe("2026-11-15T23:55");
  });
});
