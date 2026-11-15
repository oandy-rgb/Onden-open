// Quick add / quick capture read typed words ("今天", "明天 3點 提醒我") against the WORKSPACE's clock:
// its zone and the hour its day starts at, never the device's wall calendar (scan 10 #5, #7).
//
// Invariants, for a random instant, zone and day-start hour:
//  Q1  `dayAndClock().today` is the workspace's today (todayId), also between midnight and the start hour;
//      so "今天" files under today and "明天" under today + 1 whatever the wall calendar says.
//  Q2  a task typed with a time and "提醒我" gets a wall-clock reminder (YYYY-MM-DDTHH:MM, the workspace's zone,
//      like every other reminder) at that time on the workspace day: the next calendar day when the time is
//      before the start hour (01:30 of a day that starts at 04:00 is early the NEXT morning). No device zone.
//  Q3  moving that task later (its day and time) moves the reminder with it: it stays at the start (decided 2026-11-15);
//      an old row saved as an exact instant does not move.
//
// Replay a failure:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/quickAddClock

import { afterAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseTaskInput } from "@onden/markdown/task-parse";
import { addDays, dayAndClock, setWorkspaceDayStartSource, setWorkspaceTimeZoneSource, todayId } from "../../lib/localDate";
import { rowChanges } from "../../lib/data/taskWriter";
import { quickTaskFromReading } from "../../modules/tasks/quickAddTask";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

const ZONES = ["UTC", "Asia/Taipei", "America/New_York", "Europe/Berlin", "Pacific/Auckland", "Pacific/Kiritimati", "Pacific/Pago_Pago"];
let zone = "UTC";
let dayStart = 0;
setWorkspaceTimeZoneSource(() => zone);
setWorkspaceDayStartSource(() => dayStart);
afterAll(() => { setWorkspaceTimeZoneSource(() => undefined); setWorkspaceDayStartSource(() => 0); });

const world = fc.record({
  at: fc.integer({ min: Date.UTC(2026, 0, 5), max: Date.UTC(2026, 11, 20) }),
  zone: fc.constantFrom(...ZONES),
  dayStart: fc.integer({ min: 0, max: 6 }),
});
const TIMES = ["00:30", "01:30", "03:59", "04:00", "09:00", "15:00", "23:30"];

function setWorld(w: { zone: string; dayStart: number }) { zone = w.zone; dayStart = w.dayStart; }

