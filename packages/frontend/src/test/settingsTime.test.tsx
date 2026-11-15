// Settings › Date and time (the zone the workspace's days are cut in) and
// Settings › Features › Daily notes (the hour a day starts at), both in
// settings/TimeSetting over lib/workspaceClock. The owner changes them; anyone
// else sees them disabled, with a lock. A change that moves today to another day
// is confirmed first with both dates; one that does not just happens. A toast
// then offers 「改回」.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../lib/auth-client", () => ({ authClient: { useSession: () => ({ data: null }) } }));
const device = vi.hoisted(() => ({ zone: "Asia/Taipei" }));
vi.mock("../lib/localDate", async (original) => ({ ...await original<typeof import("../lib/localDate")>(), deviceTimeZone: () => device.zone }));
const confirmDialog = vi.hoisted(() => vi.fn(async (_message: string, _options?: unknown) => true));
vi.mock("../components/ConfirmDialog", async (original) => ({ ...await original<typeof import("../components/ConfirmDialog")>(), confirmDialog }));
const apiCall = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: (path: string, init?: RequestInit) => apiCall(path, init) }));
vi.mock("../lib/localDb", async (original) => ({
  ...await original<typeof import("../lib/localDb")>(), getPendingWrites: async () => [], upsertWorkspace: async () => {},
}));

import SettingsModal from "../settings/SettingsModal";
import { noWorkspaceData } from "../lib/api";
import { getAppState, resetAppState, setData, setOnline } from "../lib/appStore";
import { registerDictionary, setLocalePref } from "../lib/i18n";
import { ZH_TW } from "../lib/i18n.zh-TW";
import { bindAccountStorage } from "../lib/accountStorage";
import { todayId } from "../lib/localDate";
import { timeZoneAskPref } from "../lib/timeZonePrefs";

const NOW = new Date("2026-10-26T17:00:00Z"); // 10/26 in UTC, already 10/27 in Taipei

function renderTime(opts: { owner?: boolean; online?: boolean; page?: "time" } = {}) {
  resetAppState({ data: { ...noWorkspaceData, timezone: "UTC", workspace: { ...noWorkspaceData.workspace, id: "ws1" }, actor_is_owner: opts.owner !== false } });
  setOnline(opts.online !== false);
  const view = render(<SettingsModal online={opts.online !== false} onClose={vi.fn()} onImportDone={vi.fn()} onConnect={vi.fn()} initialTab={opts.page} />);
  return view;
}
async function openTime() {
  const user = userEvent.setup();
  await user.click(document.querySelector<HTMLElement>('.settings-sidebar [data-tab="time"]')!);
  return user;
}
/** The Date and time page, opened directly (the hour a day starts at is on it). */
const renderDaily = (opts: { owner?: boolean; online?: boolean } = {}) => { renderTime({ ...opts, page: "time" }); return userEvent.setup(); };
const puts = () => apiCall.mock.calls.filter(([path, init]) => path === "/api/workspace/time" && init?.method === "PATCH").map(([, init]) => JSON.parse(init.body as string));
const toastActions = () => getAppState().toasts.flatMap((toast) => (toast.action ? [toast] : []));

beforeEach(() => {
  localStorage.clear();
  bindAccountStorage("settings-time-test", "");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  device.zone = "Asia/Taipei";
  confirmDialog.mockReset().mockResolvedValue(true);
  apiCall.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/workspace/time") {
      const body = JSON.parse(init!.body as string) as { time_zone?: string | null; day_start_hour?: number };
      const w = getAppState().data.workspace;
      return { time_zone: body.time_zone === undefined ? w.time_zone ?? null : body.time_zone, day_start_hour: body.day_start_hour ?? w.day_start_hour ?? 0, today: "x" };
    }
    return { value: null };
  });
  timeZoneAskPref.store.forget();
});
afterEach(() => { vi.useRealTimers(); setLocalePref("en"); });

describe("the page", () => {
  it("is the Date and time page, and shows the zone with its offset", async () => {
    renderTime();
    await openTime();
    expect(screen.getByText("UTC, the default. Not chosen yet.")).toBeInTheDocument();
    // The hour a day starts at is on this page too, not on the daily notes' feature page.
    expect(screen.getByRole("combobox", { name: "When the day starts" })).toHaveValue("0");
  });

  it("the Date and time page has the hour a day starts at, opened directly", async () => {
    renderDaily();
    expect(await screen.findByRole("combobox", { name: "When the day starts" })).toHaveValue("0");
  });

  it("someone who is not the owner sees the zone and the start hour disabled with a lock, and no sentence about it", async () => {
    setData((d) => ({ ...d }));
    renderTime({ owner: false });
    await openTime();
    expect(screen.queryByText(/Only the workspace owner can change this/)).toBeNull();
    expect(screen.getAllByRole("img", { name: "Only the owner can change this" })).toHaveLength(2); // beside the zone and the hour
    expect(screen.getByRole("combobox", { name: "Time zone" })).toBeDisabled();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: /use this device/i })).toBeNull();
    cleanup();
    renderDaily({ owner: false });
    expect(await screen.findByRole("combobox", { name: "When the day starts" })).toBeDisabled();
    expect(screen.getAllByRole("img", { name: "Only the owner can change this" })).toHaveLength(2);
  });

  it("searches zones by plain name, city, country or offset in one typeable list", async () => {
    renderTime();
    const user = await openTime();
    const search = screen.getByRole("combobox", { name: "Time zone" });
    expect(search).toHaveValue("UTC");
    await user.click(search);
    await user.type(search, "tokyo");
    expect(within(screen.getByRole("listbox", { name: "Time zone" })).getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringMatching(/^Tokyo（UTC\+9）/)]);
    await user.clear(search);
    await user.type(search, "zzz-nothing");
    expect(screen.getByText("No time zone matches.")).toBeInTheDocument();
  });

  it("offers this device's zone only when it is not the one in use", async () => {
    renderTime();
    await openTime();
    expect(screen.getByRole("button", { name: "Use this device's time zone (Taipei（UTC+8）)" })).toBeInTheDocument();
  });

  it("hides that button when the device is already on the workspace's zone", async () => {
    device.zone = "UTC";
    renderTime();
    await openTime();
    expect(screen.queryByRole("button", { name: /use this device/i })).toBeNull();
  });
});

