// Moving a planned block and pulling its lower edge on the 日子 timeline: the slot maths
// (timelineDrag), then the gestures — mouse, finger, keyboard — on the real timeline. Nothing is
// written while dragging; one write when it is let go, with a 復原; a refusal puts the block back.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";

const sendOrQueue = vi.fn();
vi.mock("../lib/data/writeQueue", async (original) => ({
  ...await original<typeof import("../lib/data/writeQueue")>(),
  submitWrite: async (r: { method: string; path: string; body: string | null }) => {
    const value = await sendOrQueue(r.method, r.path, r.body);
    return value === undefined ? { status: "queued" } : { status: "synced", value };
  },
}));
vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), upsertTask: async () => {} }));

import { taskDayItems } from "../lib/tasks";
import { taskRefsFrom, registerTaskRefs } from "../lib/taskRefs";
import TimelinePlanner from "../modules/daily/day/TimelinePlanner";
import { itemSpan, moveSpan, resizeSpan, slotSpan } from "../modules/daily/day/timelineDrag";
import { KEY_COMMIT_MS } from "../modules/daily/day/useBlockDrag";
import type { NodeTask } from "../lib/api";
import { getAppState, resetAppState, setData, useAppSelector } from "../lib/appStore";
import { bindAccountStorage } from "../lib/accountStorage";
import { todayId, setWorkspaceTimeZoneSource } from "../lib/localDate";
import { HOLD_MS } from "../lib/touchHold";
import { TASK_DRAG_TYPE } from "../lib/taskDrag";
import { dayWindow } from "../lib/dayWindow";

const today = todayId();
const HOUR_PX = 56;
const at = (minutes: number) => (minutes * HOUR_PX) / 60;
const task = (id: string, extra: Partial<NodeTask> = {}): NodeTask => ({ id, node_id: null, title: id, status: "todo", when_date: today, due_date: today, ...extra });

describe("slot maths", () => {
  setWorkspaceTimeZoneSource(() => "Asia/Taipei");
  const day = dayWindow("2026-10-30", "Asia/Taipei", 0);
  beforeEach(() => setWorkspaceTimeZoneSource(() => "Asia/Taipei"));
  afterEach(() => setWorkspaceTimeZoneSource(() => undefined));
  const m = (h: number, min = 0) => h * 60 + min;

  it("moves on the 15-minute grid and keeps the length", () => {
    expect(moveSpan(day, { startMinutes: m(10), endMinutes: m(11) }, 37)).toMatchObject({ time: "10:30", until: "11:30" });
    expect(moveSpan(day, { startMinutes: m(10), endMinutes: m(11) }, -7)).toBeNull(); // rounds back to where it was
    expect(moveSpan(day, { startMinutes: m(10), endMinutes: m(11) }, -8)).toMatchObject({ time: "09:45", until: "10:45" });
  });
  it("stays inside the day and does not push its end past midnight", () => {
    expect(moveSpan(day, { startMinutes: m(10), endMinutes: m(11) }, -m(20))).toMatchObject({ time: "00:00", until: "01:00" });
    // 1h long, pushed to the last hour: it ends at midnight, which a line cannot write, so it slides earlier
    const last = moveSpan(day, { startMinutes: m(22), endMinutes: m(23) }, m(5))!;
    expect(last).toMatchObject({ time: "22:45", until: "23:45" });
  });
  it("a task with no end moves without gaining one", () => {
    expect(moveSpan(day, { startMinutes: m(9), endMinutes: null }, 60)).toMatchObject({ time: "10:00", until: null });
  });
  it("a day that starts at 04:00 lines up with the clock", () => {
    const late = dayWindow("2026-10-30", "Asia/Taipei", 4);
    const span = { startMinutes: m(6), endMinutes: m(7) }; // 10:00–11:00 on the clock
    expect(moveSpan(late, span, 30)).toMatchObject({ time: "10:30", until: "11:30" });
    // 23:00 on the clock is 19h in; moving 2h would wrap past midnight: stopped before it
    const near = moveSpan(late, { startMinutes: m(18), endMinutes: m(19) }, m(2))!;
    expect(near.until === null || near.until > near.time).toBe(true);
  });
  it("stretches the end on the grid, at least 15 minutes, never moving the start", () => {
    const span = { startMinutes: m(10), endMinutes: m(11) };
    expect(resizeSpan(day, span, 31)).toMatchObject({ time: "10:00", until: "11:30" });
    expect(resizeSpan(day, span, -m(5))).toMatchObject({ time: "10:00", until: "10:15" });
    expect(resizeSpan(day, span, 3)).toBeNull();
  });
  it("gives a task with no end one", () => {
    expect(resizeSpan(day, { startMinutes: m(10), endMinutes: null }, 45)).toMatchObject({ time: "10:00", until: "10:45" });
    expect(resizeSpan(day, { startMinutes: m(10), endMinutes: null }, 4)).toBeNull();
    expect(resizeSpan(day, { startMinutes: m(10), endMinutes: null }, 8)).toMatchObject({ until: "10:15" });
  });
  it("cannot be stretched to a midnight the line cannot write", () => {
    const edge = resizeSpan(day, { startMinutes: m(23), endMinutes: m(23, 30) }, m(3))!;
    expect(edge.until).toBe("23:45");
    expect(resizeSpan(day, { startMinutes: m(23, 45), endMinutes: null }, 60)).toBeNull();
  });
  it("reads the block off a day item, and refuses ones this day cannot hold", () => {
    const start = day.startMs;
    const iso = (min: number) => new Date(start + min * 60_000).toISOString();
    expect(itemSpan(day, { at: iso(m(10)), until: iso(m(11)) })).toEqual({ startMinutes: m(10), endMinutes: m(11) });
    expect(itemSpan(day, { at: iso(m(10)) })).toEqual({ startMinutes: m(10), endMinutes: null });
    expect(itemSpan(day, { at: iso(-30) })).toBeNull();
    expect(itemSpan(day, { at: iso(m(23)), until: iso(m(25)) })).toBeNull();
    expect(itemSpan(day, {})).toBeNull();
    expect(slotSpan(moveSpan(day, { startMinutes: m(9), endMinutes: null }, 60)!)).toEqual({ startMinutes: m(10), endMinutes: null });
  });
});

