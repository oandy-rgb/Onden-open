import { describe, expect, it } from "vitest";
import { REMIND_CATCH_UP_MS, dueReminderMoment, reminderAgoMs, reminderKey, reminderMoment } from "../taskReminder.js";

const at = (wall: string, ms = Date.parse("2026-10-30T12:00:00Z")) => ({ wall, ms });

describe("reminderMoment", () => {
  it("prefers the reminder, else the start time on its day", () => {
    expect(reminderMoment({ remind_at: "2026-10-30T09:30", time: "15:00", due_date: "2026-10-30" })).toEqual({ text: "2026-10-30T09:30", instant: false });
    expect(reminderMoment({ time: "15:00", due_date: "2026-10-30" })).toEqual({ text: "2026-10-30T15:00", instant: false });
    expect(reminderMoment({ time: "15:00", due_date: null })).toBeNull();
    expect(reminderMoment({})).toBeNull();
  });
  it("tells an instant (Z or offset) from a wall-clock moment", () => {
    expect(reminderMoment({ remind_at: "2026-10-30T01:30:00.000Z" })?.instant).toBe(true);
    expect(reminderMoment({ remind_at: "2026-10-30T09:30:00+08:00" })?.instant).toBe(true);
    expect(reminderMoment({ remind_at: "2026-10-30T09:30:00" })?.instant).toBe(false);
  });
});

describe("dueReminderMoment", () => {
  const task = { time: "09:00", due_date: "2026-10-30", status: "todo" };
  it("is not due before the minute, is due on it", () => {
    expect(dueReminderMoment(task, at("2026-10-30T08:59"))).toBeNull();
    expect(dueReminderMoment(task, at("2026-10-30T09:00"))?.text).toBe("2026-10-30T09:00");
  });
  it("catches up for twelve hours, not longer (wall clock of the workspace zone)", () => {
    expect(dueReminderMoment(task, at("2026-10-30T21:00"))).not.toBeNull();
    expect(dueReminderMoment(task, at("2026-10-30T21:01"))).toBeNull();
    expect(REMIND_CATCH_UP_MS).toBe(12 * 3_600_000);
  });
  it("crosses midnight on the wall clock", () => {
    expect(dueReminderMoment({ ...task, time: "23:30" }, at("2026-10-31T11:00"))).not.toBeNull();
    expect(dueReminderMoment({ ...task, time: "23:30" }, at("2026-10-31T11:31"))).toBeNull();
  });
  it("judges an instant by time, whatever the wall clock says", () => {
    const t = { remind_at: "2026-10-30T01:00:00Z" };
    expect(dueReminderMoment(t, { wall: "1999-01-01T00:00", ms: Date.parse("2026-10-30T01:00:00Z") })).not.toBeNull();
    expect(dueReminderMoment(t, { wall: "1999-01-01T00:00", ms: Date.parse("2026-10-30T00:59:00Z") })).toBeNull();
    expect(dueReminderMoment(t, { wall: "1999-01-01T00:00", ms: Date.parse("2026-10-30T13:01:00Z") })).toBeNull();
  });
  it("accepts a space between day and time in the wall clock", () => {
    expect(dueReminderMoment(task, at("2026-10-30 09:05"))).not.toBeNull();
  });
  it("skips done, cancelled and waiting tasks; a missing status is judged by the moment alone", () => {
    for (const status of ["done", "cancelled", "waiting"]) expect(dueReminderMoment({ ...task, status }, at("2026-10-30T09:05"))).toBeNull();
    expect(dueReminderMoment({ time: "09:00", due_date: "2026-10-30" }, at("2026-10-30T09:05"))).not.toBeNull();
  });
  it("is never due for a malformed moment", () => {
    expect(Number.isNaN(reminderAgoMs({ text: "garbage", instant: true }, at("2026-10-30T09:00")))).toBe(true);
    expect(dueReminderMoment({ remind_at: "garbageZ" }, at("2026-10-30T09:00"))).toBeNull();
  });
});

it("reminderKey names the task and the moment", () => {
  expect(reminderKey("t1", { text: "2026-10-30T09:00", instant: false })).toBe("remind:t1:2026-10-30T09:00");
});

describe("reminderMoment with the hour the day starts at (scan 10 #6)", () => {
  it("a time before the start hour is on the next calendar day", () => {
    expect(reminderMoment({ due_date: "2026-11-14", time: "01:30" }, 4)?.text).toBe("2026-11-15T01:30");
    expect(reminderMoment({ due_date: "2026-11-14", time: "04:00" }, 4)?.text).toBe("2026-11-14T04:00");
    expect(reminderMoment({ due_date: "2026-11-14", time: "01:30" })?.text).toBe("2026-11-14T01:30");
  });
  it("dueReminderMoment is not due the evening before", () => {
    const now = { ms: 0, wall: "2026-11-14T05:00", dayStartHour: 4 };
    expect(dueReminderMoment({ due_date: "2026-11-14", time: "01:30", status: "todo" }, now)).toBeNull();
    expect(dueReminderMoment({ due_date: "2026-11-14", time: "01:30", status: "todo" }, { ...now, wall: "2026-11-15T01:31" })).not.toBeNull();
  });
});
