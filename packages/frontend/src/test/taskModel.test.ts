import { describe, it, expect } from "vitest";
import { todayId } from "../lib/localDate";
import {
  bucketTasks, describeDay, homeTab, isOverdue, nextMonday, tabCounts, thisFriday, toTaskItem,
  whenChanges, whenChoiceOf, type TaskItem, type TaskRow,
} from "../lib/tasks/taskModel";

const TODAY = "2026-10-24"; // a Saturday

const item = (over: Partial<TaskItem> & { id: string }): TaskItem => ({
  title: over.id, status: "todo", source: "standalone", noteId: null, noteTitle: "", whenDate: null, evening: false, someday: false,
  deadline: null, recur: null, recurMode: "fixed", remindAt: null, time: null, until: null, doneAt: null, blockRef: null, hasBody: false, ...over,
});
const ids = (list: TaskItem[]) => list.map((task) => task.id);

describe("bucketTasks", () => {
  it("counts a past 何時做 as today, with no overdue state", () => {
    const b = bucketTasks([item({ id: "old", whenDate: "2026-10-01" }), item({ id: "now", whenDate: TODAY })], TODAY);
    expect(ids(b.today.today)).toEqual(["old", "now"]);
    expect(b.upcoming).toEqual([]);
  });

  it("splits tonight from today, and keeps a future date off today", () => {
    const b = bucketTasks([
      item({ id: "a", whenDate: TODAY }),
      item({ id: "e", whenDate: TODAY, evening: true }),
      item({ id: "f", whenDate: "2026-10-25" }),
    ], TODAY);
    expect(ids(b.today.today)).toEqual(["a"]);
    expect(ids(b.today.evening)).toEqual(["e"]);
    expect(b.upcoming.map((g) => g.date)).toEqual(["2026-10-25"]);
  });

  it("groups 接下來 by day in date order", () => {
    const b = bucketTasks([
      item({ id: "c", whenDate: "2026-10-27" }), item({ id: "a", whenDate: "2026-10-25" }), item({ id: "b", whenDate: "2026-10-25" }),
    ], TODAY);
    expect(b.upcoming.map((g) => [g.date, ids(g.items)])).toEqual([["2026-10-25", ["a", "b"]], ["2026-10-27", ["c"]]]);
  });

  it("puts undated tasks on 隨時 and someday ones on 某天", () => {
    const b = bucketTasks([item({ id: "any" }), item({ id: "some", someday: true })], TODAY);
    expect(ids(b.anytime)).toEqual(["any"]);
    expect(ids(b.someday)).toEqual(["some"]);
  });

  it("floats a deadline within two days onto 今天 as 快到期, wherever it lives", () => {
    const b = bucketTasks([
      item({ id: "soon", whenDate: "2026-11-05", deadline: "2026-10-26" }),
      item({ id: "edge", deadline: "2026-10-26" }),
      item({ id: "far", deadline: "2026-10-27" }),
      item({ id: "parked", someday: true, deadline: TODAY }),
      item({ id: "past", whenDate: "2026-11-05", deadline: "2026-10-20" }),
    ], TODAY);
    expect(ids(b.today.dueSoon).sort()).toEqual(["edge", "parked", "past", "soon"]);
    // still on its own tab too: a deadline never hides a task
    expect(ids(b.anytime)).toEqual(["edge", "far"]);
    expect(b.upcoming[0]!.items.map((x) => x.id)).toContain("soon");
  });

  it("does not list a task twice on 今天", () => {
    const b = bucketTasks([item({ id: "x", whenDate: TODAY, deadline: TODAY })], TODAY);
    expect(ids(b.today.today)).toEqual(["x"]);
    expect(b.today.dueSoon).toEqual([]);
  });

  it("drops done and cancelled tasks unless just ticked", () => {
    const tasks = [item({ id: "d", status: "done", whenDate: TODAY }), item({ id: "c", status: "cancelled" }), item({ id: "o", whenDate: TODAY })];
    expect(ids(bucketTasks(tasks, TODAY).today.today)).toEqual(["o"]);
    const kept = bucketTasks(tasks, TODAY, new Set(["d"]));
    expect(ids(kept.today.today)).toEqual(["d", "o"]);
    expect(tabCounts(kept).today).toBe(1);
  });

  it("rolls the day over in the workspace zone, not the machine's", () => {
    const instant = new Date("2026-10-24T20:30:00Z"); // already Oct 25 in Taipei, still Oct 24 in New York
    const task = item({ id: "t", whenDate: "2026-10-25" });
    expect(ids(bucketTasks([task], todayId(instant, "Asia/Taipei")).today.today)).toEqual(["t"]);
    expect(ids(bucketTasks([task], todayId(instant, "America/New_York")).today.today)).toEqual([]);
  });

  it("counts open tasks per tab", () => {
    const b = bucketTasks([
      item({ id: "1", whenDate: TODAY }), item({ id: "2", whenDate: "2026-10-30" }), item({ id: "3" }), item({ id: "4", someday: true }),
      item({ id: "5", deadline: TODAY }),
    ], TODAY);
    expect(tabCounts(b)).toEqual({ today: 2, upcoming: 1, anytime: 2, someday: 1 });
  });
});

