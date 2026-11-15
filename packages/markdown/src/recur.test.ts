import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isCalendarDay } from "./attributeValue.js";
import { addDays, addMonths, daysBetween } from "./calendar.js";
import { advanceDate, isParsableRecur, isValidRecur, nextDueAfter, nextOccurrenceDate, parseRecur } from "./recur.js";

describe("calendar arithmetic", () => {
  it("adds days across month and year ends, and back", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-10-20", "2026-10-27")).toBe(7);
    expect(daysBetween("2026-10-27", "2026-10-20")).toBe(-7);
  });
  it("clamps months to the last day", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-11-30", 3)).toBe("2027-02-28");
  });
});

describe("parseRecur", () => {
  it("reads <n><d|w|m> with up to three digits", () => {
    expect(parseRecur("2w")).toEqual({ n: 2, unit: "w" });
    expect(parseRecur("999d")).toEqual({ n: 999, unit: "d" });
    for (const bad of ["", "1y", "w", "1000d", "-1d", "1 d", "1d "]) expect(parseRecur(bad), bad).toBeNull();
  });
  it("tells a zero interval from a rule that moves", () => {
    expect(isParsableRecur("0d")).toBe(true);
    expect(isValidRecur("0d")).toBe(false);
    expect(isValidRecur("1m")).toBe(true);
    expect(isValidRecur("1y")).toBe(false);
  });
});

describe("advanceDate / nextDueAfter", () => {
  it("steps by the unit", () => {
    expect(advanceDate("2026-10-20", "1d")).toBe("2026-10-21");
    expect(advanceDate("2026-10-20", "2w")).toBe("2026-11-03");
    expect(advanceDate("2026-01-31", "1m")).toBe("2026-02-28");
    expect(() => advanceDate("2026-10-20", "1y")).toThrow();
  });
  it("lands strictly after today, however stale the chain", () => {
    expect(nextDueAfter("2026-01-01", "1w", "2026-10-27")).toBe("2026-10-29");
  });
});

describe("nextOccurrenceDate", () => {
  const today = "2026-10-27";
  it("fixed follows the schedule, after counts from today", () => {
    expect(nextOccurrenceDate({ recur: "1w", recurMode: "fixed", when: "2026-10-20" }, today)).toBe("2026-11-03");
    expect(nextOccurrenceDate({ recur: "1w", recurMode: "fixed", when: "2026-11-10" }, today)).toBe("2026-11-17");
    expect(nextOccurrenceDate({ recur: "4d", recurMode: "after", when: "2026-10-01" }, today)).toBe("2026-10-31");
  });
  it("mints nothing without a schedule or a moving rule", () => {
    expect(nextOccurrenceDate({ recur: "1w", recurMode: "fixed", when: null }, today)).toBeNull();
    expect(nextOccurrenceDate({ recur: "0d", recurMode: "fixed", when: "2026-10-01" }, today)).toBeNull();
    expect(nextOccurrenceDate({ recur: "1y", recurMode: "after", when: null }, today)).toBeNull();
    expect(nextOccurrenceDate({ recur: null, recurMode: "fixed", when: "2026-10-01" }, today)).toBeNull();
  });
});

describe("monthly recurrence anchor", () => {
  it("a stale chain returns to the original day after a short month", () => {
    expect(nextDueAfter("2026-01-31", "1m", "2026-02-28")).toBe("2026-03-31");
    expect(nextDueAfter("2026-01-31", "1m", "2026-03-31")).toBe("2026-04-30");
  });
  // Known gap: a minted occurrence stores only its own day, so the 31st anchor is lost
  // between two completions (1/31 → 2/28, then 2/28 → 3/28). Needs a stored anchor day.
  it.fails("completing one occurrence at a time keeps the 31st", () => {
    const second = nextOccurrenceDate({ recur: "1m", recurMode: "fixed", when: "2026-01-31" }, "2026-02-01");
    expect(second).toBe("2026-02-28");
    expect(nextOccurrenceDate({ recur: "1m", recurMode: "fixed", when: second }, "2026-03-01")).toBe("2026-03-31");
  });
  it("property: valid days, strictly after today, and every slot is the anchor plus k intervals", () => {
    const day = fc.integer({ min: 0, max: 365 * 6 }).map((n) => addDays("2024-01-01", n));
    fc.assert(
      fc.property(day, day, fc.integer({ min: 1, max: 14 }), (due, today, n) => {
        const next = nextDueAfter(due, `${n}m`, today);
        expect(isCalendarDay(next)).toBe(true);
        expect(next > today).toBe(true);
        expect(next > due).toBe(true);
        const k = Array.from({ length: 1000 }, (_, i) => i + 1).find((i) => addMonths(due, n * i) === next);
        expect(k).toBeDefined();
        // the slot before it is not after today
        if (k! > 1) expect(addMonths(due, n * (k! - 1)) <= today).toBe(true);
      }),
    );
  });
});