describe("changing the zone", () => {
  it("asks first when today moves, with both dates, and stores nothing until yes", async () => {
    renderTime();
    const user = await openTime();
    confirmDialog.mockResolvedValueOnce(false);
    await user.click(screen.getByRole("button", { name: /use this device/i }));
    expect(confirmDialog).toHaveBeenCalledWith(
      "After switching to Taipei time, today will be 10/27 (it was 10/26). Your notes and tasks are not changed; only when the date switches.",
      expect.anything(),
    );
    expect(puts()).toEqual([]);
    expect(getAppState().data.workspace.time_zone ?? null).toBeNull();

    await user.click(screen.getByRole("button", { name: /use this device/i }));
    await waitFor(() => expect(puts()).toEqual([{ time_zone: "Asia/Taipei" }]));
    expect(getAppState().data.workspace.time_zone).toBe("Asia/Taipei");
    expect(todayId(NOW)).toBe("2026-10-27");
  });

  it("says it in Chinese the way the owner reads it", async () => {
    registerDictionary("zh-TW", ZH_TW);
    setLocalePref("zh-TW");
    renderTime();
    await userEvent.setup().click(document.querySelector<HTMLElement>('.settings-sidebar [data-tab="time"]')!);
    await userEvent.setup().click(screen.getByRole("button", { name: "用這台裝置的時區（台北（UTC+8））" }));
    expect(confirmDialog.mock.calls[0]![0]).toBe("改成台北時間後，今天會是 10/27（原本是 10/26）。筆記與任務都不會被改動，只是日期從什麼時候切換。");
  });

  it("does not ask when today stays the same day", async () => {
    renderTime();
    const user = await openTime();
    await user.click(screen.getByRole("combobox", { name: "Time zone" }));
    await user.type(screen.getByRole("combobox", { name: "Time zone" }), "london");
    await user.click(await screen.findByRole("option", { name: /^London/ }));
    await waitFor(() => expect(puts()).toEqual([{ time_zone: "Europe/London" }]));
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it("offers 「改回」 afterwards, and it puts the earlier values back", async () => {
    renderTime();
    const user = await openTime();
    await user.click(screen.getByRole("button", { name: /use this device/i }));
    await waitFor(() => expect(toastActions()).toHaveLength(1));
    expect(toastActions()[0]!.message).toBe("Time settings changed.");
    expect(toastActions()[0]!.action!.label).toBe("Change back");
    await act(async () => { toastActions()[0]!.action!.onClick(); });
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1]).toEqual({ time_zone: null, day_start_hour: 0 });
    expect(getAppState().data.workspace.time_zone ?? null).toBeNull();
  });

  it("changes nothing while offline", async () => {
    renderTime({ online: false });
    await openTime();
    expect(screen.getByRole("button", { name: /use this device/i })).toBeDisabled();
    cleanup();
    renderDaily({ online: false });
    expect(await screen.findByRole("combobox", { name: "When the day starts" })).toBeDisabled();
  });
});

describe("the hour a day starts at", () => {
  it("asks when it would move today back a day, naming the dates", async () => {
    vi.setSystemTime(new Date("2026-10-26T02:00:00Z")); // 02:00: before a 04:00 start
    const user = renderDaily();
    await user.selectOptions(await screen.findByRole("combobox", { name: "When the day starts" }), "04:00");
    expect(confirmDialog.mock.calls[0]![0]).toBe(
      "After the day starts at 04:00, today will be 10/25 (it was 10/26). Your notes and tasks are not changed; only when the date switches.",
    );
    await waitFor(() => expect(puts()).toEqual([{ day_start_hour: 4 }]));
    expect(todayId(new Date())).toBe("2026-10-25");
  });

  it("does not ask when it is already past the start hour", async () => {
    const user = renderDaily();
    await user.selectOptions(await screen.findByRole("combobox", { name: "When the day starts" }), "04:00");
    await waitFor(() => expect(puts()).toEqual([{ day_start_hour: 4 }]));
    expect(confirmDialog).not.toHaveBeenCalled();
  });
});

describe("asking when the device's zone differs", () => {
  it("is on until the owner switches it off, and the choice is kept with the account", async () => {
    renderTime();
    const user = await openTime();
    const toggle = screen.getByRole("switch", { name: "Ask me when this device's time zone differs" });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(timeZoneAskPref.store.get().value).toBe(false);
    expect(toggle).not.toBeChecked();
  });
});
