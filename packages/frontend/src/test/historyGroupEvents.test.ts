import { beforeEach, describe, expect, it } from "vitest";
import { EDIT_GROUP_WINDOW_MS, groupEvents } from "../lib/history/groupEvents";
import type { LiveEvent } from "../lib/liveEvent";

const T0 = Date.parse("2026-10-22T02:00:00Z");
let nextId = 100;

// Newest-first, like the feed: `minutesAgo` is the only ordering input.
function ev(minutesAgo: number, over: Partial<LiveEvent> = {}): LiveEvent {
  return {
    id: nextId--, actor_type: "user", actor_id: "u", event_type: "NODE_UPDATED", target_type: "node",
    target_id: "a", payload: {}, created_at: new Date(T0 - minutesAgo * 60_000).toISOString(), ...over,
  };
}
const shape = (rows: ReturnType<typeof groupEvents>) =>
  rows.map((r) => (r.kind === "edits" ? r.events.length : 1));

describe("groupEvents", () => {
  beforeEach(() => { nextId = 100; });
  it("groups quick edits of one note by one actor", () => {
    const rows = groupEvents([ev(0), ev(1)]);
    expect(shape(rows)).toEqual([2]);
    expect(rows[0]!.kind === "edits" && rows[0]!.events.map((e) => e.id)).toEqual([100, 99]);
  });
  it("keeps three edits together and one row per ungrouped event", () => {
    expect(shape(groupEvents([ev(0), ev(2), ev(4)]))).toEqual([3]);
    expect(shape(groupEvents([ev(0)]))).toEqual([1]);
    expect(groupEvents([])).toEqual([]);
  });
  it("splits when another actor edited the same note in between", () => {
    const rows = groupEvents([ev(0), ev(1, { actor_id: "bot", actor_type: "ai_agent" }), ev(2)]);
    expect(shape(rows)).toEqual([1, 1, 1]);
  });
  it("splits for a different actor even if only the type differs", () => {
    expect(shape(groupEvents([ev(0), ev(1, { actor_type: "system" })]))).toEqual([1, 1]);
  });
  it("is not interrupted by events on other notes", () => {
    const rows = groupEvents([ev(0), ev(1, { target_id: "b" }), ev(2)]);
    expect(shape(rows)).toEqual([2, 1]);
    // The group stays at its newest edit; the other note's row follows.
    expect(rows[0]!.kind).toBe("edits");
  });
  it("is interrupted by another event on the same note (tag, move, delete)", () => {
    expect(shape(groupEvents([ev(0), ev(1, { event_type: "TAG_APPLIED" }), ev(2)]))).toEqual([1, 1, 1]);
    const move = ev(1, { payload: { parent_id: "p" }, tx_meta: { prev_field_values: { parent_id: null } } });
    expect(shape(groupEvents([ev(0), move, ev(2)]))).toEqual([1, 1, 1]);
  });
  it("never groups other event types or notes' different targets", () => {
    expect(shape(groupEvents([ev(0, { event_type: "TAG_APPLIED" }), ev(1, { event_type: "TAG_APPLIED" })]))).toEqual([1, 1]);
    expect(shape(groupEvents([ev(0, { target_id: "b" }), ev(1)]))).toEqual([1, 1]);
    expect(shape(groupEvents([ev(0, { target_type: "tag" }), ev(1, { target_type: "tag" })]))).toEqual([1, 1]);
  });
  it("includes an edit exactly at the window boundary and excludes one just past it", () => {
    const edge = EDIT_GROUP_WINDOW_MS / 60_000;
    expect(shape(groupEvents([ev(0), ev(edge)]))).toEqual([2]);
    const past = ev(edge); past.created_at = new Date(T0 - EDIT_GROUP_WINDOW_MS - 1).toISOString();
    expect(shape(groupEvents([ev(0), past]))).toEqual([1, 1]);
  });
  it("measures the window from the group's newest edit, so a chain cannot grow forever", () => {
    expect(shape(groupEvents([ev(0), ev(6), ev(12)]))).toEqual([2, 1]);
  });
  it("lets a later burst start a new group after a gap", () => {
    expect(shape(groupEvents([ev(0), ev(1), ev(30), ev(31)]))).toEqual([2, 2]);
  });
});
