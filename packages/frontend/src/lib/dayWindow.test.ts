import { describe, expect, it } from "vitest";
import { clockInstant, clockLabel, dayWindow } from "./dayWindow";

const hours = (w: { startMs: number; endMs: number }) => (w.endMs - w.startMs) / 3_600_000;

describe("dayWindow", () => {
  it("is 00:00 to 00:00 of the zone, whatever the viewer's own zone is", () => {
    const taipei = dayWindow("2026-10-30", "Asia/Taipei", 0);
    expect(new Date(taipei.startMs).toISOString()).toBe("2026-10-29T16:00:00.000Z");
    expect(hours(taipei)).toBe(24);
    const la = dayWindow("2026-10-30", "America/Los_Angeles", 0);
    expect(new Date(la.startMs).toISOString()).toBe("2026-10-30T07:00:00.000Z");
  });

  it("starts at the day start hour, not at midnight", () => {
    const w = dayWindow("2026-10-30", "Asia/Taipei", 4);
    expect(new Date(w.startMs).toISOString()).toBe("2026-10-29T20:00:00.000Z"); // 04:00 +08:00
    expect(hours(w)).toBe(24);
  });

  it("is 25 hours when the clocks go back and 23 when they go forward", () => {
    expect(hours(dayWindow("2026-11-01", "America/New_York", 0))).toBe(25);
    expect(hours(dayWindow("2026-03-08", "America/New_York", 0))).toBe(23);
  });
});

describe("clockInstant", () => {
  it("reads a wall-clock time in the workspace zone", () => {
    expect(clockInstant("2026-10-30", "15:00", "Asia/Taipei", 0)).toBe("2026-10-30T07:00:00.000Z");
  });

  it("puts an after-midnight time of a late-starting day on the next calendar date", () => {
    expect(clockInstant("2026-10-30", "01:30", "Asia/Taipei", 4)).toBe("2026-10-30T17:30:00.000Z"); // 31st 01:30 +08:00
    expect(clockInstant("2026-10-30", "04:00", "Asia/Taipei", 4)).toBe("2026-10-29T20:00:00.000Z");
  });

  it("refuses what is not HH:MM", () => {
    expect(clockInstant("2026-10-30", "25:00", "UTC", 0)).toBeNull();
    expect(clockInstant("2026-10-30", "3pm", "UTC", 0)).toBeNull();
  });

  it("round-trips with clockLabel", () => {
    expect(clockLabel(clockInstant("2026-10-30", "15:40", "Europe/Paris", 0)!, "Europe/Paris")).toBe("15:40");
  });
});
