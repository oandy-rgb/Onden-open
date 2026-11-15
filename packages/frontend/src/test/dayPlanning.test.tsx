// Planning a time on the 日子 timeline: a tap on an empty stretch, a task dropped
// on an hour. What is written is the task's time/until (the server rewrites the line in its note);
// every plan comes back with a 復原. The pure position maths and the press machine are in
// timelineSlots.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const sendOrQueue = vi.fn();
vi.mock("../lib/data/writeQueue", async (original) => ({
  ...await original<typeof import("../lib/data/writeQueue")>(),
  submitWrite: async (r: { method: string; path: string; body: string | null }) => {
    const value = await sendOrQueue(r.method, r.path, r.body);
    return value === undefined ? { status: "queued" } : { status: "synced", value };
  },
}));
vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), upsertTask: async () => {} }));
const createQuickTask = vi.hoisted(() => vi.fn(async (_fields: unknown) => ({ saved: "saved", noteTitle: "" })));
vi.mock("../modules/tasks/createQuickTask", () => ({ createQuickTask }));

import { taskDayItems, toTaskItem } from "../lib/tasks";
import TimelinePlanner from "../modules/daily/day/TimelinePlanner";
import TaskRow from "../modules/tasks/TaskRow";
import { TASK_DRAG_TYPE } from "../lib/taskDrag";
import type { NodeTask } from "../lib/api";
import { getAppState, resetAppState, setData } from "../lib/appStore";
import { bindAccountStorage } from "../lib/accountStorage";
import { todayId } from "../lib/localDate";
import { DRAW_HOLD_MS as HOLD_MS } from "../modules/daily/day/longPressDraw";
import { dayWindow } from "../lib/dayWindow";
import { clearPhoneLayout, setPhoneLayout } from "./phoneMedia";

const today = todayId();
const HOUR_PX = 56;
const task = (id: string, extra: Partial<NodeTask> = {}): NodeTask => ({ id, node_id: null, title: id, status: "todo", when_date: today, due_date: today, ...extra });

function mount(tasks: NodeTask[], enabled = true, foldEmpty = false) {
  setData((s) => ({ ...s, tasks }));
  const items = taskDayItems({ date: today, today, nodes: [], tasks, tags: [] });
  render(<TimelinePlanner enabled={enabled} foldEmpty={foldEmpty} date={today} items={items} nowMs={dayWindow(today).startMs + 3 * 3_600_000} onOpen={vi.fn()} autoScroll={false} />);
  return items;
}
const body = () => screen.getByTestId("day-timeline-body");
/** Clock y of `minutes` after the day starts (the jsdom body is at 0). */
const at = (minutes: number) => (minutes * HOUR_PX) / 60;
/** Set a 24-hour clock field (hour, then minute) in the slot's form. */
const setClock = (dialog: HTMLElement, name: string, clock: string) => {
  const field = within(within(dialog).getByRole("group", { name }));
  const [hour, minute] = clock.split(":") as [string, string];
  fireEvent.change(field.getByLabelText("Hour"), { target: { value: hour } });
  fireEvent.change(field.getByLabelText("Minute"), { target: { value: minute } });
};
/** jsdom has no DragEvent, so its position is put on by hand. */
function dragEvent(type: "dragOver" | "drop", clientY: number, id: string) {
  const event = createEvent[type](body(), { dataTransfer: { types: [TASK_DRAG_TYPE], getData: () => id } });
  Object.defineProperty(event, "clientY", { value: clientY });
  fireEvent(body(), event);
}
const bodies = () => sendOrQueue.mock.calls.map(([, , b]) => JSON.parse(b as string));

beforeEach(() => {
  resetAppState();
  bindAccountStorage("day-planning-test", "");
  sendOrQueue.mockReset().mockResolvedValue(undefined);
  createQuickTask.mockClear();
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
});

const box = async () => within(await screen.findByRole("dialog", { name: "Plan a time" })).findByRole("combobox", { name: "Task" });

