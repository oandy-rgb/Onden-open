// The 今天 page's three lists and the time-spent table: pure rules (modules/daily/today).

import { describe, expect, it } from "vitest";
import type { FocusSession } from "@onden/contract";
import { toTaskItem, type TaskItem, type TaskRow } from "../lib/tasks";
import { focusTotals } from "../modules/daily/today/focusTotals";
import { timeSpentLines } from "../modules/daily/today/TimeSpent";
import { plannedMinutes, todayLists } from "../modules/daily/today/todayLists";

const TODAY = "2026-11-13";
const row = (id: string, extra: Partial<TaskRow> = {}): TaskRow => ({ id, node_id: null, title: id, status: "todo", when_date: null, ...extra }) as TaskRow;
const item = (id: string, extra: Partial<TaskRow> = {}): TaskItem => toTaskItem(row(id, extra), () => undefined);
const ids = (tasks: readonly TaskItem[]) => tasks.map((task) => task.id);

describe("todayLists: today", () => {
  const all = [
    item("late-old", { when_date: "2026-11-10" }),
    item("late", { when_date: "2026-11-12" }),
    item("noon", { when_date: TODAY, time: "12:00" }),
    item("plain", { when_date: TODAY }),
    item("early", { when_date: TODAY, time: "08:00" }),
    item("finished", { when_date: TODAY, status: "done" }),
    item("soon", { when_date: "2026-11-20", deadline: "2026-11-14" }),
    item("anytime"),
    item("parked", { someday: true }),
    item("tomorrow", { when_date: "2026-11-14" }),
    item("cancelled", { when_date: TODAY, status: "cancelled" }),
  ];

  it("「還沒做完」 is what was planned for an earlier day, the longest-waiting first, and is not moved by itself", () => {
    expect(ids(todayLists(all, TODAY, TODAY).leftOver)).toEqual(["late-old", "late"]);
  });

  it("「今天要做的」 is the day's own tasks: open ones by their time, then the done ones; nothing cancelled", () => {
    expect(ids(todayLists(all, TODAY, TODAY).planned)).toEqual(["early", "noon", "plain", "finished"]);
  });

  it("「還沒排的」 is the candidates that are not late (a near deadline), then what has no day; a parked task is not offered", () => {
    expect(ids(todayLists(all, TODAY, TODAY).unplanned)).toEqual(["soon", "anytime"]);
  });

  it("a task ticked a moment ago stays in its list, struck through, until the page moves on", () => {
    const lists = todayLists([item("plain", { when_date: TODAY, status: "done" })], TODAY, TODAY, new Set(["plain"]));
    expect(ids(lists.planned)).toEqual(["plain"]);
  });
});

describe("todayLists: other days", () => {
  const all = [
    item("did", { when_date: "2026-11-11", status: "done" }),
    item("did-not", { when_date: "2026-11-11" }),
    item("other", { when_date: "2026-11-12" }),
    item("next", { when_date: "2026-11-15", time: "09:00" }),
    item("anytime"),
  ];

  it("a past day lists what it had planned, done and left undone, and counts what is still open now", () => {
    const lists = todayLists(all, "2026-11-11", TODAY);
    expect(ids(lists.planned)).toEqual(["did-not", "did"]);
    expect(lists.stillOpen).toBe(1);
    expect(lists.leftOver).toEqual([]);
    expect(lists.unplanned).toEqual([]);
  });

  it("a later day lists what is planned for it, with nothing to catch up on", () => {
    const lists = todayLists(all, "2026-11-15", TODAY);
    expect(ids(lists.planned)).toEqual(["next"]);
    expect(lists.stillOpen).toBe(0);
    expect(lists.leftOver).toEqual([]);
  });
});

describe("plannedMinutes", () => {
  it("is the length between a start and an end, and null without both", () => {
    expect(plannedMinutes({ time: "09:00", until: "10:30" })).toBe(90);
    expect(plannedMinutes({ time: "09:00", until: null })).toBeNull();
    expect(plannedMinutes({ time: null, until: null })).toBeNull();
    expect(plannedMinutes({ time: "10:00", until: "09:00" })).toBeNull();
  });
});

describe("focusTotals and the time-spent lines", () => {
  const at = (hh: number, mm: number) => new Date(2026, 10, 12, hh, mm).toISOString();
  const session = (id: string, task: string | null, from: string, to: string | null): FocusSession => ({ id, task_id: task, started_at: from, ended_at: to, note: "" }) as FocusSession;

  it("adds the minutes of the day's records per task and in all; the running one counts up to now", () => {
    const sessions = [session("a", "write", at(9, 0), at(9, 25)), session("b", "write", at(10, 0), at(10, 20)), session("c", null, at(11, 0), at(11, 10))];
    const running = session("d", "read", at(14, 0), null);
    const totals = focusTotals("2026-11-12", sessions, running, new Date(2026, 10, 12, 14, 12).getTime());
    expect(Object.fromEntries(totals.byTask)).toEqual({ write: 45, read: 12 });
    expect(totals.total).toBe(45 + 10 + 12);
  });

  it("lists a thing planned with a start and end beside what was focused, biggest focus first; spent past the plan is visible", () => {
    const tasks = [item("write", { when_date: "2026-11-12", time: "09:00", until: "09:30" }), item("idle", { when_date: "2026-11-12" }), item("call", { when_date: "2026-11-12", time: "13:00", until: "14:00" })];
    const totals = { byTask: new Map([["write", 45], ["other", 5]]), total: 50 };
    const lines = timeSpentLines(tasks, (id) => (id === "other" ? "Other thing" : undefined), totals);
    expect(lines.map((line) => [line.id, line.planned, line.focused])).toEqual([["write", 30, 45], ["other", null, 5], ["call", 60, 0]]);
    expect(lines.find((line) => line.id === "other")?.title).toBe("Other thing");
  });
});
