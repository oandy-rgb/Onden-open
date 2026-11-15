// One set of time labels for every activity list, localized with the app UI
// and in the workspace's zone (depth audit D46).
import { describe, it, expect, afterEach } from "vitest";
import { compactWhenLabel, dateLabel, dayIdLabel, dayLabel, monthLabel, nearDayLabel, relTime, timeLabel } from "../lib/timeLabels";
import { setLocalePref } from "../lib/i18n";
import { setWorkspaceTimeZoneSource } from "../lib/localDate";

const now = new Date(2026, 9, 6, 15, 0, 0);
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

// The browser's own zone, as a test can set it: Node re-reads TZ on change.
const originalTz = process.env.TZ;
function browserZone(tz: string | undefined) {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
}

afterEach(() => {
  setLocalePref("en");
  setWorkspaceTimeZoneSource(() => undefined);
  browserZone(originalTz);
});

describe("time labels", () => {
  it("names recent days and follows the UI language", () => {
    setLocalePref("en");
    expect(dayLabel(new Date(2026, 9, 6, 1).toISOString(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 5, 23).toISOString(), now)).toBe("Yesterday");
    setLocalePref("zh-TW");
    expect(dayLabel(new Date(2026, 9, 5, 23).toISOString(), now)).toBe("昨天");
    expect(relTime(ago(5 * 60_000), now.getTime())).toBe("5 分鐘");
  });

  it("floors ages, so an hour label means at least an hour", () => {
    setLocalePref("en");
    expect(relTime(ago(30_000), now.getTime())).toBe("now");
    expect(relTime(ago(59 * 60_000), now.getTime())).toBe("59m");
    expect(relTime(ago(119 * 60_000), now.getTime())).toBe("1h");
    expect(relTime(ago(47 * 3_600_000), now.getTime())).toBe("1d");
    expect(relTime(null)).toBe("");
    expect(relTime("not a date")).toBe("");
  });

  it("relTime speaks the UI language everywhere (the event history copy said 5m in zh-TW)", () => {
    setLocalePref("zh-TW");
    const t0 = Date.parse("2026-10-17T02:00:00Z");
    expect(relTime(new Date(t0 - 5 * 60_000).toISOString(), t0)).toBe("5 分鐘");
    expect(relTime(new Date(t0 - 3 * 3_600_000).toISOString(), t0)).toBe("3 小時");
    expect(relTime(new Date(t0 - 2 * 86_400_000).toISOString(), t0)).toBe("2 天");
    expect(relTime(new Date(t0 - 10_000).toISOString(), t0)).toBe("剛剛");
  });
});

describe("the workspace's day, not the browser's", () => {
  // 23:30 UTC on Oct 16 is 07:30 on Oct 17 in Taipei.
  const late = "2026-10-16T23:30:00Z";
  const morning = new Date("2026-10-17T02:00:00Z"); // 10:00 in Taipei, 02:00 UTC

  it("groups by the workspace zone when the browser sits in another one", () => {
    browserZone("UTC");
    setWorkspaceTimeZoneSource(() => "Asia/Taipei");
    expect(dayLabel(late, morning)).toBe("Today");
    expect(timeLabel(late)).toBe("07:30 AM");
    expect(dateLabel(late, "short")).toBe("Oct 17");
  });

  it("falls back to the browser's zone before the workspace's is known", () => {
    browserZone("UTC");
    expect(dayLabel(late, morning)).toBe("Yesterday");
    expect(timeLabel(late)).toBe("11:30 PM");
    expect(dateLabel(late, "short")).toBe("Oct 16");
  });

  it("an age is the same in every zone", () => {
    browserZone("America/Los_Angeles");
    setWorkspaceTimeZoneSource(() => "Asia/Taipei");
    expect(relTime(late, morning.getTime())).toBe("2h");
  });

  it("shows the year whenever it is not this year (one rule)", () => {
    setWorkspaceTimeZoneSource(() => "Asia/Taipei");
    // Two weeks back, across New Year: the year shows though it is recent.
    expect(dayLabel("2025-12-20T04:00:00Z", new Date("2026-01-05T04:00:00Z"))).toBe("Dec 20, 2025");
    // Earlier this year, more than a week back: no year.
    expect(dayLabel("2026-03-02T04:00:00Z", new Date("2026-10-17T04:00:00Z"))).toBe("Mar 2");
    // The year is the workspace's: 23:30 UTC on Dec 31 is already Jan 1 in Taipei.
    expect(dayLabel("2025-12-31T23:30:00Z", new Date("2026-01-20T04:00:00Z"))).toBe("Jan 1");
    expect(dayLabel("2026-10-12T04:00:00Z", new Date("2026-10-17T04:00:00Z"))).toBe("Monday");
  });

  it("dateLabel shapes follow the UI language; a calendar month needs no zone", () => {
    setWorkspaceTimeZoneSource(() => "Asia/Taipei");
    setLocalePref("zh-TW");
    expect(dateLabel(late, "medium")).toBe("2026年10月17日");
    expect(dateLabel(null)).toBe("");
    expect(dateLabel("garbage")).toBe("");
    browserZone("America/Los_Angeles");
    setLocalePref("en");
    expect(monthLabel(2026, 9)).toBe("October 2026");
  });
});

describe("compactWhenLabel", () => {
  const now = new Date("2026-10-22T08:00:00Z");

  it("today is the clock time, this year month/day, another year the full date", () => {
    expect(compactWhenLabel("2026-10-22T02:06:49Z", now, "UTC")).toBe("02:06");
    expect(compactWhenLabel("2026-10-16T02:06:49Z", now, "UTC")).toBe("10/16");
    expect(compactWhenLabel("2025-10-16T02:06:49Z", now, "UTC")).toBe("10/16/2025");
  });

  it("days are the zone's: just after midnight in the workspace zone is still today there", () => {
    expect(compactWhenLabel("2026-10-21T17:30:00Z", new Date("2026-10-21T20:00:00Z"), "Asia/Taipei")).toBe("01:30");
    expect(compactWhenLabel("2026-10-21T17:30:00Z", new Date("2026-10-21T10:00:00Z"), "UTC")).toBe("17:30");
  });

  it("is empty without a usable time", () => {
    expect(compactWhenLabel(null, now, "UTC")).toBe("");
    expect(compactWhenLabel("nope", now, "UTC")).toBe("");
  });
});

describe("nearDayLabel", () => {
  it("leaves the year out for a day of this year and writes it for another year", () => {
    setLocalePref("zh-TW");
    expect(nearDayLabel("2026-11-05", "2026-01-02")).toBe(dayIdLabel("2026-11-05", "monthDay"));
    expect(nearDayLabel("2025-11-05", "2026-01-02")).toBe(dayIdLabel("2025-11-05", "numeric"));
    expect(nearDayLabel("2025-11-05", "2026-01-02")).toContain("2025");
    expect(nearDayLabel("2026-11-05", "2026-01-02")).not.toContain("2026");
  });
});
