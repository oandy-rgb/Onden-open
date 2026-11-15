// lib/tasks/upcomingAgenda: the 接下來 agenda — a section per day with tasks, quiet days folded, 「之後」 past two weeks.
import { describe, expect, it } from "vitest";
import { AGENDA_DAYS, agendaWeek, toTaskItem, upcomingAgenda, type TaskItem } from "../lib/tasks";
import type { NodeTask } from "../lib/api";

const today = "2026-11-09"; // a Monday
const item = (id: string, when: string | null, extra: Record<string, unknown> = {}): TaskItem =>
  toTaskItem({ id, node_id: null, title: id, status: "todo", when_date: when, ...extra } as NodeTask, () => undefined);
const shape = (tasks: TaskItem[]) => upcomingAgenda(tasks, today).map((s) =>
  s.kind === "day" ? `${s.date}: ${s.items.map((t) => t.id).join(",")}` : s.kind === "quiet" ? `quiet ${s.from}..${s.to}` : `later: ${s.items.map((t) => t.id).join(",")}`);

describe("upcomingAgenda", () => {
  it("nothing planned: no agenda at all", () => {
    expect(upcomingAgenda([], today)).toEqual([]);
    expect(upcomingAgenda([item("anytime", null), item("past", "2026-11-01")], today)).toEqual([]);
  });

  it("a section per day with tasks, today first; days without are folded into one run", () => {
    expect(shape([item("t", today), item("w", "2026-11-11"), item("th", "2026-11-12")])).toEqual([
      "2026-11-09: t", "quiet 2026-11-10..2026-11-10", "2026-11-11: w", "2026-11-12: th", "quiet 2026-11-13..2026-11-22",
    ]);
  });

  it("an empty today starts the first quiet run", () => {
    expect(shape([item("tomorrow", "2026-11-10")])[0]).toBe("quiet 2026-11-09..2026-11-09");
  });

  it("within a day the ones with a time come first, by time; the rest keep their order", () => {
    const [segment] = upcomingAgenda([item("loose", today), item("late", today, { time: "15:00" }), item("early", today, { time: "08:30" })], today);
    expect(segment!.kind === "day" && segment!.items.map((t) => t.id)).toEqual(["early", "late", "loose"]);
  });

  it("two weeks are listed day by day; further off is 「之後」, by date", () => {
    const last = "2026-11-22"; // today + 13
    expect(AGENDA_DAYS).toBe(14);
    expect(shape([item("last", last), item("far", "2026-12-24"), item("near-later", "2026-11-23")])).toEqual([
      "quiet 2026-11-09..2026-11-21", "2026-11-22: last", "later: near-later,far",
    ]);
  });

  it("the week row is today and the six days after", () => {
    expect(agendaWeek(today)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
  });
});
