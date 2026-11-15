import { describe, it, expect } from "vitest";
import {
  dueTasks,
  dueSoonCount,
  pendingDueNotices,
  pendingRemindNotices,
  reminderMoment,
  REMIND_CATCH_UP_MS,
  type Agenda,
  type AgendaTask,
} from "../lib/dueSoonNotify";

function task(p: Partial<AgendaTask> & { id: string; bucket: string }): AgendaTask {
  return {
    node_id: `n-${p.id}`,
    node_title: "A note",
    title: `Task ${p.id}`,
    status: "todo",
    due_date: null,
    recur: null,
    ...p,
  };
}

function agenda(buckets: Record<string, AgendaTask[]>): Agenda {
  const count = Object.values(buckets).reduce((a, b) => a + b.length, 0);
  return { buckets, count };
}

describe("dueTasks", () => {
  it("flattens only overdue + today, overdue first", () => {
    const a = agenda({
      overdue: [task({ id: "o1", bucket: "overdue", due_date: "2026-06-10" })],
      today: [task({ id: "t1", bucket: "today", due_date: "2026-06-13" })],
      upcoming: [task({ id: "u1", bucket: "upcoming", due_date: "2026-06-15" })],
      unscheduled: [task({ id: "x1", bucket: "unscheduled" })],
    });
    expect(dueTasks(a).map((t) => t.id)).toEqual(["o1", "t1"]);
  });

  it("excludes done / cancelled even if the server bucketed them", () => {
    const a = agenda({
      overdue: [
        task({ id: "o1", bucket: "overdue", status: "todo" }),
        task({ id: "o2", bucket: "overdue", status: "done" }),
        task({ id: "o3", bucket: "overdue", status: "cancelled" }),
      ],
    });
    expect(dueTasks(a).map((t) => t.id)).toEqual(["o1"]);
  });

  it("is empty for null / missing buckets", () => {
    expect(dueTasks(null)).toEqual([]);
    expect(dueTasks(undefined)).toEqual([]);
    expect(dueTasks({ buckets: {}, count: 0 })).toEqual([]);
  });
});

describe("dueSoonCount", () => {
  it("counts overdue + today only", () => {
    const a = agenda({
      overdue: [task({ id: "o1", bucket: "overdue" })],
      today: [task({ id: "t1", bucket: "today" }), task({ id: "t2", bucket: "today" })],
      upcoming: [task({ id: "u1", bucket: "upcoming" })],
    });
    expect(dueSoonCount(a)).toBe(3);
  });
});

describe("pendingDueNotices", () => {
  it("builds a notice per due task, overdue marked urgent", () => {
    const a = agenda({
      overdue: [task({ id: "o1", bucket: "overdue", due_date: "2026-06-10", title: "Pay bill", node_title: "Finance" })],
      today: [task({ id: "t1", bucket: "today", title: "School run", node_title: "Today" })],
    });
    const { notices } = pendingDueNotices(a, new Set());
    expect(notices).toHaveLength(2);
    const overdue = notices.find((n) => n.taskId === "o1")!;
    expect(overdue.urgent).toBe(true);
    expect(overdue.title).toBe("Overdue: Pay bill");
    expect(overdue.body).toContain("Overdue since 2026-06-10");
    expect(overdue.nodeId).toBe("n-o1");
    expect(overdue.key).toBe("overdue:o1");

    const today = notices.find((n) => n.taskId === "t1")!;
    expect(today.urgent).toBe(false);
    expect(today.title).toBe("Due today: School run");
    expect(today.body).toContain("Due today");
  });

  it("does not re-fire a task already notified (de-dupe)", () => {
    const a = agenda({ overdue: [task({ id: "o1", bucket: "overdue" })] });
    const first = pendingDueNotices(a, new Set());
    expect(first.notices).toHaveLength(1);
    expect(first.firedKeys.has("overdue:o1")).toBe(true);

    // Same agenda, feeding the persisted fired set back in → nothing new fires.
    const second = pendingDueNotices(a, first.firedKeys);
    expect(second.notices).toHaveLength(0);
    expect(second.firedKeys.has("overdue:o1")).toBe(true);
  });

  it("re-fires once when a task rolls overdue→today (new key)", () => {
    const firstDay = agenda({ overdue: [task({ id: "x", bucket: "overdue" })] });
    const s1 = pendingDueNotices(firstDay, new Set());
    expect(s1.notices.map((n) => n.key)).toEqual(["overdue:x"]);

    // Next day the same task is bucketed "today" — a distinct key fires once.
    const nextDay = agenda({ today: [task({ id: "x", bucket: "today" })] });
    const s2 = pendingDueNotices(nextDay, s1.firedKeys);
    expect(s2.notices.map((n) => n.key)).toEqual(["today:x"]);
    // The stale overdue key is pruned so the set can't grow unbounded.
    expect(s2.firedKeys.has("overdue:x")).toBe(false);
    expect(s2.firedKeys.has("today:x")).toBe(true);
  });

  it("prunes fired keys whose tasks left the due buckets (completed)", () => {
    const before = agenda({ overdue: [task({ id: "o1", bucket: "overdue" })] });
    const s1 = pendingDueNotices(before, new Set());
    // Task completed → gone from the agenda's due buckets entirely.
    const after = agenda({});
    const s2 = pendingDueNotices(after, s1.firedKeys);
    expect(s2.notices).toHaveLength(0);
    expect(s2.firedKeys.size).toBe(0);
  });
});