describe("overdue", () => {
  it("sits on 今天 but is called late, like the due-soon notification", () => {
    const late = item({ id: "late", whenDate: "2026-10-20" });
    expect(homeTab(late, TODAY)).toBe("today");
    expect(isOverdue(late, TODAY)).toBe(true);
    expect(isOverdue(item({ id: "now", whenDate: TODAY }), TODAY)).toBe(false);
    expect(isOverdue(item({ id: "done", whenDate: "2026-10-20", status: "done" }), TODAY)).toBe(false);
    expect(isOverdue(item({ id: "parked", whenDate: "2026-10-20", someday: true }), TODAY)).toBe(false);
  });
});

describe("toTaskItem", () => {
  const base: TaskRow = { id: "t", node_id: "n", title: "T", status: "todo" };
  const titleOf = (id: string) => (id === "n" ? "Host" : undefined);

  it("reads the day from when_date, cut to the day", () => {
    expect(toTaskItem({ ...base, when_date: "2026-10-25T09:30" }, titleOf)).toMatchObject({ whenDate: "2026-10-25", noteId: "n", noteTitle: "Host", someday: false });
  });

  it("reads a T1 row; node_id null is a standalone task", () => {
    const row: TaskRow = { ...base, node_id: null, when_date: "2026-10-26", evening: true, deadline: "2026-10-30", recur: "1w", recur_mode: "after", remind_at: "2026-10-26T09:00", has_body: true };
    expect(toTaskItem(row, titleOf)).toMatchObject({ noteId: null, noteTitle: "", whenDate: "2026-10-26", evening: true, deadline: "2026-10-30", recurMode: "after", hasBody: true });
  });

  it("a dated task is never someday", () => {
    expect(toTaskItem({ ...base, when_date: "2026-10-26", someday: true }, titleOf).someday).toBe(false);
  });
});

describe("toTaskItem sources", () => {
  const row = (over: Partial<TaskRow>): TaskRow => ({ id: "x", node_id: null, title: "x", status: "todo", due_date: null, recur: null, ...over } as TaskRow);
  it("tells a standalone task from a line", () => {
    const title = () => "Host";
    expect(toTaskItem(row({}), title)).toMatchObject({ source: "standalone", noteId: null, noteTitle: "" });
    expect(toTaskItem(row({ node_id: "n" }), title)).toMatchObject({ source: "line", noteId: "n", noteTitle: "Host" });
  });
});

describe("choices and writes", () => {
  it("each 何時做 choice sets all three fields", () => {
    expect(whenChanges({ kind: "evening" }, TODAY)).toEqual({ when_date: TODAY, evening: true, someday: false });
    expect(whenChanges({ kind: "tomorrow" }, TODAY)).toEqual({ when_date: "2026-10-25", evening: false, someday: false });
    expect(whenChanges({ kind: "nextMonday" }, TODAY)).toEqual({ when_date: "2026-10-26", evening: false, someday: false });
    expect(whenChanges({ kind: "anytime" }, TODAY)).toEqual({ when_date: null, evening: false, someday: false });
    expect(whenChanges({ kind: "someday" }, TODAY)).toEqual({ when_date: null, evening: false, someday: true });
  });

  it("weekday shortcuts", () => {
    expect(nextMonday("2026-10-26")).toBe("2026-11-02"); // a Monday asks for the next one
    expect(thisFriday("2026-10-23")).toBe("2026-10-23");
    expect(thisFriday(TODAY)).toBe("2026-10-30");
    expect(describeDay("2026-10-27", TODAY)).toEqual({ kind: "date", weekday: 2, month: 10, day: 27 });
    expect(describeDay("2026-10-25", TODAY)).toEqual({ kind: "tomorrow" });
  });

  it("lights the pill that matches the task", () => {
    expect(whenChoiceOf(item({ id: "a", whenDate: "2026-10-20" }), TODAY)).toBe("today");
    expect(whenChoiceOf(item({ id: "a", whenDate: TODAY, evening: true }), TODAY)).toBe("evening");
    expect(whenChoiceOf(item({ id: "a", whenDate: "2026-11-20" }), TODAY)).toBe("date");
    expect(whenChoiceOf(item({ id: "a", someday: true }), TODAY)).toBe("someday");
  });

});