function mount(tasks: NodeTask[], { writable = true, foldEmpty = false }: { writable?: boolean; foldEmpty?: boolean } = {}) {
  setData((s) => ({ ...s, tasks }));
  const refs = taskRefsFrom(tasks, [], () => writable);
  registerTaskRefs({ tasks: () => refs, subscribe: () => () => {} });
  const items = taskDayItems({ date: today, today, nodes: [], tasks, tags: [] });
  render(<TimelinePlanner enabled foldEmpty={foldEmpty} date={today} items={items} nowMs={dayWindow(today).startMs + 3 * 3_600_000} onOpen={vi.fn()} autoScroll={false} />);
}
const bodies = () => sendOrQueue.mock.calls.map(([, , b]) => JSON.parse(b as string));
const block = (name: RegExp | string) => screen.getByRole("button", { name });
function pointer(target: Element | Window, type: string, init: { clientY: number; pointerType?: string; clientX?: number }) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: init.clientX ?? 100, clientY: init.clientY });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: init.pointerType ?? "mouse" });
  Object.defineProperty(event, "isPrimary", { value: true });
  act(() => { target.dispatchEvent(event); });
}

beforeEach(() => {
  resetAppState();
  bindAccountStorage("block-drag-test", "");
  sendOrQueue.mockReset().mockResolvedValue(undefined);
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
});
afterEach(() => { registerTaskRefs(null); vi.useRealTimers(); });

describe("dragging a block on a timeline with folded empty stretches", () => {
  const folds = () => document.querySelectorAll(".day-fold").length;

  it("opens every fold while the block is moved, so it can be dropped on any hour; they fold again after", async () => {
    mount([task("busy", { time: "10:00", until: "11:00" })], { foldEmpty: true });
    expect(folds()).toBe(2); // 00–02, 12–24 (now is 03:00)
    pointer(block(/10:00–11:00/), "pointerdown", { clientY: 250 });
    expect(folds()).toBe(2); // a press alone (a tap) changes nothing
    pointer(window, "pointermove", { clientY: 300 });
    expect(folds()).toBe(0);
    pointer(window, "pointerup", { clientY: 300 });
    await waitFor(() => expect(folds()).toBeGreaterThan(0));
  });
});