describe("reminders at a time", () => {
  const at = (wall: string) => ({ ms: Date.parse(`${wall.slice(0, 16)}:00Z`), wall });
  const day = agenda({ today: [
    task({ id: "a", bucket: "today", due_date: "2026-10-30", time: "15:00" }),
    task({ id: "b", bucket: "today", due_date: "2026-10-30", remind_at: "2026-10-30T09:30" }),
    task({ id: "c", bucket: "today", due_date: "2026-10-30" }),
  ] });

  it("uses the reminder when there is one, else the time it starts", () => {
    expect(reminderMoment({ remind_at: "2026-10-30T09:30", time: "15:00", due_date: "2026-10-30" })).toEqual({ text: "2026-10-30T09:30", instant: false });
    expect(reminderMoment({ remind_at: null, time: "15:00", due_date: "2026-10-30" })).toEqual({ text: "2026-10-30T15:00", instant: false });
    expect(reminderMoment({ remind_at: "2026-10-30T01:30:00.000Z", time: null, due_date: null })?.instant).toBe(true);
    expect(reminderMoment({ remind_at: null, time: null, due_date: "2026-10-30" })).toBeNull();
  });

  it("waits for the moment, fires it once, and not again", () => {
    expect(pendingRemindNotices(day, at("2026-10-30T09:29:50"), new Set()).notices).toHaveLength(0);
    const first = pendingRemindNotices(day, at("2026-10-30T09:30:05"), new Set());
    expect(first.notices.map((n) => n.taskId)).toEqual(["b"]);
    expect(pendingRemindNotices(day, at("2026-10-30T09:30:20"), first.firedKeys).notices).toHaveLength(0);
    const later = pendingRemindNotices(day, at("2026-10-30T15:00:10"), first.firedKeys);
    expect(later.notices.map((n) => n.taskId)).toEqual(["a"]);
    expect(later.firedKeys.has(first.notices[0]!.key)).toBe(true);
  });

  it("catches up on what passed while the app was away, but only recent moments", () => {
    const back = pendingRemindNotices(day, at("2026-10-30T16:00:00"), new Set());
    expect(back.notices.map((n) => n.taskId).sort()).toEqual(["a", "b"]);
    const longAgo = pendingRemindNotices(day, at("2026-10-31T09:31:00"), new Set());
    expect(longAgo.notices.map((n) => n.taskId)).toEqual([]); // past the catch-up window (12 h): the late list says it
    expect(REMIND_CATCH_UP_MS).toBe(12 * 3_600_000);
  });

  it("names the moment the way a push does, so the two share one notification (tag)", () => {
    const first = pendingRemindNotices(day, at("2026-10-30T09:30:05"), new Set());
    expect(first.notices[0]!.key).toBe("remind:b:2026-10-30T09:30");
  });

  it("moves with a changed time, never nags about a finished task, and compares instants as instants", () => {
    const moved = agenda({ today: [task({ id: "a", bucket: "today", due_date: "2026-10-30", time: "18:00" })] });
    const fired = new Set(["remind:a:2026-10-30T15:00"]);
    expect(pendingRemindNotices(moved, at("2026-10-30T18:00:05"), fired).notices).toHaveLength(1);
    const done = agenda({ today: [task({ id: "a", bucket: "today", due_date: "2026-10-30", time: "15:00", status: "done" })] });
    expect(pendingRemindNotices(done, at("2026-10-30T15:01:00"), new Set()).notices).toHaveLength(0);
    const instant = agenda({ today: [task({ id: "i", bucket: "today", remind_at: "2026-10-30T01:00:00.000Z" })] });
    expect(pendingRemindNotices(instant, { ms: Date.parse("2026-10-30T01:00:30Z"), wall: "2026-10-30T09:00:30" }, new Set()).notices).toHaveLength(1);
    expect(pendingRemindNotices(instant, { ms: Date.parse("2026-10-30T00:59:30Z"), wall: "2026-10-30T08:59:30" }, new Set()).notices).toHaveLength(0);
  });

  it("the due check and the reminder check share one fired set: each reminder and each due notice fires once over many polls", () => {
    // The hook runs pendingDueNotices, then pendingRemindNotices, every poll, on one persisted set.
    let fired: ReadonlySet<string> = new Set();
    const shown: string[] = [];
    for (const wall of ["2026-10-30T09:30:05", "2026-10-30T09:35:05", "2026-10-30T09:40:05", "2026-10-30T15:00:10", "2026-10-30T15:05:10", "2026-10-30T15:10:10"]) {
      const dueNow = pendingDueNotices(day, fired);
      const remindNow = pendingRemindNotices(day, at(wall), dueNow.firedKeys);
      fired = remindNow.firedKeys;
      shown.push(...dueNow.notices.map((n) => n.key), ...remindNow.notices.map((n) => n.key));
    }
    expect(shown.filter((key) => key.startsWith("remind:")).sort()).toEqual(["remind:a:2026-10-30T15:00", "remind:b:2026-10-30T09:30"]);
    expect(shown.filter((key) => key.startsWith("today:")).sort()).toEqual(["today:a", "today:b", "today:c"]);
  });

  it("each check keeps the other's keys and still prunes its own", () => {
    const fired = new Set(["remind:z:2026-10-30T08:00", "today:gone", "overdue:gone"]);
    expect([...pendingDueNotices(day, fired).firedKeys].sort()).toEqual(["remind:z:2026-10-30T08:00", "today:a", "today:b", "today:c"]);
    // a reminder of a task that left the agenda is remembered while its moment can still be caught up (a task finished and reopened)
    expect([...pendingRemindNotices(day, at("2026-10-30T09:00:00"), fired).firedKeys].sort()).toEqual(["overdue:gone", "remind:z:2026-10-30T08:00", "today:gone"]);
    expect([...pendingRemindNotices(day, at("2026-10-31T09:00:00"), fired).firedKeys].sort()).toEqual(["overdue:gone", "today:gone"]);
  });
});