describe("folded empty stretches never get in the way of planning", () => {
  // now is 03:00: 00:00–02:00 and 12:00–24:00 are folded.
  const folds = () => [...document.querySelectorAll(".day-fold")].map((el) => el.textContent);

  it("a task dragged over the timeline opens every fold, so the drop lands on a real hour; they fold again after", async () => {
    mount([task("a")], true, true);
    expect(folds()).toEqual(["00:00–02:00 empty · Show", "12:00–24:00 empty · Show"]);
    dragEvent("dragOver", at(60), "a");
    expect(folds()).toEqual([]);
    dragEvent("drop", at(15 * 60), "a");
    await waitFor(() => expect(bodies()).toEqual([expect.objectContaining({ time: "15:00", until: "15:30" })]));
    // The drop ends the drag: folded again (this harness does not feed the new time back as an item).
    await waitFor(() => expect(folds()).toEqual(["00:00–02:00 empty · Show", "12:00–24:00 empty · Show"]));
  });

  it("leaving the timeline with a task in hand folds it again", () => {
    mount([task("a")], true, true);
    dragEvent("dragOver", at(60), "a");
    expect(folds()).toEqual([]);
    fireEvent.dragLeave(body(), { relatedTarget: null });
    expect(folds()).toHaveLength(2);
  });

  it("the fold is a button: a tap opens it, it does not start a plan", () => {
    mount([], true, true);
    fireEvent.click(screen.getByRole("button", { name: "12:00–24:00 empty · Show" }));
    expect(folds()).toEqual(["00:00–02:00 empty · Show"]);
    expect(screen.queryByRole("dialog", { name: "Plan a time" })).toBeNull();
  });

  it("without foldEmpty nothing folds", () => {
    mount([]);
    expect(folds()).toEqual([]);
  });
});

