// The journal's today / suggestions split (pure parts).
import { describe, expect, it } from "vitest";
import { todayId } from "../lib/localDate";
import { fromNodeTask, journalBuckets, type JournalTask } from "../lib/tasks";

const task = (id: string, extra: Partial<JournalTask> = {}): JournalTask => ({
  id, title: id, status: "todo", when_date: null, evening: false, someday: false, recur: null, updated_at: null, ...extra,
});
const ids = (rows: JournalTask[]) => rows.map((r) => r.id);

describe("journalBuckets", () => {
  it("today lists only when-date = today, tonight's last; past ones become suggestions, oldest first", () => {
    const b = journalBuckets([
      task("night", { when_date: "2026-10-24", evening: true }), task("a", { when_date: "2026-10-24" }),
      task("old", { when_date: "2026-10-20" }), task("older", { when_date: "2026-10-01" }),
      task("future", { when_date: "2026-10-25" }), task("anytime"),
    ], "2026-10-24");
    expect(ids(b.today)).toEqual(["a", "night"]);
    expect(ids(b.suggestions)).toEqual(["older", "old"]);
  });

  it("ignores someday, parked, cancelled; done counts when due today or ticked today", () => {
    const b = journalBuckets([
      task("s", { when_date: "2026-10-24", someday: true }), task("w", { when_date: "2026-10-24", status: "waiting" }),
      task("c", { when_date: "2026-10-20", status: "cancelled" }),
      task("d1", { when_date: "2026-10-24", status: "done" }),
      task("d2", { when_date: "2026-10-20", status: "done", updated_at: "2026-10-24T03:00:00Z" }),
      task("d3", { when_date: "2026-10-20", status: "done", updated_at: "2026-10-22T03:00:00Z" }),
    ], "2026-10-24", "UTC");
    expect(b.today).toEqual([]);
    expect(b.suggestions).toEqual([]);
    expect(ids(b.doneToday)).toEqual(["d1", "d2"]);
  });

  it("the day cut follows the zone: one instant is two different todays", () => {
    const now = new Date("2026-10-24T20:00:00Z");
    const rows = [task("t", { when_date: "2026-10-24" }), task("n", { when_date: "2026-10-25" })];
    const utc = journalBuckets(rows, todayId(now, "UTC"));
    const taipei = journalBuckets(rows, todayId(now, "Asia/Taipei"));
    expect(ids(utc.today)).toEqual(["t"]);
    expect(ids(taipei.today)).toEqual(["n"]);
    expect(ids(taipei.suggestions)).toEqual(["t"]);
  });

  it("a recurring task is an ordinary row on its when-date", () => {
    const b = journalBuckets([task("r", { when_date: "2026-10-24", recur: "1w" }), task("r2", { when_date: "2026-10-17", recur: "1w" })], "2026-10-24");
    expect(ids(b.today)).toEqual(["r"]);
    expect(ids(b.suggestions)).toEqual(["r2"]);
  });

  it("reads the when-date from the task row, cut to its day", () => {
    expect(fromNodeTask({ id: "1", node_id: "n", title: "x", status: "todo", when_date: "2026-10-24T09:30" }).when_date).toBe("2026-10-24");
    expect(fromNodeTask({ id: "1", node_id: "n", title: "x", status: "todo", due_date: "2026-10-24", when_date: null }).when_date).toBeNull();
  });
});
