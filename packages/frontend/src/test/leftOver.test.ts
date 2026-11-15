// lib/tasks/leftOver: the words for which day left a task, and the two writes.
import { describe, expect, it } from "vitest";
import { dropChanges, leftOverAge, planTodayChanges, toTaskItem, type TaskItem } from "../lib/tasks";
import { dateIdAt } from "../lib/localDate";
import type { NodeTask } from "../lib/api";

const row = (id: string, when: string | null, extra: Partial<NodeTask> = {}): NodeTask => ({ id, node_id: null, title: id, status: "todo", when_date: when, due_date: when, ...extra });
const item = (id: string, when: string | null, extra: Partial<NodeTask> = {}): TaskItem => toTaskItem(row(id, when, extra), () => undefined);

describe("leftOverAge", () => {
  const today = "2026-11-06"; // a Friday
  it("yesterday, then the weekday for 2–6 days, then the count", () => {
    expect(leftOverAge("2026-11-05", today)).toEqual({ kind: "yesterday" });
    expect(leftOverAge("2026-11-04", today)).toEqual({ kind: "weekday", weekday: 3 });
    expect(leftOverAge("2026-10-31", today)).toEqual({ kind: "weekday", weekday: 6 });
    expect(leftOverAge("2026-10-30", today)).toEqual({ kind: "daysAgo", n: 7 });
    expect(leftOverAge("2026-09-01", today)).toEqual({ kind: "daysAgo", n: 66 });
  });
  it("with the day starting at 4:00, the small hours still belong to the day before", () => {
    const before = dateIdAt(new Date("2026-11-06T02:00:00Z"), "UTC", 4);
    expect(before).toBe("2026-11-05");
    expect(leftOverAge("2026-11-04", before)).toEqual({ kind: "yesterday" });
    expect(leftOverAge("2026-11-03", before)).toEqual({ kind: "weekday", weekday: 2 });
    const after = dateIdAt(new Date("2026-11-06T05:00:00Z"), "UTC", 4);
    expect(after).toBe("2026-11-06");
    expect(leftOverAge("2026-11-04", after)).toEqual({ kind: "weekday", weekday: 3 });
  });
});

describe("planTodayChanges", () => {
  it("sets the day to today and clears the flags; undo gives the old day and flags back", () => {
    expect(planTodayChanges(item("a", "2026-11-04", { evening: true }), "2026-11-06")).toEqual({
      id: "a",
      changes: { when_date: "2026-11-06", evening: false, someday: false },
      undo: { when_date: "2026-11-04", evening: true, someday: false },
    });
  });
  it("a parked task gets today and goes back to parked on undo", () => {
    const parked = planTodayChanges(item("s", null, { someday: true }), "2026-11-06");
    expect(parked.changes).toEqual({ when_date: "2026-11-06", evening: false, someday: false });
    expect(parked.undo).toEqual({ when_date: null, evening: false, someday: true });
  });
});

describe("dropChanges", () => {
  it("a task is cancelled; undo reopens it", () => {
    expect(dropChanges(item("a", "2026-11-04"))).toEqual({ id: "a", changes: { status: "cancelled" }, undo: { status: "todo" } });
  });
});
