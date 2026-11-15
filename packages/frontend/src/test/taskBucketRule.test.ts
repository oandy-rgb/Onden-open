// The shared agenda bucket rule (@onden/markdown taskBucket) against the fixture the server's
// TASK_BUCKET_CASE_SQL also runs (backend taskBucketRule.integration.test.ts),
// plus the workspace-zone dates it depends on.

import { describe, it, expect } from "vitest";
import fixture from "../../../backend/src/test/fixtures/taskBuckets.json";
import { taskBucket } from "@onden/markdown";
import { addDays, dateIdAt, dateTimeId, daysBetween, nowDateTimeId, todayId } from "../lib/localDate";

// Taipei wall clock 2026-10-14T10:00:00 = 02:00 UTC.
const now = new Date("2026-10-14T02:00:00Z");

describe("agenda bucket rule (client)", () => {
  it("buckets every fixture case like the server does", () => {
    const today = todayId(now, fixture.timeZone);
    const got = fixture.cases.map((k) => taskBucket({ status: k.status, when: k.when, someday: k.someday }, today));
    expect(got).toEqual(fixture.cases.map((k) => k.bucket));
  });

  it("uses the workspace zone, not the browser's, for today", () => {
    // 23:30 UTC on the 13th is already the 14th in Taipei.
    const late = new Date("2026-10-13T23:30:00Z");
    expect(todayId(late, "Asia/Taipei")).toBe("2026-10-14");
    expect(todayId(late, "UTC")).toBe("2026-10-13");
    expect(nowDateTimeId(late, "Asia/Taipei")).toBe("2026-10-14T07:30:00");
  });

  it("does calendar arithmetic on ids", () => {
    expect(addDays("2026-10-28", 7)).toBe("2026-11-04");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("formats instants in the workspace zone and counts calendar days", () => {
    const late = new Date("2026-10-13T23:30:00Z");
    expect(dateIdAt(late, "Asia/Taipei")).toBe("2026-10-14");
    expect(dateTimeId(late, "Asia/Taipei")).toBe("2026-10-14 07:30");
    expect(daysBetween("2026-10-14", "2026-10-21")).toBe(7);
    expect(daysBetween("2026-10-14", "2026-10-11")).toBe(-3);
  });
});
