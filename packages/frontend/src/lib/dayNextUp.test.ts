import { describe, expect, it } from "vitest";
import type { DayItem } from "@onden/markdown";
import { nextUp } from "./dayNextUp";

const item = (over: Partial<DayItem>): DayItem => ({ kind: "task", title: "t", ref: { type: "task", id: "x" }, past: false, done: false, ...over });
const NOW = Date.parse("2026-10-30T14:20:00Z");

describe("nextUp", () => {
  it("is the earliest open timed task after now, with the minutes until it", () => {
    const found = nextUp([item({ title: "late", at: "2026-10-30T17:00:00Z" }), item({ title: "soon", at: "2026-10-30T15:00:00Z" })], NOW);
    expect(found).toMatchObject({ item: { title: "soon" }, minutes: 40 });
  });

  it("skips the past, finished tasks, untimed tasks and anything that is not a task", () => {
    expect(nextUp([
      item({ at: "2026-10-30T14:00:00Z" }),
      item({ at: "2026-10-30T16:00:00Z", done: true }),
      item({}),
      item({ kind: "capture", at: "2026-10-30T16:00:00Z" }),
    ], NOW)).toBeNull();
  });

  it("rounds a part-minute up so the tag never says 0", () => {
    expect(nextUp([item({ at: "2026-10-30T14:20:20Z" })], NOW)?.minutes).toBe(1);
  });
});
