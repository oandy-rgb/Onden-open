// 3 天／週: a planned task's card dragged to another day's column changes only the date (time kept,
// 復原 puts it back). A done task, or one the reader may not write, is not a drag source.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

const sendOrQueue = vi.fn();
vi.mock("../lib/data/writeQueue", async (original) => ({
  ...await original<typeof import("../lib/data/writeQueue")>(),
  submitWrite: async (r: { method: string; path: string; body: string | null }) => {
    const value = await sendOrQueue(r.method, r.path, r.body);
    return value === undefined ? { status: "queued" } : { status: "synced", value };
  },
}));
vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), upsertTask: async () => {} }));

import WeekBoard from "../modules/daily/day/WeekBoard";
import { registerTaskRefs, taskRefsFrom } from "../lib/taskRefs";
import type { NodeTask } from "../lib/api";
import { getAppState, resetAppState, setData } from "../lib/appStore";
import { bindAccountStorage } from "../lib/accountStorage";
import { addDays } from "@onden/markdown";
import { todayId } from "../lib/localDate";
import { HOLD_MS } from "../lib/touchHold";

const today = todayId();
const tomorrow = addDays(today, 1);
const task = (id: string, extra: Partial<NodeTask> = {}): NodeTask => ({ id, node_id: null, title: id, status: "todo", when_date: today, due_date: today, time: "10:00", until: "11:00", ...extra });

function mount(tasks: NodeTask[], writable = true) {
  setData((s) => ({ ...s, tasks }));
  const refs = taskRefsFrom(tasks, [], () => writable);
  registerTaskRefs({ tasks: () => refs, subscribe: () => () => {} });
  render(<WeekBoard days={[today, tomorrow]} today={today} selected={today} nowMs={Date.now()} onPick={vi.fn()} onOpen={vi.fn()} />);
}
const draggable = (title: string) => screen.getByText(title, { exact: false }).closest("li")!.getAttribute("draggable");
function pointer(target: Element | Window, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: "touch" });
  Object.defineProperty(event, "isPrimary", { value: true });
  act(() => { target.dispatchEvent(event); });
}

beforeEach(() => { resetAppState(); bindAccountStorage("week-move-test", ""); sendOrQueue.mockReset().mockResolvedValue(undefined); });
afterEach(() => { registerTaskRefs(null); vi.useRealTimers(); });

describe("week board cards", () => {
  it("an open task the reader may write is a drag source; a done one, or one in a space they cannot write, is not", () => {
    mount([task("open"), task("finished", { status: "done" })]);
    expect(draggable("open")).toBe("true");
    expect(draggable("finished")).toBeNull();
  });
  it("not writable: no drag", () => {
    mount([task("theirs")], false);
    expect(draggable("theirs")).toBeNull();
  });
  it("held with a finger and let go over another day's column: only the date changes, with 復原", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    mount([task("open")]);
    const column = document.querySelector<HTMLElement>(`[data-date="${tomorrow}"]`)!;
    document.elementFromPoint = () => column;
    const card = screen.getByText("open", { exact: false }).closest("li")!;
    pointer(card, "pointerdown", 10, 10);
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    pointer(window, "pointermove", 200, 30);
    pointer(window, "pointerup", 200, 30);
    vi.useRealTimers();
    await waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(1));
    expect(JSON.parse(sendOrQueue.mock.calls[0]![2] as string)).toEqual({ when_date: tomorrow, someday: null });
    const toast = getAppState().toasts.find((entry) => entry.action)!;
    expect(toast.message).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    toast.action!.onClick();
    await waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(2));
    expect(JSON.parse(sendOrQueue.mock.calls[1]![2] as string)).toEqual({ when_date: today, someday: null });
  });
});
