// Quick-add task sheet: the reading is shown live, a chip takes a reading back,
// Enter adds and clears for the next one, a failure keeps what was typed.
// The writer behind it (createQuickTask) is the seam T1 replaces; here it is a spy.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const createQuickTask = vi.hoisted(() => vi.fn());
vi.mock("../modules/tasks/createQuickTask", () => ({ createQuickTask }));
vi.mock("../lib/localDate", async (original) => ({
  ...await original<typeof import("../lib/localDate")>(),
  nowDateTimeId: () => "2026-10-24T10:00:00", // a Saturday
  dayAndClock: () => ({ today: "2026-10-24", nowTime: "10:00" }),
}));

import { QuickAddTask, openQuickAddTask } from "../modules/tasks";
import { resetAppState, getAppState } from "../lib/appStore";

async function openSheet() {
  render(<QuickAddTask />);
  act(() => openQuickAddTask());
  return screen.findByRole("combobox", { name: "Task" });
}
const chipsOf = () => within(screen.getByRole("region", { name: "It will become" })).getAllByRole("listitem").map((li) => li.textContent);

beforeEach(() => {
  resetAppState();
  createQuickTask.mockReset().mockResolvedValue({ saved: "saved", noteTitle: "2026-10-24" });
});

describe("QuickAddTask", () => {
  it("opens focused on the box and shows only a hint until something is typed", async () => {
    const box = await openSheet();
    expect(box).toHaveFocus();
    expect(screen.queryByRole("region", { name: "It will become" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add it" })).toBeDisabled();
  });

  it("shows the title and a chip for each reading while typing", async () => {
    const box = await openSheet();
    await userEvent.type(box, "Tomorrow hand in the report #school every week");
    const region = screen.getByRole("region", { name: "It will become" });
    expect(within(region).getByText("hand in the report")).toBeInTheDocument();
    expect(chipsOf()).toEqual(["Tomorrow", "#school", "Every week"]);
  });

  it("reads a Chinese line", async () => {
    const box = await openSheet();
    await userEvent.type(box, "明天下午3點 交報告 提醒我");
    expect(within(screen.getByRole("region", { name: "It will become" })).getByText("交報告")).toBeInTheDocument();
    expect(chipsOf()).toEqual(["Tomorrow", "15:00", "Remind me"]);
  });

  it("shows the implied day when only a time is typed, and Anytime when nothing is", async () => {
    const box = await openSheet();
    await userEvent.type(box, "call mom");
    expect(chipsOf()).toEqual(["Anytime"]);
    await userEvent.type(box, " 3:30pm");
    expect(chipsOf()).toEqual(["Today 15:30"]);
  });

  it("takes a reading back: its words return to the title, and a later edit keeps that choice", async () => {
    const box = await openSheet();
    await userEvent.type(box, "Tomorrow plan");
    await userEvent.click(screen.getByRole("button", { name: "Take back “Tomorrow”" }));
    const region = screen.getByRole("region", { name: "It will become" });
    expect(within(region).getByText("Tomorrow plan")).toBeInTheDocument();
    expect(chipsOf()).toEqual(["Anytime"]);
    expect(box).toHaveFocus();
    await userEvent.type(box, " today");
    expect(chipsOf()).toEqual(["Today"]); // another word is still read
  });

  it("Enter adds the task with the parsed fields, clears the box and lists it", async () => {
    const box = await openSheet();
    await userEvent.type(box, "Tomorrow 3pm hand in the report #school{Enter}");
    await waitFor(() => expect(createQuickTask).toHaveBeenCalledTimes(1));
    expect(createQuickTask.mock.calls[0]![0]).toMatchObject({
      title: "hand in the report", when_date: "2026-10-25", time: "15:00", evening: false, someday: false,
      deadline: null, recur: null, recur_mode: "fixed", remind_at: null,
    });
    await waitFor(() => expect(box).toHaveValue(""));
    expect(box).toHaveFocus();
    const added = within(screen.getByRole("list", { name: "Just added" }));
    expect(added.getByText("hand in the report")).toBeInTheDocument();
    expect(added.getByText("Added to Up next · Tomorrow · written in 2026-10-24")).toBeInTheDocument();
    // the next line starts clean
    await userEvent.type(box, "water plants{Enter}");
    await waitFor(() => expect(createQuickTask).toHaveBeenCalledTimes(2));
    expect(within(screen.getByRole("list", { name: "Just added" })).getAllByRole("listitem")).toHaveLength(2);
  });

  it("says a queued task is only saved on this device", async () => {
    createQuickTask.mockResolvedValue({ saved: "queued", noteTitle: "2026-10-24" });
    const box = await openSheet();
    await userEvent.type(box, "buy milk{Enter}");
    expect(await screen.findByText(/Saved on this device — it will sync when the server is reachable/)).toBeInTheDocument();
    expect(screen.queryByText(/^Added to/)).toBeNull();
  });

  it("keeps the typed line when saving fails", async () => {
    createQuickTask.mockRejectedValue(new Error("boom"));
    const box = await openSheet();
    await userEvent.type(box, "Tomorrow buy milk");
    await userEvent.click(screen.getByRole("button", { name: "Add it" }));
    await waitFor(() => expect(getAppState().toasts.length).toBeGreaterThan(0));
    expect(box).toHaveValue("Tomorrow buy milk");
    expect(screen.queryByRole("list", { name: "Just added" })).toBeNull();
    expect(box).toHaveFocus();
  });

  it("does not add a line that is only a date, and does not send twice while one is in flight", async () => {
    let finish!: (v: { saved: "saved"; noteTitle: string }) => void;
    createQuickTask.mockReturnValue(new Promise<{ saved: "saved"; noteTitle: string }>((resolve) => { finish = resolve; }));
    const box = await openSheet();
    await userEvent.type(box, "Tomorrow{Enter}");
    expect(createQuickTask).not.toHaveBeenCalled();
    await userEvent.clear(box);
    await userEvent.type(box, "pay rent{Enter}{Enter}");
    expect(createQuickTask).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ saved: "saved", noteTitle: "2026-10-24" }); });
    await waitFor(() => expect(box).toHaveValue(""));
  });

  it("keeps what was typed while the request was running", async () => {
    let finish!: (v: { saved: "saved"; noteTitle: string }) => void;
    createQuickTask.mockReturnValue(new Promise<{ saved: "saved"; noteTitle: string }>((resolve) => { finish = resolve; }));
    const box = await openSheet();
    await userEvent.type(box, "first{Enter}");
    await userEvent.type(box, " more");
    await act(async () => { finish({ saved: "saved", noteTitle: "2026-10-24" }); });
    await waitFor(() => expect(screen.getByRole("list", { name: "Just added" })).toBeInTheDocument());
    expect(box).toHaveValue("first more"); // edited since Enter: not cleared
  });

  it("sends a reminder instant only when asked to remind", async () => {
    const box = await openSheet();
    await userEvent.type(box, "Tomorrow 9am stand-up remind me{Enter}");
    await waitFor(() => expect(createQuickTask).toHaveBeenCalled());
    const { remind_at } = createQuickTask.mock.calls[0]![0] as { remind_at: string };
    expect(new Date(remind_at).getTime()).toBe(new Date(2026, 9, 25, 9, 0).getTime());
  });

  it("with a day given (the 今天 page), words that say 某天 or 隨時 are kept; no such words start on that day", async () => {
    render(<QuickAddTask />);
    const add = async (text: string) => {
      act(() => openQuickAddTask(undefined, { day: "2026-11-20" }));
      const box = await screen.findByRole("combobox", { name: "Task" });
      await userEvent.type(box, `${text}{Enter}`);
      await waitFor(() => expect(createQuickTask).toHaveBeenCalled());
      const call = createQuickTask.mock.calls.at(-1)![0];
      createQuickTask.mockClear();
      await userEvent.click(screen.getAllByRole("button", { name: /Close|Cancel/ }).at(-1)!).catch(() => {});
      return call;
    };
    expect(await add("tidy the shelf")).toMatchObject({ when_date: "2026-11-20" });
    expect(await add("someday tidy the shelf")).toMatchObject({ someday: true });
    expect((await add("anytime tidy the shelf")).when_date ?? null).toBeNull();
  });
});
