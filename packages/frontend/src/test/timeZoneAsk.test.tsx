// 旅行時詢問 (lib/timeZoneAsk, components/TimeZoneAsk): when the owner's device is
// in another time zone than the workspace, a quiet card asks once whether to
// move "today" there. Either answer is remembered for that device zone; another
// zone (the home zone on the way back included) can ask again. Never offline,
// never for anyone but the owner, never when switched off.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let serverPrefs: Record<string, unknown> = {};
const sendWrite = vi.hoisted(() => vi.fn());
vi.mock("../lib/data/onlineWrite", async (original) => ({ ...await original<typeof import("../lib/data/onlineWrite")>(), sendWrite }));
vi.mock("../lib/data/reads", async (original) => {
  const real = await original<typeof import("../lib/data/reads")>();
  return { ...real, reads: { ...real.reads, people: { ...real.reads.people, myPref: vi.fn(async (key: string) => ({ value: serverPrefs[key] ?? null })) } } };
});
const device = vi.hoisted(() => ({ zone: "Asia/Tokyo" }));
vi.mock("../lib/localDate", async (original) => ({ ...await original<typeof import("../lib/localDate")>(), deviceTimeZone: () => device.zone }));
const confirmDialog = vi.hoisted(() => vi.fn(async (_message: string, _options?: unknown) => true));
vi.mock("../components/ConfirmDialog", async (original) => ({ ...await original<typeof import("../components/ConfirmDialog")>(), confirmDialog }));
const apiCall = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: (path: string, init?: RequestInit) => apiCall(path, init) }));
vi.mock("../lib/localDb", async (original) => ({
  ...await original<typeof import("../lib/localDb")>(), getPendingWrites: async () => [], upsertWorkspace: async () => {},
}));

import TimeZoneAsk from "../components/TimeZoneAsk";
import { bindAccountStorage } from "../lib/accountStorage";
import { noWorkspaceData } from "../lib/api";
import { getAppState, resetAppState, setOnline, setBootstrapped } from "../lib/appStore";
import { registerDictionary, setLocalePref } from "../lib/i18n";
import { ZH_TW } from "../lib/i18n.zh-TW";
import { timeZoneQuestion, type TimeZoneQuestionInput } from "../lib/timeZoneAsk";
import { timeZoneAnsweredPref, timeZoneAskPref } from "../lib/timeZonePrefs";

const ask: TimeZoneQuestionInput = {
  isOwner: true, online: true, asking: true, prefsSettled: true, answered: null,
  deviceZone: "Asia/Tokyo", chosenZone: "Asia/Taipei", defaultZone: undefined, now: new Date("2026-10-26T12:00:00Z"),
};

describe("the rule", () => {
  it("asks when the owner is online, wants it, and the device's offset differs", () => {
    expect(timeZoneQuestion(ask)).toEqual({ kind: "change", deviceZone: "Asia/Tokyo", workspaceZone: "Asia/Taipei" });
  });

  it("asks to set a zone when none was ever chosen: the default is UTC, or the server's", () => {
    expect(timeZoneQuestion({ ...ask, chosenZone: null, deviceZone: "Asia/Taipei" })).toEqual({ kind: "set", deviceZone: "Asia/Taipei", workspaceZone: "UTC" });
    expect(timeZoneQuestion({ ...ask, chosenZone: null, defaultZone: "Asia/Taipei", deviceZone: "Asia/Taipei" })).toBeNull();
    expect(timeZoneQuestion({ ...ask, chosenZone: null, deviceZone: "UTC" })).toBeNull();
  });

  it("does not ask for the same offset under another name", () => {
    expect(timeZoneQuestion({ ...ask, deviceZone: "Asia/Singapore", chosenZone: "Asia/Taipei" })).toBeNull();
  });

  it("does not ask offline, a member, when switched off, before the preferences are known, or for an answered zone", () => {
    for (const quiet of [{ online: false }, { isOwner: false }, { asking: false }, { prefsSettled: false }, { answered: "Asia/Tokyo" }]) {
      expect(timeZoneQuestion({ ...ask, ...quiet }), JSON.stringify(quiet)).toBeNull();
    }
    expect(timeZoneQuestion({ ...ask, answered: "Asia/Seoul" })).not.toBeNull();
  });
});

function renderAsk(opts: { owner?: boolean; online?: boolean; workspaceZone?: string | null; serverZone?: string; now?: string } = {}) {
  resetAppState({ data: {
    ...noWorkspaceData, actor_is_owner: opts.owner !== false, timezone: opts.serverZone,
    workspace: { ...noWorkspaceData.workspace, id: "ws1", time_zone: opts.workspaceZone === undefined ? "Asia/Taipei" : opts.workspaceZone },
  } });
  setBootstrapped(true);
  setOnline(opts.online !== false);
  return render(<TimeZoneAsk />);
}
const card = () => screen.queryByRole("status", { name: "Time zone" });
const puts = (key: string) => sendWrite.mock.calls.filter(([m, p]) => m === "PUT" && p === `/api/me/prefs/${key}`).map(([, , body]) => body.value);
const arrive = (zone: string) => act(() => { device.zone = zone; document.dispatchEvent(new Event("visibilitychange")); });

