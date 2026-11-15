import { describe, it, expect } from "vitest";
import { DUE_DATE_RE, dueHasTime, advanceDue, isDueDate } from "../modules/tasks/recurrence.js";

// Time-of-day on a task due value: a due is EITHER a pure date (the date-only
// default, so existing tasks are untouched) OR a wall-clock datetime
// (`YYYY-MM-DDTHH:MM[:SS]`) so "school pickup 3:15pm" is expressible. The
// agenda/scheduler keep comparing as TEXT, which only holds if both forms sort
// like the instant they spell — these are the load-bearing pure functions.
describe("DUE_DATE_RE — accepts date-only OR datetime, rejects junk", () => {
  it("accepts a bare date (the default)", () => {
    expect(DUE_DATE_RE.test("2026-06-13")).toBe(true);
  });
  it("accepts a datetime with HH:MM", () => {
    expect(DUE_DATE_RE.test("2026-06-13T15:15")).toBe(true);
  });
  it("accepts a datetime with seconds", () => {
    expect(DUE_DATE_RE.test("2026-06-13T15:15:00")).toBe(true);
  });
  it("rejects a zone offset (due is wall-clock, not zoned)", () => {
    expect(DUE_DATE_RE.test("2026-06-13T15:15:00Z")).toBe(false);
    expect(DUE_DATE_RE.test("2026-06-13T15:15+09:00")).toBe(false);
  });
  it("rejects malformed values", () => {
    expect(DUE_DATE_RE.test("2026/06/13")).toBe(false);
    expect(DUE_DATE_RE.test("tomorrow")).toBe(false);
    expect(DUE_DATE_RE.test("2026-06-13T15")).toBe(false);
  });
});

describe("isDueDate — the shape AND a real calendar day (D107)", () => {
  it("accepts real dates and datetimes", () => {
    for (const v of ["2026-02-28", "2028-02-29", "2026-12-31T23:59", "2026-06-13T15:15:00"]) expect(isDueDate(v)).toBe(true);
  });
  it("rejects a day the calendar does not have, which recurrence would roll into the next month", () => {
    for (const v of ["2026-02-30", "2026-02-29", "2026-04-31", "2026-13-01", "2026-00-10"]) expect(isDueDate(v)).toBe(false);
  });
  it("rejects an impossible time of day", () => {
    expect(isDueDate("2026-06-13T24:00")).toBe(false);
    expect(isDueDate("2026-06-13T15:60")).toBe(false);
  });
  it("keeps DUE_DATE_RE's shape: no zone, no space separator", () => {
    expect(isDueDate("2026-06-13T15:15Z")).toBe(false);
    expect(isDueDate("2026-06-13 15:15")).toBe(false);
  });
});

describe("text-sort invariant — a same-day datetime sorts AFTER its bare date", () => {
  // Why bucketing can stay TEXT-based: LEFT(value, 10) keys the day buckets,
  // and a timed value never sorts before the bare date of the same day.
  it("date prefix orders before any same-day datetime", () => {
    expect("2026-06-13" < "2026-06-13T00:00").toBe(true);
    expect("2026-06-13" < "2026-06-13T15:15").toBe(true);
  });
  it("times within a day order chronologically", () => {
    expect("2026-06-13T09:00" < "2026-06-13T15:15").toBe(true);
  });
});

describe("dueHasTime", () => {
  it("false for a bare date", () => expect(dueHasTime("2026-06-13")).toBe(false));
  it("true when a time is present", () => expect(dueHasTime("2026-06-13T15:15")).toBe(true));
});

describe("advanceDue — preserves the time-of-day across recurrence", () => {
  it("keeps date-only when there is no time (unchanged behavior)", () => {
    expect(advanceDue("2026-06-13", "1d")).toBe("2026-06-14");
  });
  it("a daily 3:15pm pickup stays 3:15pm", () => {
    expect(advanceDue("2026-06-13T15:15", "1d")).toBe("2026-06-14T15:15");
  });
  it("weekly recurrence preserves the time", () => {
    expect(advanceDue("2026-06-13T08:30", "1w")).toBe("2026-06-20T08:30");
  });
  it("monthly recurrence preserves seconds too", () => {
    expect(advanceDue("2026-01-31T23:59:59", "1m")).toBe("2026-02-28T23:59:59"); // clamped to the month end
  });
});
