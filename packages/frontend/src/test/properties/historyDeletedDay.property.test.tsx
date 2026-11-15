// Property (scan 15, M1): the day "Recently deleted" shows for a deletion is the
// workspace's calendar day of that instant, whatever the zone — never the UTC
// day of the ISO string. Any zone, any instant within the last 60 hours (so
// "today", "yesterday" and a date label all come up); the expected label is
// worked out with Intl in the zone, not with the app's own helpers.
// Seed and run count from PROPS_SEED / PROPS_RUNS.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { WorkspaceHistory } from "../../components/history";
import { monthDay } from "../../components/history/WorkspaceHistoryChart";
import * as historyApi from "../../lib/history/workspaceHistoryApi";
import { setWorkspaceTimeZoneSource } from "../../lib/localDate";
import { setLocalePref } from "../../lib/i18n";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";
import { activityFixture, feedFixture } from "../workspaceHistoryFixtures";

vi.mock("../../lib/accountSession", () => ({ useAccountSession: () => null }));
vi.mock("../../lib/history/workspaceHistoryApi", async (original) => ({
  ...await original<typeof import("../../lib/history/workspaceHistoryApi")>(),
  fetchActivity: vi.fn(), fetchFeed: vi.fn(), fetchDeleted: vi.fn(),
}));
vi.mock("../../lib/data", async (original) => ({
  ...await original<typeof import("../../lib/data")>(),
  nodeMutations: { undeleteNode: vi.fn() },
  historyWriter: {},
}));

const api = vi.mocked(historyApi);
const ZONES = ["UTC", "Asia/Taipei", "Asia/Kolkata", "America/New_York", "America/Sao_Paulo", "Pacific/Auckland", "Pacific/Apia", "Australia/Lord_Howe"];

const dayIn = (at: Date, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
const dayBefore = (id: string) => { const d = new Date(`${id}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

afterEach(() => { cleanup(); setWorkspaceTimeZoneSource(() => undefined); setLocalePref("system"); });

async function labelFor(zone: string, hoursAgo: number) {
  setWorkspaceTimeZoneSource(() => zone);
  setLocalePref("zh-TW");
  const now = new Date();
  const deleted = new Date(now.getTime() - hoursAgo * 3_600_000);
  api.fetchActivity.mockResolvedValue(activityFixture());
  api.fetchFeed.mockResolvedValue(feedFixture());
  api.fetchDeleted.mockResolvedValue({ notes: [{ id: "d1", title: "測試", deleted_at: deleted.toISOString(), blank: false, space_id: null }], older_cursor: null });
  render(<WorkspaceHistory online onOpenNote={vi.fn()} onOpenNoteHistory={vi.fn()} onOpenInbox={vi.fn()} />);
  fireEvent.click(await screen.findByRole("tab", { name: "最近刪除" }));
  await screen.findByText("測試");
  const row = document.querySelector(".wh-deleted-row")!.textContent ?? "";
  const today = dayIn(now, zone);
  const day = dayIn(deleted, zone);
  const expected = day === today ? "今天" : day === dayBefore(today) ? "昨天" : monthDay(day);
  return { row, expected };
}

describe("recently deleted: the day label", () => {
  it("is the workspace's day of the deletion, in any zone", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom(...ZONES), fc.integer({ min: 0, max: 60 * 60 }), async (zone, minutesAgo) => {
      const { row, expected } = await labelFor(zone, minutesAgo / 60);
      expect(row, `${zone}, ${minutesAgo} minutes ago`).toContain(expected);
      cleanup();
    }), { seed: PROPS_SEED, numRuns: Math.min(PROPS_RUNS, 25) });
  }, 120_000);

  it("M1: 00:30 on the workspace's day in Taipei is today, not yesterday", async () => {
    const now = new Date();
    const taipeiToday = dayIn(now, "Asia/Taipei");
    const hours = (now.getTime() - new Date(`${taipeiToday}T00:30:00+08:00`).getTime()) / 3_600_000;
    const { row } = await labelFor("Asia/Taipei", Math.max(hours, 0));
    expect(row).toContain("今天");
  });
});