beforeEach(() => {
  localStorage.clear();
  serverPrefs = {};
  device.zone = "Asia/Tokyo";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T12:00:00Z")); // same day in Taipei and Tokyo
  sendWrite.mockReset().mockImplementation(async (_m: string, path: string, body: { value: unknown }) => {
    serverPrefs[path.split("/").pop()!] = body.value;
    return { value: body.value };
  });
  confirmDialog.mockReset().mockResolvedValue(true);
  apiCall.mockReset().mockImplementation(async (_path: string, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string) as { time_zone?: string | null; day_start_hour?: number };
    return { time_zone: body.time_zone ?? null, day_start_hour: body.day_start_hour ?? 0, today: "x" };
  });
  bindAccountStorage("time-zone-ask-test", "");
  timeZoneAskPref.store.forget();
  timeZoneAnsweredPref.store.forget();
});
afterEach(() => { vi.useRealTimers(); setLocalePref("en"); });

describe("the card", () => {
  it("asks quietly once the preferences are known, in the owner's words", async () => {
    renderAsk();
    await waitFor(() => expect(card()).toBeInTheDocument());
    expect(card()).toHaveTextContent("Your device is now on Tokyo time. Change Onden's “today” to Tokyo time?");
    expect(screen.getByRole("button", { name: "Change to Tokyo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep Taipei" })).toBeInTheDocument();
  });

  it("speaks Chinese: 「改成東京」「維持台北」", async () => {
    registerDictionary("zh-TW", ZH_TW);
    setLocalePref("zh-TW");
    renderAsk();
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    const zhCard = screen.getByRole("status");
    expect(zhCard).toHaveTextContent("你的裝置現在是東京時間，要把 Onden 的「今天」改成東京時間嗎？");
    expect(screen.getByRole("button", { name: "改成東京" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "維持台北" })).toBeInTheDocument();
  });

  it("keeping the zone is remembered for this device zone: not asked again, until the device is somewhere else", async () => {
    renderAsk();
    await waitFor(() => expect(card()).toBeInTheDocument());
    await userEvent.setup().click(screen.getByRole("button", { name: "Keep Taipei" }));
    await waitFor(() => expect(card()).toBeNull());
    expect(puts("timeZoneAnswered")).toEqual(["Asia/Tokyo"]);
    expect(apiCall).not.toHaveBeenCalled(); // the workspace's zone was not touched

    arrive("Asia/Tokyo"); // back in view, same place
    expect(card()).toBeNull();

    arrive("America/New_York");
    await waitFor(() => expect(card()).toHaveTextContent("New York time"));
  });

  it("coming home forgets the answer, so the next trip to the same place asks again", async () => {
    renderAsk();
    await waitFor(() => expect(card()).toBeInTheDocument());
    await userEvent.setup().click(screen.getByRole("button", { name: "Keep Taipei" }));
    await waitFor(() => expect(card()).toBeNull());

    arrive("Asia/Taipei");
    await waitFor(() => expect(puts("timeZoneAnswered")).toEqual(["Asia/Tokyo", null]));
    expect(card()).toBeNull();

    arrive("Asia/Tokyo");
    await waitFor(() => expect(card()).toBeInTheDocument());
  });

  it("changing the zone goes through the confirmation when today moves, then remembers the answer", async () => {
    vi.setSystemTime(new Date("2026-10-26T15:30:00Z")); // 23:30 in Taipei, 00:30 the next day in Tokyo
    renderAsk();
    await waitFor(() => expect(card()).toBeInTheDocument());
    const user = userEvent.setup();

    confirmDialog.mockResolvedValueOnce(false);
    await user.click(screen.getByRole("button", { name: "Change to Tokyo" }));
    expect(confirmDialog.mock.calls[0]![0]).toBe("After switching to Tokyo time, today will be 10/27 (it was 10/26). Your notes and tasks are not changed; only when the date switches.");
    expect(apiCall).not.toHaveBeenCalled();
    expect(card()).toBeInTheDocument(); // not answered: the question stays

    await user.click(screen.getByRole("button", { name: "Change to Tokyo" }));
    await waitFor(() => expect(card()).toBeNull());
    expect(JSON.parse(apiCall.mock.calls[0]![1].body)).toEqual({ time_zone: "Asia/Tokyo" });
    expect(getAppState().data.workspace.time_zone).toBe("Asia/Tokyo");
    expect(puts("timeZoneAnswered")).toEqual(["Asia/Tokyo"]);
  });

  it("when no zone was ever chosen, asks to set one", async () => {
    device.zone = "Asia/Taipei";
    renderAsk({ workspaceZone: null });
    await waitFor(() => expect(card()).toBeInTheDocument());
    expect(card()).toHaveTextContent("Set Onden's time zone to Taipei?");
    await userEvent.setup().click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(card()).toBeNull());
    expect(puts("timeZoneAnswered")).toEqual(["Asia/Taipei"]);
  });

  it("stays away offline, for a member, and when switched off", async () => {
    const offline = renderAsk({ online: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(card()).toBeNull();
    offline.unmount();

    const member = renderAsk({ owner: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(card()).toBeNull();
    member.unmount();

    serverPrefs.timeZoneAsk = false;
    timeZoneAskPref.store.forget(); // the earlier renders had already synced it
    timeZoneAnsweredPref.store.forget();
    renderAsk();
    await waitFor(() => expect(timeZoneAskPref.store.get().settled).toBe(true));
    expect(card()).toBeNull();
  });

  it("an answer given on another device is known before this one asks", async () => {
    serverPrefs.timeZoneAnswered = "Asia/Tokyo";
    renderAsk();
    await waitFor(() => expect(timeZoneAnsweredPref.store.get().settled).toBe(true));
    expect(card()).toBeNull();
  });
});
