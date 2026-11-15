import { describe, expect, it } from "vitest";
import { isDayItemPast, layoutDayItems, mergeEditRuns, sortDayItems, type DayEdit, type DayItem } from "./dayItems.js";

const at = (hhmm: string) => `2026-10-30T${hhmm}:00Z`;
const edit = (nodeId: string, hhmm: string, actorId = "a"): DayEdit => ({ nodeId, title: `Note ${nodeId}`, at: at(hhmm), actorId });
const NOW = Date.parse(at("12:00"));

describe("mergeEditRuns", () => {
  it("merges one person's edits less than 30 minutes apart into one run", () => {
    const [run, ...rest] = mergeEditRuns([edit("1", "10:40"), edit("2", "11:05"), edit("3", "11:30")], NOW);
    expect(rest).toEqual([]);
    expect(run).toMatchObject({ at: at("10:40"), until: at("11:30"), kind: "edit", count: 3, past: true, ref: { type: "note", id: "1" } });
  });

  it("starts a new run at a gap of 30 minutes or more", () => {
    const runs = mergeEditRuns([edit("1", "10:00"), edit("2", "10:29"), edit("3", "10:58")], NOW);
    // 10:00 → 10:29 → 10:58: each gap is under 30 minutes, so one run
    expect(runs).toHaveLength(1);
    const split = mergeEditRuns([edit("1", "10:00"), edit("2", "10:30")], NOW);
    expect(split.map((r) => r.at)).toEqual([at("10:00"), at("10:30")]);
  });

  it("keeps different people's edits apart", () => {
    const runs = mergeEditRuns([edit("1", "10:00", "a"), edit("2", "10:05", "b")], NOW);
    expect(runs).toHaveLength(2);
  });

  it("names a single note by its title and counts distinct notes", () => {
    const [one] = mergeEditRuns([edit("1", "10:00"), edit("1", "10:10")], NOW);
    expect(one).toMatchObject({ title: "Note 1", count: 1, until: at("10:10") });
    const [single] = mergeEditRuns([edit("1", "10:00")], NOW);
    expect(single!.until).toBeUndefined();
  });

  it("is not past while the run is still going on", () => {
    const [run] = mergeEditRuns([edit("1", "11:50"), edit("2", "12:10")], NOW);
    expect(run!.past).toBe(false);
  });
});

const item = (over: Partial<DayItem>): DayItem => ({ kind: "task", title: "t", ref: { type: "task", id: "x" }, past: false, ...over });

describe("sortDayItems / isDayItemPast", () => {
  it("puts timed items first, in time order", () => {
    const sorted = sortDayItems([item({ title: "none" }), item({ title: "late", at: at("15:00") }), item({ title: "early", at: at("09:00") })]);
    expect(sorted.map((i) => i.title)).toEqual(["early", "late", "none"]);
  });

  it("judges a timed item by its end, an untimed one by its own flag", () => {
    expect(isDayItemPast(item({ at: at("11:00"), until: at("13:00") }), NOW)).toBe(false);
    expect(isDayItemPast(item({ at: at("11:00") }), NOW)).toBe(true);
    expect(isDayItemPast(item({ past: true }), NOW)).toBe(true);
  });
});

describe("layoutDayItems", () => {
  // A day that starts at 04:00 and is 24 hours long.
  const day = { startMs: Date.parse(at("04:00")), endMs: Date.parse(at("04:00")) + 24 * 3_600_000 };

  it("measures from the start of the day, not from midnight", () => {
    const { placed } = layoutDayItems([item({ at: at("05:30"), until: at("07:00") })], day);
    expect(placed[0]).toMatchObject({ topMinutes: 90, heightMinutes: 90, lane: 0, lanes: 1 });
  });

  it("gives a point item the minimum height and keeps untimed items apart", () => {
    const { placed, untimed } = layoutDayItems([item({ at: at("06:00") }), item({ title: "free" })], day);
    expect(placed[0]!.heightMinutes).toBe(30);
    expect(untimed.map((i) => i.title)).toEqual(["free"]);
  });

  it("drops what is outside the day and clips what crosses its edge", () => {
    const before = item({ title: "before", at: at("02:00"), until: at("03:00") });
    const across = item({ title: "across", at: at("03:00"), until: at("05:00") });
    const after = item({ title: "after", at: "2026-10-31T04:00:00Z" });
    const { placed } = layoutDayItems([before, across, after], day);
    expect(placed.map((p) => p.item.title)).toEqual(["across"]);
    expect(placed[0]).toMatchObject({ topMinutes: 0, heightMinutes: 60 });
  });

  it("puts overlapping items side by side and lets later ones reuse lanes", () => {
    const { placed } = layoutDayItems([
      item({ title: "a", at: at("09:00"), until: at("10:00") }),
      item({ title: "b", at: at("09:30"), until: at("10:30") }),
      item({ title: "c", at: at("11:00"), until: at("12:00") }),
    ], day);
    const by = Object.fromEntries(placed.map((p) => [p.item.title, p]));
    expect([by.a!.lane, by.b!.lane]).toEqual([0, 1]);
    expect([by.a!.lanes, by.b!.lanes, by.c!.lanes]).toEqual([2, 2, 1]);
  });

  it("uses the visual minimum for lanes only: short items 1-5 minutes apart split, farther apart share a lane", () => {
    const run = (start: string, until: string, title: string) => item({ title, at: at(start), until: at(until) });
    const near = layoutDayItems([run("09:00", "09:06", "a"), run("09:07", "09:13", "b"), run("09:15", "09:21", "c")], day, 30, 26);
    expect(near.placed.map((p) => p.lane)).toEqual([0, 1, 2]);
    expect(near.placed.every((p) => p.lanes === 3)).toBe(true);
    expect(near.placed.map((p) => p.heightMinutes)).toEqual([6, 6, 6]);
    const far = layoutDayItems([run("09:00", "09:06", "a"), run("09:27", "09:33", "b"), run("10:00", "10:06", "c")], day, 30, 26);
    expect(far.placed.map((p) => [p.lane, p.lanes])).toEqual([[0, 1], [0, 1], [0, 1]]);
    // Without a visual minimum the same three overlap-free items stay in one lane.
    const plain = layoutDayItems([run("09:00", "09:06", "a"), run("09:07", "09:13", "b")], day, 0);
    expect(plain.placed.map((p) => p.lanes)).toEqual([1, 1]);
  });

  it("works on a day shorter than 24 hours (a daylight-saving day)", () => {
    const short = { startMs: day.startMs, endMs: day.startMs + 23 * 3_600_000 };
    const { placed } = layoutDayItems([item({ at: "2026-10-31T02:30:00Z", until: "2026-10-31T05:00:00Z" })], short);
    expect(placed[0]).toMatchObject({ topMinutes: 22.5 * 60, heightMinutes: 30 });
  });
});

import { onTimeline } from "./dayItems.js";
describe("onTimeline", () => {
  it("keeps only task and focus", () => {
    const kinds = ["task", "edit", "created", "capture", "agent", "focus"] as const;
    expect(kinds.filter((kind) => onTimeline({ kind }))).toEqual(["task", "focus"]);
  });
});
