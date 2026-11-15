// The cycle's pure rules: which break follows round N, how much of a break is left, what a run adds up to.
import { describe, it, expect } from "vitest";
import { parseFocusCycle } from "../lib/focus/focusCycle";
import { LONG_BREAK_MINUTES, breakAfter, breakRemainingMs, enterBreak, runSummary } from "../lib/focus/focusCycleRules";
import { parseFocusRun, startRun } from "../lib/focus/focusRunSteps";
import { breakStartedMessage, focusCycleLabel, focusRoundSub, runSummaryText } from "../lib/focus/focusCycleText";

const cycle = { rest: 5, longEvery: 4 };

describe("which break follows a round", () => {
  it("every fourth round gets the long break, the others the short one", () => {
    expect([1, 2, 3, 4, 5, 8].map((round) => breakAfter(round, cycle))).toEqual([
      { kind: "short", minutes: 5 }, { kind: "short", minutes: 5 }, { kind: "short", minutes: 5 },
      { kind: "long", minutes: LONG_BREAK_MINUTES }, { kind: "short", minutes: 5 }, { kind: "long", minutes: LONG_BREAK_MINUTES },
    ]);
  });
  it("longEvery 0 never has a long break", () => {
    for (const round of [1, 4, 12, 100]) expect(breakAfter(round, { rest: 10, longEvery: 0 })).toEqual({ kind: "short", minutes: 10 });
  });
  it("the long break is fifteen minutes", () => expect(LONG_BREAK_MINUTES).toBe(15));
});

describe("the break clock", () => {
  it("is read off the start instant, negative once over", () => {
    const at = "2026-10-31T09:25:00.000Z";
    expect(breakRemainingMs(at, 5, Date.parse(at) + 60_000)).toBe(4 * 60_000);
    expect(breakRemainingMs(at, 5, Date.parse(at) + 6 * 60_000)).toBe(-60_000);
  });
  it("a break begins where the round's time was up", () => {
    const run = enterBreak(startRun("f1", 25, cycle), "2026-10-31T09:00:00.000Z");
    expect(run).toMatchObject({ phase: "break", endedAt: "2026-10-31T09:25:00.000Z", restStartedAt: "2026-10-31T09:25:00.000Z" });
  });
});

describe("what a run adds up to", () => {
  it("counts the rounds' real lengths and leaves the breaks out", () => {
    expect(runSummary([25, 25], 25)).toEqual({ rounds: 3, minutes: 75 });
    expect(runSummary([25, 25], null)).toEqual({ rounds: 2, minutes: 50 });
    expect(runSummary([], 10)).toEqual({ rounds: 1, minutes: 10 });
  });
});

describe("reading a stored value back", () => {
  it("accepts a cycle inside the bounds and nothing else", () => {
    expect(parseFocusCycle({ rest: 1, longEvery: 0 })).toEqual({ rest: 1, longEvery: 0 });
    expect(parseFocusCycle({ rest: 60, longEvery: 12 })).toEqual({ rest: 60, longEvery: 12 });
    for (const bad of [null, 5, { rest: 0, longEvery: 4 }, { rest: 61, longEvery: 4 }, { rest: 5, longEvery: 13 }, { rest: 5.5, longEvery: 4 }, { rest: 5 }, "x"]) expect(parseFocusCycle(bad), JSON.stringify(bad)).toBeNull();
  });
  it("a run survives its round trip, and a damaged one is dropped", () => {
    const run = enterBreak(startRun("f1", 25, cycle), "2026-10-31T09:00:00.000Z");
    expect(parseFocusRun(JSON.parse(JSON.stringify(run)))).toEqual(run);
    expect(parseFocusRun({ ...run, phase: "later" })).toBeNull();
    expect(parseFocusRun({ ...run, restStartedAt: null })).toBeNull();
    expect(parseFocusRun({ ...run, cycle: { rest: 0, longEvery: 1 } })).toBeNull();
    expect(parseFocusRun(null)).toBeNull();
  });
});

describe("its words carry no ids or raw times", () => {
  it("says the cycle, the round, the break and the run in plain sentences", () => {
    expect(focusCycleLabel(cycle)).toBe("Break 5 min · long break 15 min every 4 rounds");
    expect(focusCycleLabel({ rest: 10, longEvery: 0 })).toBe("Break 10 min");
    expect(focusRoundSub(25, 1, cycle)).toBe("25 min, then a break of 5 min");
    expect(focusRoundSub(25, 4, cycle)).toBe("25 min, then a long break of 15 min");
    expect(breakStartedMessage("long", 15)).toBe("Time is up. Long break for 15 min.");
    expect(runSummaryText({ rounds: 1, minutes: 25 })).toBe("1 round, 25 min focused in all");
    expect(runSummaryText({ rounds: 3, minutes: 75 })).toBe("3 rounds, 75 min focused in all");
  });
});
