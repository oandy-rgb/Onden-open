// The RSS reader's memory follows the account
// (lib/accountPrefStore, modules/rss/rssPrefs):
// each is saved to the server, the old this-device value moves up once, the
// server's own value is never overwritten by an old local one, a value that
// only moves forward (last visit) keeps the newer, and another device
// sees what this one did.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

let serverPrefs: Record<string, unknown> = {};
const sendWrite = vi.hoisted(() => vi.fn());
vi.mock("../lib/data/onlineWrite", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/data/onlineWrite")>(), sendWrite }));
vi.mock("../lib/data/reads", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/data/reads")>();
  return { ...real, reads: { ...real.reads, people: { ...real.reads.people, myPref: vi.fn(async (key: string) => ({ value: serverPrefs[key] ?? null })) } } };
});

import {
  forgetRssPrefs, parseFeedCounts, parseLastVisit, parseReadingPositions, parseShowCounts,
  rssFeedCountsPref, rssLastVisitPref, rssReadingPositionPref, rssShowCountsPref, MAX_VIEWS,
} from "../modules/rss/rssPrefs";
import { SHOW_COUNTS_SETTING, setFeedCountChoice } from "../modules/rss/rssCounts";
import { readingPosition, rememberPosition } from "../modules/rss/readingPosition";
import { markRssVisited, refreshRssUnread, useRssUnread } from "../modules/rss/useRssUnread";
import { useOption } from "../settings/useOption";
import { SETTINGS, TABS } from "../settings/registry";
import { MODULE_SETTINGS } from "../modules";
import { bindAccountStorage } from "../lib/accountStorage";
import { getPref, PREFS, setPref } from "../lib/prefs";

const puts = (key: string) => sendWrite.mock.calls.filter(([m, p]) => m === "PUT" && p === `/api/me/prefs/${key}`).map(([, , body]) => body.value);

beforeEach(() => {
  localStorage.clear();
  serverPrefs = {};
  // Like services/actorPrefs writePref: a "moves forward" key refuses a value behind the stored one.
  const order: Record<string, (value: unknown) => number> = {
    rssLastVisit: (v) => Date.parse(v as string),
  };
  sendWrite.mockReset().mockImplementation(async (_m: string, path: string, body: { value: unknown; editedAt?: number; editAgeMs?: number }) => {
    const key = path.split("/").pop()!;
    const current = serverPrefs[key] ?? null;
    if ((body.editedAt !== undefined || body.editAgeMs !== undefined) && body.value !== null && current !== null && order[key] && order[key](current) > order[key](body.value)) {
      return { value: current, applied: false };
    }
    serverPrefs[key] = body.value;
    return { value: body.value, applied: true };
  });
  bindAccountStorage("account-prefs-test", "");
  forgetRssPrefs();
});
afterEach(() => { vi.useRealTimers(); });

describe("reading what is stored", () => {
  it("keeps the right shapes and refuses the rest", () => {
    expect(parseShowCounts(true)).toBe(true);
    expect(parseShowCounts("true")).toBeNull();
    expect(parseFeedCounts({ a: "on", b: "off", c: "maybe", "": "on" })).toEqual({ a: "on", b: "off" });
    expect(parseFeedCounts(["a"])).toBeNull();
    expect(parseLastVisit("2026-10-26T08:00:00.000Z")).toBe("2026-10-26T08:00:00.000Z");
    for (const bad of ["yesterday", "", 5, null]) expect(parseLastVisit(bad)).toBeNull();
    expect(parseReadingPositions({ all: { id: "i1" }, s1: { id: "" }, s2: 3 })).toEqual({ all: { id: "i1", open: false } });
  });
});

describe("saving to the account", () => {
  it("sends each change and keeps the person's own value on the page", async () => {
    rssShowCountsPref.store.save(true);
    setFeedCountChoice("f1", "on");
    setFeedCountChoice("f2", "off");
    setFeedCountChoice("f1", null);
    await waitFor(() => expect(serverPrefs.rssFeedCounts).toEqual({ f2: "off" }));
    expect(serverPrefs.rssShowCounts).toBe(true);
    expect(rssFeedCountsPref.store.get()).toMatchObject({ value: { f2: "off" }, dirty: false });
  });

  it("「顯示未讀數字」 is the account's: another device's choice reaches the setting", async () => {
    serverPrefs.rssShowCounts = true;
    const { result } = renderHook(() => ({ option: useOption(SHOW_COUNTS_SETTING), keep: rssShowCountsPref.useKeepInSync() }));
    await waitFor(() => expect(result.current.option[0]).toBe(true));
    act(() => result.current.option[1](false));
    await waitFor(() => expect(serverPrefs.rssShowCounts).toBe(false));
  });
});