describe("opening the folds under a dragged block when the scroll box is short", () => {
  it("makes up what the browser would cut off with padding, and takes it away after, so the block does not move", async () => {
    mount([task("late", { time: "22:00", until: "23:00" })], { foldEmpty: true });
    const scroller = screen.getByTestId("day-timeline");
    // A scroll box that can scroll at most 100px (plus whatever padding is given), like a short box.
    let top = 0;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => { top = Math.min(value, 100 + (parseFloat(scroller.style.paddingBottom) || 0)); },
    });
    pointer(block(/22:00–23:00/), "pointerdown", { clientY: 300 });
    pointer(window, "pointermove", { clientY: 330 });
    expect(document.querySelectorAll(".day-fold").length).toBe(0);
    // Opening the folds above the block pushes it down by far more than 100px: all of it is scrolled.
    expect(parseFloat(scroller.style.paddingBottom)).toBeGreaterThan(0);
    expect(top).toBeGreaterThan(100);
    pointer(window, "pointerup", { clientY: 330 });
    await waitFor(() => expect(scroller.style.paddingBottom).toBe(""));
  });
});

describe("folds closing again after a drop", () => {
  // jsdom has no layout: the scroll box's position is a plain number, and a line's place in the box is its --top minus it.
  function scrollBox() {
    const el = screen.getByTestId("day-timeline");
    let top = 0;
    Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (value: number) => { top = value; } });
    const lineAt = (label: string) => {
      const line = [...document.querySelectorAll<HTMLElement>(".day-hour")].find((node) => node.textContent === label)!;
      return parseFloat(line.style.getPropertyValue("--top")) - top;
    };
    return { lineAt };
  }
  const hourLabels = () => [...document.querySelectorAll(".day-hour-label")].map((node) => node.textContent);

  it("the dropped block stays where it is in the scroll box (the fold above it shrinks, the scroll follows)", async () => {
    mount([task("late", { time: "22:00", until: "23:00" })], { foldEmpty: true });
    const box = scrollBox();
    pointer(block(/22:00–23:00/), "pointerdown", { clientY: 250 });
    pointer(window, "pointermove", { clientY: 300 });
    expect(document.querySelectorAll(".day-fold").length).toBe(0);
    const during = box.lineAt("22:00");
    pointer(window, "pointerup", { clientY: 300 });
    await waitFor(() => expect(document.querySelectorAll(".day-fold").length).toBeGreaterThan(0));
    expect(box.lineAt("22:00")).toBeCloseTo(during, 5);
  });

  it("a task dropped on an hour keeps that hour open until its write is done, then the stretch folds", async () => {
    let finish = () => {};
    sendOrQueue.mockImplementation(() => new Promise((resolve) => { finish = () => resolve(undefined); }));
    mount([task("loose")], { foldEmpty: true });
    const body = screen.getByTestId("day-timeline-body");
    const dragEvent = (type: "dragOver" | "drop", clientY: number) => {
      const event = createEvent[type](body, { dataTransfer: { types: [TASK_DRAG_TYPE], getData: () => "loose" } });
      Object.defineProperty(event, "clientY", { value: clientY });
      fireEvent(body, event);
    };
    dragEvent("dragOver", at(60));
    expect(document.querySelectorAll(".day-fold").length).toBe(0);
    dragEvent("drop", at(14 * 60));
    await waitFor(() => expect(document.querySelectorAll(".day-fold").length).toBeGreaterThan(0));
    expect(hourLabels()).toContain("14:00"); // not folded away while the write is pending
    await act(async () => { finish(); });
    // This harness does not feed the new time back as an item, so once the write is done nothing holds that hour.
    await waitFor(() => expect(hourLabels()).not.toContain("14:00"));
  });
});

