// Events from subscribed calendars on the day timeline and the week board
// (modules/external_calendars; shown by modules/daily/day): read-only, a look of
// their own, opened for details, one note per event, and nothing at all while the
// module is off.

// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const sendOrQueue = vi.fn();
vi.mock("../lib/data/writeQueue", async (original) => ({
  ...await original<typeof import("../lib/data/writeQueue")>(),
  submitWrite: async (r: { method: string; path: string; body: string | null }) => {
    const value = await sendOrQueue(r.method, r.path, r.body);
    return value === undefined ? { status: "queued" } : { status: "synced", value };
  },
}));
vi.mock("../lib/localDb", async (original) => ({
  ...await original<typeof import("../lib/localDb")>(),
  upsertNode: async () => {}, removeNode: async () => {}, upsertAttribute: async () => {}, upsertTask: async () => {}, removeTask: async () => {},
}));
const externalEvents = vi.fn();
vi.mock("../lib/data", async (original) => {
  const real = await original<typeof import("../lib/data")>();
  return { ...real, reads: { ...real.reads, workspace: { ...real.reads.workspace, dayLens: async () => ({ items: [] }), externalCalendars: (path: string) => externalEvents(...(/from=([^&]+)&to=(.+)$/.exec(path) ?? []).slice(1)) } } };
});

import "../modules";
import TasksMode from "../modules/tasks/TasksMode";
import { bindAccountStorage } from "../lib/accountStorage";
import { resetAppState, setData } from "../lib/appStore";
import { clockInstant } from "../lib/dayWindow";
import { eventNoteId, eventsOnDay, type ExternalEvent } from "../lib/externalCalendars";
import { todayId } from "../lib/localDate";
import { clearPhoneLayout } from "./phoneMedia";

const today = todayId();
const event = (over: Partial<ExternalEvent>): ExternalEvent => ({
  id: "cal-1:e1", calendar_id: "cal-1", calendar_name: "Work", color: "#3b82f6", title: "Design review", location: "Room 2",
  description: "Bring the draft.", all_day: false, starts_at: clockInstant(today, "15:00")!, ends_at: clockInstant(today, "16:00")!,
  start_day: today, end_day: today, ...over,
});
const seed = (modules: string[]) => setData((s) => ({ ...s, workspace: { ...s.workspace, modules }, nodes: [], tasks: [] }));
const renderTasks = () => render(<TasksMode online onSelectNode={vi.fn()} onRefresh={() => {}} onError={vi.fn()} reminderPermission="unsupported" onEnableReminders={() => {}} />);

beforeEach(() => {
  resetAppState();
  localStorage.clear();
  sendOrQueue.mockReset().mockResolvedValue(undefined);
  externalEvents.mockReset().mockResolvedValue({ events: [event({}), event({ id: "cal-1:h", title: "Holiday", all_day: true })] });
  bindAccountStorage("external-calendars-test", "");
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => clearPhoneLayout());

describe("subscribed-calendar events on the timeline", () => {
  it("shows a timed event beside the hours and an all-day one above them, neither draggable", async () => {
    seed(["daily", "tasks", "external_calendars"]);
    renderTasks();
    const timeline = await screen.findByTestId("day-timeline");
    const block = await within(timeline).findByRole("button", { name: /Design review/ });
    expect(block.classList.contains("ext-block")).toBe(true);
    expect(block.getAttribute("draggable")).not.toBe("true");
    const strip = within(timeline).getByRole("list", { name: "All-day events" });
    expect(within(strip).getByRole("button", { name: "Holiday" })).toBeTruthy();
  });

  it("opens the details of an event: when, where, what it says and which calendar", async () => {
    seed(["daily", "tasks", "external_calendars"]);
    renderTasks();
    await userEvent.click(await screen.findByRole("button", { name: /Design review/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Room 2")).toBeTruthy();
    expect(within(sheet).getByText("Bring the draft.")).toBeTruthy();
    expect(within(sheet).getByText(/Work/)).toBeTruthy();
    expect(within(sheet).getByText(/15:00–16:00/)).toBeTruthy();
  });

  it("makes one note per event: the second press opens the note that is already there", async () => {
    seed(["daily", "tasks", "external_calendars"]);
    renderTasks();
    await userEvent.click(await screen.findByRole("button", { name: /Design review/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Take notes" }));
    await waitFor(() => expect(sendOrQueue.mock.calls.some(([m, p]) => m === "POST" && String(p).includes("/api/nodes"))).toBe(true));
    const made = sendOrQueue.mock.calls.find(([m, p]) => m === "POST" && String(p).includes("/api/nodes"))!;
    const body = JSON.parse(made[2] as string);
    expect(body.id).toBe(eventNoteId({ id: "cal-1:e1" }));
    expect(body.title).toBe("Design review");
    expect(body.markdown).toContain("15:00–16:00");
    expect(body.markdown).toContain("Room 2");
  });

  it("asks for nothing and shows nothing while the module is off", async () => {
    seed(["daily", "tasks"]);
    renderTasks();
    await screen.findByTestId("day-timeline");
    expect(externalEvents).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Design review/ })).toBeNull();
    expect(screen.queryByRole("list", { name: "All-day events" })).toBeNull();
  });
});

describe("eventsOnDay", () => {
  it("lists a multi-day event on each day it touches, all-day first", () => {
    const trip = event({ id: "t", all_day: true, title: "Trip", start_day: "2026-07-01", end_day: "2026-07-03" });
    const talk = event({ id: "k", title: "Talk", start_day: "2026-07-02", end_day: "2026-07-02" });
    expect(eventsOnDay([talk, trip], "2026-07-02").map((e) => e.title)).toEqual(["Trip", "Talk"]);
    expect(eventsOnDay([talk, trip], "2026-07-03").map((e) => e.title)).toEqual(["Trip"]);
    expect(eventsOnDay([talk, trip], "2026-07-04")).toEqual([]);
  });
});
