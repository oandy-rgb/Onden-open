// lib/tasks/todayCandidates: which open tasks the 今天 card offers to put on today, and in what order.
import { describe, expect, it } from "vitest";
import { CANDIDATES_SHOWN, todayCandidates, toTaskItem, type TaskItem } from "../lib/tasks";
import type { NodeTask } from "../lib/api";

const today = "2026-11-09";
const item = (id: string, extra: Record<string, unknown> = {}): TaskItem =>
  toTaskItem({ id, node_id: null, title: id, status: "todo", when_date: null, ...extra } as NodeTask, () => undefined);
const ids = (tasks: TaskItem[]) => tasks.map((task) => task.id);

describe("todayCandidates", () => {
  it("late tasks come first, the longest-waiting on top, then deadlines by date", () => {
    const list = todayCandidates([
      item("due-tomorrow", { when_date: "2026-11-12", deadline: "2026-11-10" }),
      item("late-1", { when_date: "2026-11-08" }),
      item("due-today", { deadline: today }),
      item("late-5", { when_date: "2026-11-04" }),
    ], today);
    expect(ids(list)).toEqual(["late-5", "late-1", "due-today", "due-tomorrow"]);
  });

  it("a deadline today, tomorrow or already past counts; the day after tomorrow does not", () => {
    const list = todayCandidates([
      item("past", { deadline: "2026-11-01" }), item("today", { deadline: today }), item("tomorrow", { deadline: "2026-11-10" }), item("later", { deadline: "2026-11-11" }),
    ], today);
    expect(ids(list)).toEqual(["past", "today", "tomorrow"]);
  });

  it("a task with a time on today's timeline is already scheduled; a time on another day is not", () => {
    const list = todayCandidates([
      item("on-timeline", { when_date: today, time: "10:00", deadline: today }),
      item("today-no-time", { when_date: today, deadline: today }),
      item("tomorrow-timed", { when_date: "2026-11-10", time: "10:00", deadline: "2026-11-10" }),
    ], today);
    expect(ids(list)).toEqual(["today-no-time", "tomorrow-timed"]);
  });

  it("not candidates: a task dated today with no deadline, a future day, done, cancelled, parked, no day", () => {
    const list = todayCandidates([
      item("plain-today", { when_date: today }), item("future", { when_date: "2026-11-12" }), item("done", { when_date: "2026-11-01", status: "done" }),
      item("cancelled", { when_date: "2026-11-01", status: "cancelled" }), item("parked", { someday: true }), item("anytime"),
    ], today);
    expect(list).toEqual([]);
  });

  it("a waiting task is not late (the row would not call it late either), but a near deadline still counts", () => {
    const list = todayCandidates([item("waits", { when_date: "2026-11-01", status: "waiting" }), item("waits-due", { when_date: "2026-11-01", status: "waiting", deadline: today })], today);
    expect(ids(list)).toEqual(["waits-due"]);
  });

  it("a task ticked a moment ago stays while the page keeps it", () => {
    const done = item("done", { when_date: "2026-11-01", status: "done" });
    expect(ids(todayCandidates([done], today, new Set(["done"])))).toEqual(["done"]);
  });

  it("the card lists this many rows before 「看全部」", () => {
    expect(CANDIDATES_SHOWN).toBe(3);
  });
});