describe("the edit time the server is told", () => {
  it("is how long ago the edit was made, measured at each send, not the device clock", async () => {
    vi.useFakeTimers();
    // A device whose clock is 10 minutes fast: only the age may reach the server.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    const bodies = () => sendWrite.mock.calls.filter(([, p]) => p === "/api/me/prefs/rssShowCounts").map(([, , body]) => body);
    sendWrite.mockRejectedValueOnce(new Error("offline"));
    rssShowCountsPref.store.save(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(rssShowCountsPref.store.get().dirty).toBe(true);
    expect(bodies()[0]).toMatchObject({ value: true, editAgeMs: 0 });
    expect(bodies()[0]).not.toHaveProperty("editedAt");
    // Back online 30 s later: the resend measures the age again.
    vi.setSystemTime(Date.now() + 30_000);
    await rssShowCountsPref.store.sync();
    expect(bodies()[1]).toMatchObject({ value: true, editAgeMs: 30_000 });
    expect(bodies()[1]).not.toHaveProperty("editedAt");
    expect(rssShowCountsPref.store.get().dirty).toBe(false);
  });
});

describe("moving the old this-device values up once", () => {
  const cases = [
    { name: "unread numbers setting", pref: rssShowCountsPref, legacy: PREFS.rssShowCounts, raw: "true", key: "rssShowCounts", old: true, theirs: false },
    { name: "feed numbers", pref: rssFeedCountsPref, legacy: PREFS.rssFeedCounts, raw: JSON.stringify({ f1: "on" }), key: "rssFeedCounts", old: { f1: "on" }, theirs: { f2: "off" } },
    { name: "reading positions", pref: rssReadingPositionPref, legacy: PREFS.rssReadingPosition, raw: JSON.stringify({ all: { id: "i1", open: true } }), key: "rssReadingPosition", old: { all: { id: "i1", open: true } }, theirs: { s1: { id: "i9", open: false } } },
    { name: "last visit", pref: rssLastVisitPref, legacy: PREFS.rssLastVisit, raw: "2026-10-20T00:00:00.000Z", key: "rssLastVisit", old: "2026-10-20T00:00:00.000Z", theirs: "2026-10-10T00:00:00.000Z" },
  ] as const;

  for (const c of cases) {
    it(`${c.name}: sent when the account has none, then the old key is gone`, async () => {
      setPref(c.legacy, c.raw);
      // Before the first sync the page already shows the old value.
      expect(c.pref.store.get().value).toEqual(c.old);
      renderHook(() => c.pref.useKeepInSync());
      await waitFor(() => expect(serverPrefs[c.key]).toEqual(c.old));
      expect(getPref(c.legacy)).toBeNull();
      expect(puts(c.key)).toHaveLength(1);
      expect(c.pref.store.get().value).toEqual(c.old);
    });
  }

  // The kind that only moves forward is covered by "newer" below; here the
  // account's own value is never replaced by an old local one.
  for (const c of cases.filter((x) => x.key !== "rssLastVisit")) {
    it(`${c.name}: the account's own value wins, and the old key is still removed`, async () => {
      serverPrefs[c.key] = c.theirs;
      setPref(c.legacy, c.raw);
      renderHook(() => c.pref.useKeepInSync());
      await waitFor(() => expect(c.pref.store.get().value).toEqual(c.theirs));
      await waitFor(() => expect(getPref(c.legacy)).toBeNull());
      expect(sendWrite).not.toHaveBeenCalled();
      expect(serverPrefs[c.key]).toEqual(c.theirs);
    });
  }

  it("nothing moves while the server cannot be reached, and the old value stays visible", async () => {
    const { reads } = await import("../lib/data/reads");
    vi.mocked(reads.people.myPref).mockRejectedValueOnce(new Error("offline"));
    setPref(PREFS.rssFeedCounts, JSON.stringify({ f1: "on" }));
    renderHook(() => rssFeedCountsPref.useKeepInSync());
    await act(async () => { await rssFeedCountsPref.store.sync(); });
    expect(getPref(PREFS.rssFeedCounts)).not.toBeNull();
    expect(rssFeedCountsPref.store.get().value).toEqual({ f1: "on" });
    expect(sendWrite).not.toHaveBeenCalled();
  });
});

describe("a value that only moves forward keeps the newer", () => {
  it("last visit: an older old value is not sent, a newer one replaces the server's", async () => {
    serverPrefs.rssLastVisit = "2026-10-22T00:00:00.000Z";
    setPref(PREFS.rssLastVisit, "2026-10-20T00:00:00.000Z");
    renderHook(() => rssLastVisitPref.useKeepInSync());
    await waitFor(() => expect(getPref(PREFS.rssLastVisit)).toBeNull());
    expect(serverPrefs.rssLastVisit).toBe("2026-10-22T00:00:00.000Z");
    expect(sendWrite).not.toHaveBeenCalled();

    forgetRssPrefs();
    localStorage.clear();
    setPref(PREFS.rssLastVisit, "2026-10-25T00:00:00.000Z");
    renderHook(() => rssLastVisitPref.useKeepInSync());
    await waitFor(() => expect(serverPrefs.rssLastVisit).toBe("2026-10-25T00:00:00.000Z"));
  });

  it("last visit: a device that was behind never writes the time back", async () => {
    serverPrefs.rssLastVisit = "2026-10-24T00:00:00.000Z";
    rssLastVisitPref.store.save("2026-10-21T00:00:00.000Z");
    await waitFor(() => expect(rssLastVisitPref.store.get().dirty).toBe(false));
    expect(serverPrefs.rssLastVisit).toBe("2026-10-24T00:00:00.000Z");
    expect(rssLastVisitPref.store.get().value).toBe("2026-10-24T00:00:00.000Z");
  });

  it("the nav dot follows a visit made on another device", async () => {
    const api = await import("../lib/data/reads");
    vi.spyOn(api.reads.modules.rss, "sources").mockResolvedValue({ sources: [], total_unseen: 2, latest_unseen_at: "2026-10-25T00:00:00.000Z", module_default: null } as never);
    const { result } = renderHook(() => useRssUnread());
    await act(async () => { await refreshRssUnread(); });
    await waitFor(() => expect(result.current.hasNew).toBe(true));
    serverPrefs.rssLastVisit = "2026-10-26T00:00:00.000Z";
    await act(async () => { await rssLastVisitPref.store.sync(); });
    expect(result.current.hasNew).toBe(false);
    // Opening the reader later records the newest arrival, and only forward.
    markRssVisited();
    expect(rssLastVisitPref.store.get().value).toBe("2026-10-26T00:00:00.000Z");
  });
});

describe("reading positions", () => {
  it("update at once here but reach the server only after 2 seconds of quiet", async () => {
    vi.useFakeTimers();
    rememberPosition("all", { id: "i1", open: true });
    expect(readingPosition("all")).toEqual({ id: "i1", open: true });
    await vi.advanceTimersByTimeAsync(1500);
    rememberPosition("all", { id: "i2", open: true });
    rememberPosition("s1", { id: "j1", open: false });
    await vi.advanceTimersByTimeAsync(1500);
    expect(sendWrite).not.toHaveBeenCalled();
    expect(readingPosition("all")).toEqual({ id: "i2", open: true });
    await vi.advanceTimersByTimeAsync(600);
    expect(puts("rssReadingPosition")).toEqual([{ all: { id: "i2", open: true }, s1: { id: "j1", open: false } }]);
    expect(rssReadingPositionPref.store.get().dirty).toBe(false);
  });

  it("are sent when the page is hidden, without waiting", async () => {
    vi.useFakeTimers();
    rememberPosition("all", { id: "i1", open: false });
    expect(sendWrite).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    expect(puts("rssReadingPosition")).toEqual([{ all: { id: "i1", open: false } }]);
  });

  it(`keep only the latest ${MAX_VIEWS} views`, async () => {
    vi.useFakeTimers();
    for (let i = 0; i < MAX_VIEWS + 5; i++) rememberPosition(`feed-${i}`, { id: `item-${i}`, open: false });
    expect(Object.keys(rssReadingPositionPref.store.get().value!)).toHaveLength(MAX_VIEWS);
    expect(readingPosition("feed-0")).toBeNull();
    expect(readingPosition(`feed-${MAX_VIEWS + 4}`)).toEqual({ id: `item-${MAX_VIEWS + 4}`, open: false });
    // Opening an old view again makes it the newest, not the next to go.
    rememberPosition("feed-5", { id: "again", open: true });
    rememberPosition("feed-new", { id: "n", open: false });
    expect(readingPosition("feed-5")).toEqual({ id: "again", open: true });
    expect(readingPosition("feed-6")).toBeNull();
    await vi.advanceTimersByTimeAsync(2100);
    expect(Object.keys(serverPrefs.rssReadingPosition as object)).toHaveLength(MAX_VIEWS);
  });

  it("another device's places arrive and a reader can resume there", async () => {
    serverPrefs.rssReadingPosition = { all: { id: "i7", open: true } };
    renderHook(() => rssReadingPositionPref.useKeepInSync());
    await waitFor(() => expect(readingPosition("all")).toEqual({ id: "i7", open: true }));
  });
});

describe("settings that say they are the account's or the workspace's", () => {
  it("every value setting in an account or workspace tab keeps its value itself, not in this browser", () => {
    const shared = new Set(TABS.filter((tab) => !tab.deviceOnly).map((tab) => tab.id));
    const kept = [...SETTINGS, ...MODULE_SETTINGS].filter((def) => shared.has(def.tab) && ["boolean", "number", "text", "enum"].includes(def.type));
    // The Features tab holds the RSS setting, so the guard is not looking at nothing.
    expect(kept.map((def) => def.id)).toContain(SHOW_COUNTS_SETTING.id);
    for (const def of kept) {
      const own = def as { get?: unknown; set?: unknown };
      expect(typeof own.get, `${def.id} needs its own get`).toBe("function");
      expect(typeof own.set, `${def.id} needs its own set`).toBe("function");
    }
  });
});