describe("tap an empty stretch", () => {
  it("opens the quick-add with the time of the place, 30 minutes long; Enter adds a task there", async () => {
    mount([]);
    fireEvent.click(body(), { clientY: at(14 * 60 + 5) });
    const dialog = await screen.findByRole("dialog", { name: "Plan a time" });
    // the panel is a lazily loaded chunk: wait for it
    expect(await within(dialog).findByText(/14:00–14:30/)).toBeTruthy();
    await userEvent.type(await box(), "Write report{Enter}");
    await waitFor(() => expect(createQuickTask).toHaveBeenCalledTimes(1));
    expect(createQuickTask.mock.calls[0]![0]).toMatchObject({ title: "Write report", when_date: today, time: "14:00", until: "14:30" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Plan a time" })).toBeNull());
  });

  it("keeps what was typed when the task cannot be added", async () => {
    createQuickTask.mockRejectedValueOnce(new Error("refused"));
    mount([]);
    fireEvent.click(body(), { clientY: at(600) });
    await userEvent.type(await box(), "Keep me{Enter}");
    await waitFor(() => expect(createQuickTask).toHaveBeenCalled());
    expect((await box() as HTMLInputElement).value).toBe("Keep me");
    expect(screen.getByRole("dialog", { name: "Plan a time" })).toBeTruthy();
  });

  it("does not open on a block that is already there", async () => {
    mount([task("busy", { time: "10:00", until: "11:00" })]);
    fireEvent.click(await screen.findByRole("button", { name: /10:00–11:00/ }));
    expect(screen.queryByRole("dialog", { name: "Plan a time" })).toBeNull();
  });

  it("the length buttons and the clock fields change the slot; a drawn too-long stretch is one tap from right", async () => {
    mount([]);
    fireEvent.click(body(), { clientY: at(14 * 60) });
    const dialog = await screen.findByRole("dialog", { name: "Plan a time" });
    await userEvent.click(await within(dialog).findByRole("button", { name: "1 hr" }));
    expect(within(dialog).getByText(/14:00–15:00/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "15 min" }));
    expect(within(dialog).getByText(/14:00–14:15/)).toBeTruthy();
    setClock(dialog, "Starts at", "16:30");
    expect(within(dialog).getByText(/16:30–16:45/)).toBeTruthy();
    setClock(dialog, "Ends at", "18:00");
    await userEvent.type(await box(), "Study{Enter}");
    await waitFor(() => expect(createQuickTask).toHaveBeenCalledTimes(1));
    expect(createQuickTask.mock.calls[0]![0]).toMatchObject({ title: "Study", time: "16:30", until: "18:00" });
  });

  it("a time typed in the box replaces the slot, and says so", async () => {
    mount([]);
    fireEvent.click(body(), { clientY: at(14 * 60) });
    const dialog = await screen.findByRole("dialog", { name: "Plan a time" });
    await userEvent.type(await box(), "下午3點到5點 讀OS");
    expect(within(dialog).getByText(/你寫的時間取代了選的時段|The time you typed replaces the slot: 15:00–17:00/)).toBeTruthy();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(createQuickTask).toHaveBeenCalledTimes(1));
    expect(createQuickTask.mock.calls[0]![0]).toMatchObject({ title: "讀OS", when_date: today, time: "15:00", until: "17:00" });
  });

  it("a length typed in the box (no clock) sets the end from the slot's start", async () => {
    mount([]);
    fireEvent.click(body(), { clientY: at(14 * 60) });
    await userEvent.type(await box(), "讀書 90分鐘{Enter}");
    await waitFor(() => expect(createQuickTask).toHaveBeenCalledTimes(1));
    expect(createQuickTask.mock.calls[0]![0]).toMatchObject({ title: "讀書", time: "14:00", until: "15:30" });
  });

  it("lists the open tasks with no time when nothing is typed; choosing one plans it into the slot, and 復原 puts it back", async () => {
    mount([task("later"), task("done-one", { status: "done" }), task("fixed", { time: "09:00" }), task("overdue-one", { when_date: "2000-01-01", due_date: "2000-01-01" })]);
    fireEvent.click(body(), { clientY: at(15 * 60) });
    const dialog = await screen.findByRole("dialog", { name: "Plan a time" });
    expect(await within(dialog).findByRole("button", { name: /overdue-one/ })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /done-one/ })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /fixed/ })).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: /^later/ }));
    await waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(1));
    expect(sendOrQueue.mock.calls[0]![0]).toBe("PATCH");
    expect(sendOrQueue.mock.calls[0]![1]).toBe("/api/tasks/later");
    expect(bodies()[0]).toEqual({ time: "15:00", until: "15:30" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Plan a time" })).toBeNull());

    const toast = getAppState().toasts.find((entry) => entry.action);
    expect(toast?.message).toBe("Planned for 15:00–15:30");
    toast!.action!.onClick();
    await waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(2));
    expect(bodies()[1]).toEqual({ when_date: today, someday: null, time: null, until: null });
  });

  it("typing searches the open tasks of any day by name; one is planned with its day moved to the slot's", async () => {
    mount([task("Read chapter", { when_date: "2999-01-01", due_date: "2999-01-01" }), task("Other"), task("Reading list", { someday: true, when_date: null, due_date: null }), task("Read done", { status: "done" })]);
    fireEvent.click(body(), { clientY: at(10 * 60) });
    const dialog = await screen.findByRole("dialog", { name: "Plan a time" });
    await userEvent.type(await box(), "read");
    expect(await within(dialog).findByRole("button", { name: /Read chapter/ })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Reading list/ })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /Other/ })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Read done/ })).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: /Read chapter/ }));
    await waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(1));
    expect(bodies()[0]).toEqual({ time: "10:00", until: "10:30", when_date: today, someday: null });
    expect(createQuickTask).not.toHaveBeenCalled();
  });
});

describe("on a phone", () => {
  afterEach(() => clearPhoneLayout());
  it("the quick-add is a sheet, with the same time and the same untimed tasks", async () => {
    setPhoneLayout(true);
    mount([task("later")]);
    fireEvent.click(body(), { clientY: at(9 * 60) });
    const sheet = await screen.findByRole("dialog", { name: "Plan a time" });
    expect(sheet.className).toContain("ui-sheet");
    expect(await within(sheet).findByText(/09:00–09:30/)).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: /^later/ })).toBeTruthy();
  });
});

