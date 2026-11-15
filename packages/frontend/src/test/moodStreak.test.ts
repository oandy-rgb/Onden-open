import { describe, it, expect } from "vitest";
import {
  MOODS,
  MOOD_ATTR_KEY,
  isMoodValue,
  shiftDateId,
  computeDayStreak,
} from "../lib/moodStreak";

// Build a day-node-shaped object (title === ISO date) from an id.
const day = (id: string, hidden = false) => ({ title: id, slug: id, hidden });

describe("mood constants", () => {
  it("exposes a stable attribute key and a 1–5 emoji scale", () => {
    expect(MOOD_ATTR_KEY).toBe("mood");
    expect(MOODS).toHaveLength(5);
    expect(new Set(MOODS.map((m) => m.value)).size).toBe(5); // all distinct
  });

  it("isMoodValue gates arbitrary input", () => {
    expect(isMoodValue(MOODS[0].value)).toBe(true);
    expect(isMoodValue("not-an-emoji")).toBe(false);
    expect(isMoodValue(null)).toBe(false);
    expect(isMoodValue(undefined)).toBe(false);
  });
});

describe("shiftDateId", () => {
  it("steps a local date id back and forward across month boundaries", () => {
    expect(shiftDateId("2026-06-13", -1)).toBe("2026-06-12");
    expect(shiftDateId("2026-06-01", -1)).toBe("2026-05-31");
    expect(shiftDateId("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("handles leap-day arithmetic", () => {
    expect(shiftDateId("2024-03-01", -1)).toBe("2024-02-29"); // leap year
    expect(shiftDateId("2025-03-01", -1)).toBe("2025-02-28"); // non-leap
  });
});

describe("computeDayStreak", () => {
  // Anchor "now" at a fixed local day so the test is deterministic.
  const now = new Date(2026, 5, 13); // local 2026-06-13

  it("is zero with no day notes", () => {
    expect(computeDayStreak([], now)).toBe(0);
  });

  it("counts consecutive days ending today", () => {
    const nodes = [day("2026-06-13"), day("2026-06-12"), day("2026-06-11")];
    expect(computeDayStreak(nodes, now)).toBe(3);
  });

  it("keeps the chain alive when only yesterday is written (today not yet)", () => {
    const nodes = [day("2026-06-12"), day("2026-06-11")];
    expect(computeDayStreak(nodes, now)).toBe(2);
  });

  it("is broken when the most recent note is two days ago", () => {
    const nodes = [day("2026-06-11"), day("2026-06-10")];
    expect(computeDayStreak(nodes, now)).toBe(0);
  });

  it("stops at the first gap", () => {
    // today, yesterday written; then a gap at -2; then more — streak is 2.
    const nodes = [day("2026-06-13"), day("2026-06-12"), day("2026-06-10"), day("2026-06-09")];
    expect(computeDayStreak(nodes, now)).toBe(2);
  });

  it("ignores hidden day notes and non-day notes", () => {
    const nodes = [
      day("2026-06-13"),
      day("2026-06-12", true),               // hidden → not counted, breaks chain
      { title: "Project Apollo", slug: "x" }, // ordinary note
    ];
    expect(computeDayStreak(nodes, now)).toBe(1);
  });

  it("does not double-count a date present by both title and slug", () => {
    const nodes = [
      { title: "2026-06-13", slug: "2026-06-13" },
      { title: "Renamed", slug: "2026-06-12" },
    ];
    expect(computeDayStreak(nodes, now)).toBe(2);
  });
});
