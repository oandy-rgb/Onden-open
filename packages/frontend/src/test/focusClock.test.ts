// The focus timer's arithmetic and words: the clock is read off the record's
// start and the length (never a count of ticks), and the sentences say plainly
// what happened. Also the day-timeline blocks a focus record becomes.
import { describe, it, expect, vi } from "vitest";
import { focusDayItems, focusElapsedMs, focusRemainingMs, formatFocusClock, focusLengthChoices, parseFocusMinutes } from "../lib/focus";
import { focusBigClock, focusClockText, focusLengthLabel, focusWrittenMessage } from "../lib/focus";

vi.mock("../lib/localDate", async (original) => ({ ...await original<typeof import("../lib/localDate")>(), dateIdAt: () => "2026-10-31" }));

const START = "2026-10-31T09:00:00.000Z";
const at = (minutes: number, seconds = 0) => Date.parse(START) + minutes * 60_000 + seconds * 1000;

describe("the clock", () => {
  it("counts down from the start time plus the length, whatever happened in between", () => {
    expect(focusRemainingMs(START, 25, at(0))).toBe(25 * 60_000);
    expect(focusRemainingMs(START, 25, at(12, 30))).toBe(12.5 * 60_000);
    expect(focusRemainingMs(START, 25, at(30))).toBe(-5 * 60_000); // negative once over, never stuck at 0
  });
  it("has no end without a length: it counts up", () => {
    expect(focusRemainingMs(START, 0, at(40))).toBeNull();
    expect(focusElapsedMs(START, at(40))).toBe(40 * 60_000);
    expect(focusElapsedMs(START, at(-5))).toBe(0); // a clock a little behind the record never shows negative time
  });
  it("writes minutes and seconds, hours past an hour", () => {
    expect(formatFocusClock(12.5 * 60_000)).toBe("12:30");
    expect(formatFocusClock(65 * 60_000 + 5000)).toBe("1:05:05");
    expect(formatFocusClock(999, "up")).toBe("0:01"); // the last second is not shown as 0:00 before it is over
    expect(formatFocusClock(-5)).toBe("0:00");
  });
  it("reads only the lengths on offer from a stored value", () => {
    expect([15, 25, 50, 0].map(parseFocusMinutes)).toEqual([15, 25, 50, 0]);
    // A length of one's own is any whole number of minutes up to four hours.
    expect([40, 240].map(parseFocusMinutes)).toEqual([40, 240]);
    expect([241, 12.5, -1, "25", null, undefined].map(parseFocusMinutes)).toEqual([null, null, null, null, null, null]);
    expect(focusLengthChoices(25)).toEqual([15, 25, 50, 0]);
    expect(focusLengthChoices(40)).toEqual([15, 25, 40, 50, 0]);
    expect(focusLengthChoices(0)).toEqual([15, 25, 50, 0]);
  });
});

describe("the words", () => {
  it("says 剩 / 已過 / 時間到 and never an id or milliseconds", () => {
    expect(focusClockText(START, 25, at(12, 30))).toBe("12:30 left");
    expect(focusClockText(START, 0, at(12, 30))).toBe("12:30 so far");
    expect(focusClockText(START, 25, at(26))).toBe("Time is up");
    expect(focusBigClock(START, 25, at(26))).toBe("0:00");
    expect(focusLengthLabel(25)).toBe("25 min");
    expect(focusLengthLabel(0)).toBe("No timer");
  });
  it("tells the person where the sentence landed", () => {
    const asked = { note: true, diary: true, task: true };
    expect(focusWrittenMessage(asked, { diary: true, task: true })).toBe("Focus ended. Your sentence is in today's journal and under the task.");
    expect(focusWrittenMessage(asked, { diary: true, task: false })).toContain("is in today's journal.");
    expect(focusWrittenMessage(asked, { diary: true, task: false })).toContain("The other place could not be written.");
    expect(focusWrittenMessage(asked, { diary: false, task: false })).toContain("could not be written");
    expect(focusWrittenMessage({ note: true, diary: false, task: false }, { diary: false, task: false })).toBe("Focus ended.");
    expect(focusWrittenMessage({ note: false, diary: true, task: true }, { diary: false, task: false })).toBe("Focus ended.");
  });
});

describe("a day's focus blocks", () => {
  const done = { id: "f1", task_id: "t1", started_at: START, ended_at: "2026-10-31T09:25:00.000Z", note: "寫完第二段" };
  const running = { id: "f2", task_id: null, started_at: "2026-10-31T10:00:00.000Z", ended_at: null, note: "" };
  it("a finished one spans its time and carries the sentence; the running one reaches now and is live", () => {
    const items = focusDayItems("2026-10-31", [done], running, (id) => (id === "t1" ? "交報告" : undefined), Date.parse("2026-10-31T10:20:00Z"));
    expect(items[0]).toMatchObject({ kind: "focus", title: "交報告", detail: "寫完第二段", at: done.started_at, until: done.ended_at, past: true, ref: { type: "task", id: "t1" } });
    expect(items[1]).toMatchObject({ kind: "focus", title: "", live: true, until: "2026-10-31T10:20:00.000Z", past: false, ref: null });
  });
  it("lists the running record once, even when the day's list already has it", () => {
    expect(focusDayItems("2026-10-31", [running], running, () => undefined, Date.parse("2026-10-31T10:20:00Z"))).toHaveLength(1);
  });
});