describe("quick add reads the workspace's clock (random)", () => {
  it("Q1: today is the workspace's day; 今天 and 明天 land on today and today + 1", () => {
    fc.assert(fc.property(world, (w) => {
      setWorld(w);
      const now = new Date(w.at);
      const { today } = dayAndClock(now);
      expect(today).toBe(todayId(now));
      expect(parseTaskInput("今天 交報告", { ...dayAndClock(now), locale: "zh-TW" }).when_date).toBe(today);
      expect(parseTaskInput("明天 交報告", { ...dayAndClock(now), locale: "zh-TW" }).when_date).toBe(addDays(today, 1));
    }), { numRuns: PROPS_RUNS, seed: PROPS_SEED });
  });

  it("Q1 named case: 01:30 on a day that starts at 04:00 is still yesterday", () => {
    setWorld({ zone: "UTC", dayStart: 4 });
    const now = new Date(Date.UTC(2026, 10, 15, 1, 30));
    expect(dayAndClock(now).today).toBe("2026-11-14");
    expect(parseTaskInput("今天 交報告", { ...dayAndClock(now), locale: "zh-TW" }).when_date).toBe("2026-11-14");
    expect(parseTaskInput("明天 交報告", { ...dayAndClock(now), locale: "zh-TW" }).when_date).toBe("2026-11-15");
  });

  it("Q2: the reminder is the typed time on the workspace day, as wall-clock text in whatever zone", () => {
    fc.assert(fc.property(world, fc.constantFrom(...TIMES), fc.integer({ min: 1, max: 20 }), (w, time, ahead) => {
      setWorld(w);
      const now = new Date(w.at);
      const { today, nowTime } = dayAndClock(now);
      const date = addDays(today, ahead);
      const parsed = parseTaskInput(`${date} ${time} 開會 提醒我`, { today, nowTime, locale: "zh-TW" });
      if (parsed.when_date !== date || parsed.time !== time || !parsed.remind) return; // not read as a dated time: nothing to judge
      const hour = Number(time.slice(0, 2));
      const calendarDay = hour < w.dayStart ? addDays(date, 1) : date;
      expect(quickTaskFromReading(parsed).remind_at).toBe(`${calendarDay}T${time}`);
    }), { numRuns: PROPS_RUNS, seed: PROPS_SEED });
  });

  it("Q3: a quick-add reminder keeps its distance to the start when the task is moved later (rowChanges, the writer's rule)", () => {
    fc.assert(fc.property(world, fc.constantFrom(...TIMES), fc.constantFrom(...TIMES), fc.integer({ min: 1, max: 20 }), fc.integer({ min: -3, max: 3 }), (w, time, newTime, ahead, days) => {
      setWorld(w);
      const { today, nowTime } = dayAndClock(new Date(w.at));
      const date = addDays(today, ahead);
      const parsed = parseTaskInput(`${date} ${time} 開會 提醒我`, { today, nowTime, locale: "zh-TW" });
      if (parsed.when_date !== date || parsed.time !== time || !parsed.remind) return;
      if (time === "09:00") return; // 09:00 is the "that morning, 9:00" preset: it names a clock time and stays (named case below)
      const remind_at = quickTaskFromReading(parsed).remind_at;
      const newDate = addDays(date, days);
      const next = rowChanges({ when_date: newDate, time: newTime }, { when_date: date, due_date: date, time, remind_at }).remind_at ?? remind_at; // undefined: unchanged
      // the reminder was at the start, so it is at the start of the moved task
      const hour = Number(newTime.slice(0, 2));
      expect(next).toBe(`${hour < w.dayStart ? addDays(newDate, 1) : newDate}T${newTime}`);
    }), { numRuns: PROPS_RUNS, seed: PROPS_SEED });
  });

  it("Q2 named case: 9am in Taipei is the text 09:00 of that day, whatever the device zone", () => {
    setWorld({ zone: "Asia/Taipei", dayStart: 0 });
    const parsed = parseTaskInput("2026-11-20 09:00 開會 提醒我", { today: "2026-11-14", nowTime: "10:00", locale: "zh-TW" });
    expect(quickTaskFromReading(parsed).remind_at).toBe("2026-11-20T09:00");
  });

  it("Q2 named case: 01:30 of a day that starts at 04:00 is early the next morning", () => {
    setWorld({ zone: "Asia/Taipei", dayStart: 4 });
    const parsed = parseTaskInput("2026-11-20 01:30 開會 提醒我", { today: "2026-11-14", nowTime: "10:00", locale: "zh-TW" });
    expect(quickTaskFromReading(parsed).remind_at).toBe("2026-11-21T01:30");
  });

  it("Q3 named case: 「明天3點開會 提醒我」, then dragged to 17:00 → the reminder is at 17:00", () => {
    setWorld({ zone: "Asia/Taipei", dayStart: 0 });
    const parsed = parseTaskInput("明天3點開會 提醒我", { today: "2026-11-15", nowTime: "10:00", locale: "zh-TW" });
    const fields = quickTaskFromReading(parsed);
    expect(fields.remind_at).toBe("2026-11-16T15:00"); // 3點 reads as 15:00
    expect(rowChanges({ time: "17:00" }, { when_date: "2026-11-16", due_date: "2026-11-16", time: "15:00", remind_at: fields.remind_at }).remind_at).toBe("2026-11-16T17:00");
  });

  it("Q3 named case: a row saved as an exact instant before this change does not move", () => {
    setWorld({ zone: "Asia/Taipei", dayStart: 0 });
    const old = "2026-11-15T19:00:00.000Z";
    expect(rowChanges({ time: "17:00" }, { when_date: "2026-11-16", due_date: "2026-11-16", time: "15:00", remind_at: old }).remind_at).toBeUndefined();
  });

  it("Q3 named case: 01:30 of a day starting at 04:00 (early the next morning) follows the start to 17:00", () => {
    setWorld({ zone: "UTC", dayStart: 4 });
    expect(rowChanges({ time: "17:00" }, { when_date: "2026-11-16", due_date: "2026-11-16", time: "01:30", remind_at: "2026-11-17T01:30" }).remind_at).toBe("2026-11-16T17:00");
  });

  it("Q3 named case: a reminder at 09:00 is the morning preset and stays at 09:00 when the start moves", () => {
    setWorld({ zone: "UTC", dayStart: 0 });
    expect(rowChanges({ time: "17:00" }, { when_date: "2026-11-16", due_date: "2026-11-16", time: "09:00", remind_at: "2026-11-16T09:00" }).remind_at).toBeUndefined();
  });
});