describe("dragging a block with the mouse", () => {
  it("shows the new time while dragging, writes nothing until it is let go, then once, with 復原", async () => {
    mount([task("busy", { time: "10:00", until: "11:00" })]);
    const el = block(/10:00–11:00/);
    pointer(el, "pointerdown", { clientY: at(10 * 60 + 10) });
    pointer(window, "pointermove", { clientY: at(11 * 60 + 40) }); // +90 min
    expect(screen.getByTestId("day-timeline").textContent).toContain("11:30–12:30");
    expect(sendOrQueue).not.toHaveBeenCalled();
    pointer(window, "pointerup", { clientY: at(11 * 60 + 40) });
    await waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(1));
    expect(bodies()[0]).toEqual({ time: "11:30", until: "12:30" });
    getAppState().toasts.find((entry) => entry.action)!.action!.onClick();
    await waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(2));
    expect(bodies()[1]).toEqual({ when_date: today, someday: null, time: "10:00", until: "11:00" });
  });

  it("a press without moving is still a click that opens it, and Escape drops the drag", () => {
    mount([task("busy", { time: "10:00", until: "11:00" })]);
    const el = block(/10:00–11:00/);
    pointer(el, "pointerdown", { clientY: at(620) });
    pointer(window, "pointermove", { clientY: at(700) });
    fireEvent.keyDown(window, { key: "Escape" });
    pointer(window, "pointerup", { clientY: at(700) });
    expect(sendOrQueue).not.toHaveBeenCalled();
    expect(screen.getByTestId("day-timeline").textContent).toContain("10:00–11:00");
  });

  it("puts the block back, and says so, when the write is refused", async () => {
    sendOrQueue.mockRejectedValue(Object.assign(new Error("no"), { status: 403 }));
    mount([task("busy", { time: "10:00", until: "11:00" })]);
    pointer(block(/10:00–11:00/), "pointerdown", { clientY: at(620) });
    pointer(window, "pointermove", { clientY: at(680) });
    pointer(window, "pointerup", { clientY: at(680) });
    await waitFor(() => expect(sendOrQueue).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("day-timeline").textContent).toContain("10:00–11:00"));
    expect(getAppState().toasts.length).toBeGreaterThan(0);
  });

  it("pulling the lower edge changes the end; a task with no end gets one", async () => {
    mount([task("busy", { time: "10:00", until: "11:00" }), task("point", { time: "14:00" })]);
    const [first, second] = screen.getAllByTestId("day-block-grip");
    pointer(first!, "pointerdown", { clientY: at(660) });
    pointer(window, "pointermove", { clientY: at(660 + 30) });
    pointer(window, "pointerup", { clientY: at(660 + 30) });
    await waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(1));
    expect(bodies()[0]).toEqual({ time: "10:00", until: "11:30" });
    pointer(second!, "pointerdown", { clientY: at(14 * 60) });
    pointer(window, "pointermove", { clientY: at(14 * 60 + 45) });
    pointer(window, "pointerup", { clientY: at(14 * 60 + 45) });
    await waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(2));
    expect(bodies()[1]).toEqual({ time: "14:00", until: "14:45" });
  });
});

describe("what cannot be dragged", () => {
  it("a done task, a task the reader may not write, and a focus record show no grip and do not move", () => {
    mount([task("finished", { status: "done", time: "09:00", until: "10:00" })]);
    expect(screen.queryByTestId("day-block-grip")).toBeNull();
    expect(block(/09:00–10:00/).className).not.toContain("is-movable");
  });
  it("a task in a space the reader cannot write", () => {
    mount([task("theirs", { time: "09:00", until: "10:00" })], { writable: false });
    expect(screen.queryByTestId("day-block-grip")).toBeNull();
    pointer(block(/09:00–10:00/), "pointerdown", { clientY: at(550) });
    pointer(window, "pointermove", { clientY: at(700) });
    pointer(window, "pointerup", { clientY: at(700) });
    expect(sendOrQueue).not.toHaveBeenCalled();
  });
});

