// The server's calendar day (localDay.ts): "today" turns over at midnight in
// the workspace clock (ONDEN_TIMEZONE is its default). It used to be the UTC date everywhere, so in Taipei a task
// completed at 07:00 rolled its recurrence from yesterday and the review
// budget's new day began at 08:00.
import { afterEach, describe, expect, it, vi } from "vitest";

async function load<T>(zone: string, path: string): Promise<T> {
  vi.resetModules();
  vi.stubEnv("ONDEN_TIMEZONE", zone);
  return import(path) as Promise<T>;
}

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("dayStartInstant", () => {
  it("is the first instant of the workspace day, in its zone and across a daylight-saving change", async () => {
    const { dayStartInstant, localDayId, setDayClock } = await load<typeof import("../localDay.js")>("Asia/Taipei", "../localDay.js");
    expect(dayStartInstant("2026-11-14").toISOString()).toBe("2026-11-13T16:00:00.000Z");
    setDayClock({ timeZone: "America/New_York", dayStartHour: 0 });
    expect(dayStartInstant("2026-11-01").toISOString()).toBe("2026-11-01T04:00:00.000Z"); // still daylight time that midnight
    expect(dayStartInstant("2026-11-02").toISOString()).toBe("2026-11-02T05:00:00.000Z"); // the day after the clocks went back
    setDayClock({ timeZone: "Asia/Taipei", dayStartHour: 4 });
    const start = dayStartInstant("2026-11-14");
    expect(start.toISOString()).toBe("2026-11-13T20:00:00.000Z");
    expect(localDayId(start)).toBe("2026-11-14");
    expect(localDayId(new Date(start.getTime() - 1))).toBe("2026-11-13");
  });
});

describe("localDayId", () => {
  it("turns the day over at local midnight in ONDEN_TIMEZONE", async () => {
    const { localDayId } = await load<typeof import("../localDay.js")>("Asia/Taipei", "../localDay.js");
    expect(localDayId(new Date("2026-10-12T15:59:59Z"))).toBe("2026-10-12"); // 23:59:59 in Taipei
    expect(localDayId(new Date("2026-10-12T16:00:00Z"))).toBe("2026-10-13"); // midnight in Taipei
  });

  it("keeps UTC when it is not set", async () => {
    const { localDayId, workspaceTimeZone } = await load<typeof import("../localDay.js")>("", "../localDay.js");
    expect(workspaceTimeZone()).toBe("UTC");
    expect(localDayId(new Date("2026-10-12T23:30:00Z"))).toBe("2026-10-12");
  });

  it("refuses an unknown zone at startup instead of running on UTC", async () => {
    await expect(load("Mars/Olympus", "../localDay.js")).rejects.toThrow(RangeError);
  });

  it("a day start hour keeps the small hours in the day before", async () => {
    const { localDayId, setDayClock } = await load<typeof import("../localDay.js")>("", "../localDay.js");
    setDayClock({ timeZone: "Asia/Taipei", dayStartHour: 4 });
    expect(localDayId(new Date("2026-10-12T19:59:59Z"))).toBe("2026-10-12"); // 03:59:59 on the 13th in Taipei
    expect(localDayId(new Date("2026-10-12T20:00:00Z"))).toBe("2026-10-13"); // 04:00
    expect(localDayId(new Date("2026-10-12T15:59:59Z"))).toBe("2026-10-12"); // 23:59:59 on the 12th
  });

  it("follows a changed clock at once, with no restart", async () => {
    const { localDayId, setDayClock } = await load<typeof import("../localDay.js")>("", "../localDay.js");
    const at = new Date("2026-10-12T20:00:00Z");
    expect(localDayId(at)).toBe("2026-10-12");
    setDayClock({ timeZone: "Asia/Taipei", dayStartHour: 0 });
    expect(localDayId(at)).toBe("2026-10-13");
    setDayClock({ timeZone: "America/Los_Angeles", dayStartHour: 0 });
    expect(localDayId(at)).toBe("2026-10-12");
  });

  it("refuses a zone name or start hour it cannot use", async () => {
    const { setDayClock, isValidTimeZone } = await load<typeof import("../localDay.js")>("", "../localDay.js");
    expect(() => setDayClock({ timeZone: "Mars/Olympus", dayStartHour: 0 })).toThrow();
    expect(() => setDayClock({ timeZone: "UTC'; DROP TABLE x;--", dayStartHour: 0 })).toThrow();
    expect(() => setDayClock({ timeZone: "UTC", dayStartHour: 7 })).toThrow();
    expect(() => setDayClock({ timeZone: "UTC", dayStartHour: 1.5 })).toThrow();
    expect(isValidTimeZone("Asia/Taipei")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("taipei")).toBe(false);
  });

  // Loads the whole review route module afresh, which takes a few seconds.
  it("the review cap's day is the local one", { timeout: 60_000 }, async () => {
    const { reviewedToday } = await load<typeof import("../modules/review/service.js")>("Asia/Taipei", "../modules/review/service.js");
    // Graded at 01:00 in Taipei on the 13th — the 12th in UTC.
    const at = "2026-10-12T17:00:00.000Z";
    const card = { node_id: "c", title: "", markdown: "", ink_data: null, parent_id: null, block: null, created_at: "", module_tag_ids: [] as string[],
      state: { state: "review" as const, due: at, stability: 1, difficulty: 5, reps: 1, lapses: 0, last_review: at, introduced_at: at } };
    expect(reviewedToday([card], new Date("2026-10-13T01:00:00Z"))).toBe(1);
    expect(reviewedToday([card], new Date("2026-10-12T15:00:00Z"))).toBe(0);
  });
});