describe("drag an untimed task onto the timeline", () => {
  const drop = (id: string, minutes: number) => dragEvent("drop", at(minutes), id);

  it("plans it at the hour it is dropped on, 30 minutes, with a 復原", async () => {
    mount([task("a")]);
    drop("a", 11 * 60 + 20);
    await waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(1));
    expect(bodies()[0]).toEqual({ time: "11:15", until: "11:45" });
    expect(getAppState().toasts.some((entry) => entry.action?.label === "Undo")).toBe(true);
  });

  it("shows where it would land while it is over the timeline", () => {
    mount([task("a")]);
    dragEvent("dragOver", at(9 * 60), "");
    expect(screen.getByTestId("day-timeline").textContent).toContain("09:00–09:30");
  });

  it("a day other than the task's own gives the task that day too", async () => {
    mount([task("a", { when_date: null, due_date: null })]);
    drop("a", 8 * 60);
    await waitFor(() => expect(sendOrQueue).toHaveBeenCalled());
    expect(bodies()[0]).toEqual({ time: "08:00", until: "08:30", when_date: today, someday: null });
  });

  it("a finished task is not planned even if dropped", async () => {
    mount([task("done-one", { status: "done" })]);
    drop("done-one", 8 * 60);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendOrQueue).not.toHaveBeenCalled();
  });

  it("only open tasks with no time can be picked up from the Tasks page's list", () => {
    const rows = [task("open"), task("done-one", { status: "done" }), task("timed", { time: "09:00" })];
    render(<ul>{rows.map((row) => <TaskRow key={row.id} task={toTaskItem(row as never, () => undefined)} today={today} showWhen={false} onToggle={vi.fn()} onOpen={vi.fn()} planDrag />)}</ul>);
    const li = (title: string) => screen.getByText(title).closest("li")!;
    expect(li("open").getAttribute("draggable")).toBe("true");
    expect(li("done-one").getAttribute("draggable")).toBeNull();
    expect(li("timed").getAttribute("draggable")).toBeNull();
  });
});

describe("with the tasks module off", () => {
  it("a tap opens nothing and a drop plans nothing", async () => {
    mount([task("a")], false);
    fireEvent.click(body(), { clientY: at(600) });
    dragEvent("drop", at(600), "a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sendOrQueue).not.toHaveBeenCalled();
  });
});

describe("press and hold on a phone", () => {
  afterEach(() => vi.useRealTimers());
  const touch = (type: "pointerDown" | "pointerMove" | "pointerUp", clientY: number) => {
    const event = createEvent[type](body(), { pointerType: "touch", isPrimary: true, bubbles: true });
    Object.defineProperty(event, "clientY", { value: clientY });
    Object.defineProperty(event, "clientX", { value: 100 });
    act(() => { fireEvent(body(), event); });
  };

  it("held (HOLD_MS) then dragged: draws a stretch, shakes the phone, and opens the input with its times", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const vibrate = vi.fn();
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
    mount([]);
    touch("pointerDown", at(10 * 60));
    act(() => { vi.advanceTimersByTime(HOLD_MS - 1); });
    expect(vibrate).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(vibrate).toHaveBeenCalledTimes(1);
    touch("pointerMove", at(11 * 60 + 40));
    expect(screen.getByTestId("day-timeline").textContent).toContain("10:00–11:45");
    touch("pointerUp", at(11 * 60 + 40));
    // the click that follows a lifted finger is not a tap
    fireEvent.click(body(), { clientY: at(11 * 60 + 40) });
    vi.useRealTimers();
    const dialog = await screen.findByRole("dialog", { name: "Plan a time" });
    expect(await within(dialog).findByText(/10:00–11:45/)).toBeTruthy();
  });

  it("moving before the hold is up is a scroll: nothing is drawn", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    mount([]);
    touch("pointerDown", at(10 * 60));
    touch("pointerMove", at(10 * 60) + 30);
    act(() => { vi.advanceTimersByTime(HOLD_MS * 2); });
    touch("pointerUp", at(10 * 60) + 30);
    expect(screen.queryByRole("dialog", { name: "Plan a time" })).toBeNull();
  });
});