describe("with a finger", () => {
  it("scrolling (moving before the hold) does not drag", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    mount([task("busy", { time: "10:00", until: "11:00" })]);
    pointer(block(/10:00–11:00/), "pointerdown", { clientY: at(620), pointerType: "touch" });
    pointer(window, "pointermove", { clientY: at(620) + 40, pointerType: "touch" });
    act(() => { vi.advanceTimersByTime(HOLD_MS + 50); });
    pointer(window, "pointermove", { clientY: at(900), pointerType: "touch" });
    pointer(window, "pointerup", { clientY: at(900), pointerType: "touch" });
    expect(sendOrQueue).not.toHaveBeenCalled();
    expect(screen.getByTestId("day-timeline").textContent).toContain("10:00–11:00");
  });
  it("held (HOLD_MS) then dragged moves it; held and let go in place selects it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    mount([task("busy", { time: "10:00", until: "11:00" })]);
    const el = block(/10:00–11:00/);
    pointer(el, "pointerdown", { clientY: at(620), pointerType: "touch" });
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    pointer(window, "pointermove", { clientY: at(620 + 60), pointerType: "touch" });
    pointer(window, "pointerup", { clientY: at(620 + 60), pointerType: "touch" });
    vi.useRealTimers();
    await waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(1));
    expect(bodies()[0]).toEqual({ time: "11:00", until: "12:00" });
  });
  it("held and let go in place selects the block: its grip becomes a finger-sized target", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    mount([task("busy", { time: "10:00", until: "11:00" })]);
    pointer(block(/10:00–11:00/), "pointerdown", { clientY: at(620), pointerType: "touch" });
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    pointer(window, "pointerup", { clientY: at(620), pointerType: "touch" });
    expect(screen.getByTestId("day-block-grip").className).toContain("is-selected");
    expect(sendOrQueue).not.toHaveBeenCalled();
  });
});

describe("a finger on the grip of a block that is not selected", () => {
  it("is a scroll: nothing is pulled or written", () => {
    mount([task("busy", { time: "10:00", until: "11:00" })]);
    const grip = screen.getByTestId("day-block-grip");
    expect(grip.className).not.toContain("is-selected");
    pointer(grip, "pointerdown", { clientY: at(659), pointerType: "touch" });
    pointer(window, "pointermove", { clientY: at(740), pointerType: "touch" });
    pointer(window, "pointerup", { clientY: at(740), pointerType: "touch" });
    expect(sendOrQueue).not.toHaveBeenCalled();
    expect(screen.getByTestId("day-timeline").textContent).toContain("10:00–11:00");
  });
});

describe("with the keyboard", () => {
  it("keeps the focus on the block when the saved time moves it", async () => {
    // Items follow the store, as on the page: the write changes `at`, so the block is redrawn at its new time.
    const rows = [task("busy", { time: "10:00", until: "11:00" })];
    setData((s) => ({ ...s, tasks: rows }));
    const refs = taskRefsFrom(rows, [], () => true);
    registerTaskRefs({ tasks: () => refs, subscribe: () => () => {} });
    function Live() {
      const tasks = useAppSelector((s) => s.data.tasks);
      const items = taskDayItems({ date: today, today, nodes: [], tasks, tags: [] });
      return <TimelinePlanner enabled date={today} items={items} nowMs={dayWindow(today).startMs + 3 * 3_600_000} onOpen={vi.fn()} autoScroll={false} />;
    }
    render(<Live />);
    const el = block(/10:00–11:00/);
    el.focus();
    fireEvent.keyDown(el, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(1), { timeout: KEY_COMMIT_MS + 1500 });
    await waitFor(() => expect(screen.getByRole("button", { name: /10:15–11:15/ })).toBeTruthy());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /10:15–11:15/ }));
  });
  it("Alt+↓ moves by 15 minutes, Alt+Shift+↓ lengthens by 15; one write after the last key, read aloud", async () => {
    mount([task("busy", { time: "10:00", until: "11:00" })]);
    const el = block(/10:00–11:00/);
    fireEvent.keyDown(el, { key: "ArrowDown", altKey: true });
    fireEvent.keyDown(el, { key: "ArrowDown", altKey: true });
    expect(screen.getByRole("status").textContent).toBe("Moved to 10:30–11:30");
    fireEvent.keyDown(block(/10:30–11:30/), { key: "ArrowDown", altKey: true, shiftKey: true });
    expect(screen.getByRole("status").textContent).toBe("Length is now 10:30–11:45");
    expect(sendOrQueue).not.toHaveBeenCalled();
    await waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(1), { timeout: KEY_COMMIT_MS + 1500 });
    expect(bodies()[0]).toEqual({ time: "10:30", until: "11:45" });
  });
  it("Alt+↑ at the top of the day does nothing; plain arrows are left alone", () => {
    mount([task("first", { time: "00:00", until: "00:30" })]);
    const el = block(/00:00–00:30/);
    fireEvent.keyDown(el, { key: "ArrowUp", altKey: true });
    fireEvent.keyDown(el, { key: "ArrowDown" });
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
