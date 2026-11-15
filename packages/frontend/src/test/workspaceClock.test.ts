import { setLocalePref } from "../lib/i18n";
// The workspace's day on the client (lib/localDate): the zone and the hour a day
// starts at come from the workspace (Settings › Time), so "today", a timestamp's
// day and History's end of a day follow them — the way the server cuts days
// (backend localDay.ts). An instant before the start hour belongs to the day before.
import { beforeEach, describe, expect, it } from "vitest";
import { noWorkspaceData } from "../lib/api";
import { resetAppState, setData } from "../lib/appStore";
import { dateIdAt, todayId, workspaceDayStartHour, workspaceTimeZone } from "../lib/localDate";
import { dayOnClock, formatOffset, workspaceZoneOf, zoneLabel, zoneName, zoneOffsetMinutes } from "../lib/workspaceTime";

beforeEach(() => resetAppState({ data: noWorkspaceData }));

const withWorkspace = (workspace: Partial<typeof noWorkspaceData.workspace>, timezone?: string) =>
  setData((d) => ({ ...d, timezone, workspace: { ...d.workspace, ...workspace } }));

describe("which zone the workspace's days follow", () => {
  it("the owner's choice first, then the server's, then nothing (the browser's)", () => {
    expect(workspaceZoneOf({ workspace: { time_zone: "Asia/Tokyo" }, timezone: "Asia/Taipei" })).toBe("Asia/Tokyo");
    expect(workspaceZoneOf({ workspace: { time_zone: null }, timezone: "Asia/Taipei" })).toBe("Asia/Taipei");
    expect(workspaceZoneOf({ workspace: { time_zone: null } })).toBeUndefined();
  });

  it("the store feeds todayId: a changed workspace row changes today at once", () => {
    const at = new Date("2026-10-26T17:00:00Z");
    withWorkspace({ time_zone: "UTC" });
    expect(workspaceTimeZone()).toBe("UTC");
    expect(todayId(at)).toBe("2026-10-26");
    withWorkspace({ time_zone: "Asia/Taipei" }); // what a sync delta does on another open device
    expect(todayId(at)).toBe("2026-10-27");
    expect(todayId(at)).toBe("2026-10-27");
  });
});

describe("the hour a day starts at", () => {
  it("keeps the small hours in the day before, in every date helper", () => {
    withWorkspace({ time_zone: "Asia/Taipei", day_start_hour: 4 });
    expect(workspaceDayStartHour()).toBe(4);
    expect(todayId(new Date("2026-10-26T19:59:59Z"))).toBe("2026-10-26"); // 03:59:59 on the 27th
    expect(todayId(new Date("2026-10-26T20:00:00Z"))).toBe("2026-10-27"); // 04:00
    expect(dateIdAt(new Date("2026-10-26T18:00:00Z"))).toBe("2026-10-26"); // a timestamp at 02:00
  });

  it("is a plain calendar day when the workspace has none (an older server or copy)", () => {
    withWorkspace({ time_zone: "Asia/Taipei" });
    expect(workspaceDayStartHour()).toBe(0);
    expect(todayId(new Date("2026-10-26T18:00:00Z"))).toBe("2026-10-27");
  });

  it("ignores a value outside 0–6", () => {
    withWorkspace({ time_zone: "UTC", day_start_hour: 9 });
    expect(workspaceDayStartHour()).toBe(0);
  });
});

describe("zones in plain words", () => {
  it("shows the offset with the name, half hours included", () => {
    expect(formatOffset(480)).toBe("UTC+8");
    expect(formatOffset(330)).toBe("UTC+5:30");
    expect(formatOffset(-180)).toBe("UTC-3");
    expect(formatOffset(0)).toBe("UTC");
    const at = new Date("2026-10-26T00:00:00Z");
    expect(zoneOffsetMinutes("Asia/Taipei", at)).toBe(480);
    expect(zoneOffsetMinutes("Asia/Kolkata", at)).toBe(330);
    expect(zoneLabel("Asia/Taipei", at)).toBe("Taipei（UTC+8）");
    expect(zoneName("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
  });

  it("tells apart zones that share a generic name in Chinese: the city comes first", () => {
    setLocalePref("zh-TW");
    try {
      expect(zoneName("Asia/Taipei")).toBe("台北");
      const a = zoneName("Africa/Abidjan");
      const b = zoneName("Africa/Accra");
      expect(a).not.toBe(b);
      expect(a.startsWith("Abidjan")).toBe(true);
    } finally {
      setLocalePref("system");
    }
  });

  it("names a common zone whichever way the browser spells it (Kolkata is Calcutta in Chrome)", () => {
    setLocalePref("zh-TW");
    try {
      expect(zoneName("Asia/Kolkata")).toBe("印度");
      expect(zoneName("Asia/Calcutta")).toBe("印度");
      expect(zoneName("Asia/Ho_Chi_Minh")).toBe("胡志明市");
      expect(zoneName("Asia/Saigon")).toBe("胡志明市");
    } finally {
      setLocalePref("system");
    }
  });
});

describe("the day on a clock", () => {
  it("a day-start hour keeps early-morning hours on the day before", () => {
    expect(dayOnClock(new Date("2026-10-26T02:00:00Z"), "UTC", 4)).toBe("2026-10-25");
  });
});
